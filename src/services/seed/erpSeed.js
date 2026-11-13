/**
 * Data v11 — advanced ERP layer. Pure builders (no storage access) shared by the first-run seed, MIGRATIONS[10] and
 * the self-healing start-up (a missing v11 key is rebuilt from the live data so every reference is real).
 *
 *  enrichMasterData(snap)  adds the new master-data fields WITHOUT touching anything a user set:
 *    products  base / sales / purchase / inventory / dispatch / delivery units with conversion factors, weight, volume,
 *              barcode type, expiry tracking, shelf life, minimum remaining shelf life, batch tracking, perishable, subcategory
 *    customers map coordinates (approximate until verified), secondary salesman, team, sales manager, assignment history
 *    sales reps  employment status (availability is derived from HR leave + status)
 *    hubs      coordinates;  drivers offline periods + availability history;  vehicles max weight / volume / stops
 *  buildErpData(snap)      the new collections: vendors (from the supplier directory, same ids), batch allocations
 *    (derived from lot consumption), recurring orders (from the HORECA standing orders), chat channels, settings.
 * Every function is idempotent: running it on its own output changes nothing.
 */
import dayjs from 'dayjs'
import { STORAGE_KEYS as K } from '../../utils/constants'
import { parsePackSize } from '../../utils/units'
import { approximateCoords, hubCoords } from '../../utils/geo'
import { deriveAllocations, sourceBatchSnapshot } from '../../utils/batchAllocation'

const arr = (v) => (Array.isArray(v) ? v : [])
const has = (o, k) => o && o[k] !== undefined

export const DEFAULT_ERP_SETTINGS = {
  version: 1,
  complaints: { windowDays: 7, requirePhotosFor: ['Damaged', 'Quality'] },
  vendorQuality: { threshold: 3, windowDays: 30, notifySalesManager: true, autoWatch: true },
  recurring: { horizonDays: 2, autoGenerate: true },
  expiry: { scanIntervalMinutes: 30, autoScrapRequest: true, nearExpiryDays: 7 },
  fefo: { allowOverride: true },
  deliverySlots: [
    { id: 'slot-am', label: 'Morning', from: '06:00', to: '10:00' },
    { id: 'slot-mid', label: 'Midday', from: '10:00', to: '14:00' },
    { id: 'slot-pm', label: 'Afternoon', from: '14:00', to: '18:00' },
    { id: 'slot-eve', label: 'Evening', from: '18:00', to: '21:00' },
  ],
  kpiFormat: 'compact',
  orderRules: { duplicateWindowHours: 24 },
}

const SUBCATEGORY = { PLT: 'Poultry', PTO: 'Potato', VEG: 'Vegetables', DRY: 'Dairy', SNK: 'Snacks', SEA: 'Seafood', MT: 'Meat', MEA: 'Meat', BAK: 'Bakery', DES: 'Desserts', BEV: 'Beverages', PKG: 'Packaging', CON: 'Consumables' }
const DEFAULT_WEIGHT = { PCS: 0.5, PACK: 0.4, BOX: 0.3, SET: 8, LTR: 1, KG: 1, MTR: 0.2, UNIT: 0.5 }

export const enrichProduct = (p) => {
  const out = { ...p }
  const base = p.baseUnit || p.unit
  if (!has(p, 'baseUnit')) out.baseUnit = base
  const pack = parsePackSize(p.packSize)
  if (!has(p, 'weightKg')) out.weightKg = base === 'KG' ? 1 : pack?.weightKg || DEFAULT_WEIGHT[base] || 1
  if (!has(p, 'volumeM3')) out.volumeM3 = Math.round(Math.max(0.002, (out.weightKg || 1) * 0.0032) * 10000) / 10000
  if (!has(p, 'units')) {
    const units = []
    if (base !== 'KG' && out.weightKg > 0 && pack) units.push({ code: 'KG', label: 'Kilograms', factor: Math.round((1 / out.weightKg) * 1e6) / 1e6 })
    if (pack?.inner?.count > 1) units.push({ code: 'PACK', label: `Pack (${pack.inner.size} ${pack.inner.unit})`, factor: Math.round((1 / pack.inner.count) * 1e6) / 1e6 })
    if (base === 'KG') units.push({ code: 'BOX', label: 'Box (10 kg)', factor: 10 }, { code: 'G', label: 'Grams', factor: 0.001 })
    out.units = units.filter((u) => u.code !== base)
  }
  ;['salesUnit', 'purchaseUnit', 'inventoryUnit', 'dispatchUnit', 'deliveryUnit'].forEach((k) => { if (!has(p, k)) out[k] = base })
  if (!has(p, 'secondaryUnit')) out.secondaryUnit = out.units[0]?.code || ''
  if (!has(p, 'barcodeType')) out.barcodeType = /^\d{13}$/.test(String(p.barcode || '')) ? 'EAN-13' : /^\d{12}$/.test(String(p.barcode || '')) ? 'UPC-A' : 'CODE-128'
  const cold = ['Frozen', 'Chilled'].includes(p.storageCondition)
  if (!has(p, 'perishable')) out.perishable = cold
  if (!has(p, 'trackExpiry')) out.trackExpiry = cold
  if (!has(p, 'batchTracking')) out.batchTracking = cold
  if (!has(p, 'shelfLifeDays')) out.shelfLifeDays = p.storageCondition === 'Frozen' ? 365 : p.storageCondition === 'Chilled' ? 45 : null
  if (!has(p, 'minRemainingShelfLifeDays')) out.minRemainingShelfLifeDays = p.storageCondition === 'Frozen' ? 30 : p.storageCondition === 'Chilled' ? 5 : 0
  if (!has(p, 'subcategory')) out.subcategory = SUBCATEGORY[String(p.sku || '').split('-')[1]] || ''
  if (!has(p, 'minOrderQty')) out.minOrderQty = 1
  return out
}

const salesPool = (snap) => {
  const reps = arr(snap[K.DEMO_DATA]?.salesReps)
  const users = arr(snap[K.DEMO_USERS]).filter((u) => ['SALESMAN', 'HORECA_SALES_EXEC', 'VAN_SALES_EXEC'].includes(u.role))
  return [...reps.map((r) => r.id), ...users.map((u) => u.id).filter((id) => !reps.some((r) => r.id === id))]
}

export const enrichMasterData = (snap) => {
  const next = { ...snap }
  if (Array.isArray(snap[K.PRODUCTS])) next[K.PRODUCTS] = snap[K.PRODUCTS].map(enrichProduct)
  if (Array.isArray(snap[K.HUBS])) next[K.HUBS] = snap[K.HUBS].map((h) => {
    if (has(h, 'latitude')) return h
    const c = hubCoords(h)
    return { ...h, latitude: c ? c[0] : null, longitude: c ? c[1] : null }
  })
  const pool = salesPool(snap)
  const manager = arr(snap[K.DEMO_USERS]).find((u) => u.role === 'SALES_MANAGER')?.id || null
  if (Array.isArray(snap[K.CUSTOMERS])) next[K.CUSTOMERS] = snap[K.CUSTOMERS].map((c) => {
    const out = { ...c }
    if (!has(c, 'latitude')) {
      const a = approximateCoords(c.id, c.city)
      out.latitude = a ? a[0] : null
      out.longitude = a ? a[1] : null
      out.locationVerified = false
      out.locationSource = a ? 'Approximate (city)' : 'Not set'
    }
    if (!has(c, 'secondarySalesRepId')) out.secondarySalesRepId = pool.find((id) => id !== c.salesRepId) || null
    if (!has(c, 'salesTeam')) out.salesTeam = 'South Sales'
    if (!has(c, 'salesManagerId')) out.salesManagerId = manager
    if (!has(c, 'assignmentHistory')) out.assignmentHistory = []
    if (!has(c, 'deliverySlotId')) out.deliverySlotId = ''
    return out
  })
  if (snap[K.DEMO_DATA] && Array.isArray(snap[K.DEMO_DATA].salesReps)) {
    next[K.DEMO_DATA] = { ...snap[K.DEMO_DATA], salesReps: snap[K.DEMO_DATA].salesReps.map((r) => (has(r, 'status') ? r : { ...r, status: 'Active', team: 'South Sales', managerId: manager })) }
  }
  if (Array.isArray(snap[K.DRIVERS])) next[K.DRIVERS] = snap[K.DRIVERS].map((d) => {
    if (has(d, 'offlinePeriods')) return d
    const offline = d.availability === 'Offline'
      ? [{ id: `off-${d.id}-1`, from: dayjs().startOf('day').toISOString(), to: dayjs().add(2, 'day').endOf('day').toISOString(), reason: 'Medical leave', remarks: 'Recorded when availability moved to periods (data v11).', createdAt: new Date().toISOString(), createdByName: 'System (migration)' }]
      : []
    return { ...d, offlinePeriods: offline, suspended: false, availabilityHistory: [] }
  })
  if (Array.isArray(snap[K.VEHICLES])) next[K.VEHICLES] = snap[K.VEHICLES].map((v) => {
    if (has(v, 'maxWeightKg')) return v
    const t = String(v.notes || '').match(/(\d+(?:\.\d+)?)\s*T\b/)
    const byType = { Truck: 3000, 'Mini Truck': 1500, Van: 800, Bike: 60 }
    const maxWeightKg = t ? Number(t[1]) * 1000 : byType[v.type] || 1000
    const maxStops = { Truck: 12, 'Mini Truck': 10, Van: 8, Bike: 4 }[v.type] || 10
    return { ...v, maxWeightKg, maxVolumeM3: Math.round((maxWeightKg / 250) * 10) / 10, maxStops, replacementHistory: [] }
  })
  return next
}

const VENDOR_FIELDS = (s, i, products) => ({
  id: s.id,
  code: s.code || `VEN-${String(i + 1).padStart(3, '0')}`,
  name: s.name,
  gstNumber: s.gstNumber || '',
  panNumber: s.panNumber || '',
  contactPerson: s.contactPerson || '',
  mobile: s.mobile || s.contactPhone || '',
  email: s.email || s.contactEmail || '',
  address: s.address || '',
  city: s.city || '',
  country: s.country || 'India',
  categories: arr(s.categories),
  productsSupplied: arr(s.productsSupplied).length ? s.productsSupplied : products.filter((p) => arr(s.categories).includes(p.category)).map((p) => p.id),
  paymentTerms: s.paymentTerms || 'Net 30',
  leadTimeDays: Number(s.leadTimeDays) || 7,
  minOrderValue: Number(s.minOrderValue) || 0,
  bank: s.bank || { accountName: '', accountNumber: '', bankName: '', ifsc: '' },
  status: s.status || 'Active',
  statusReason: '',
  history: [],
  createdAt: s.createdAt || new Date().toISOString(),
  updatedAt: new Date().toISOString(),
})

/** Department chat channels (members by role) and a pinned welcome note per channel. */
const CHANNELS = [
  ['chn-announce', 'Company announcements', 'announcement', null, 'Admin posts; everyone reads.'],
  ['chn-sales', 'Sales team', 'sales', ['SALESMAN', 'SALES_MANAGER', 'HORECA_SALES_EXEC', 'VAN_SALES_EXEC', 'CUSTOMER_SERVICE', 'ADMIN', 'SUPER_ADMIN', 'CEO']],
  ['chn-ops', 'Operations', 'operations', ['OPERATIONS_DIRECTOR', 'DISPATCHER', 'WAREHOUSE_MANAGER', 'INVENTORY_EXECUTIVE', 'FLEET_MANAGER', 'ADMIN', 'SUPER_ADMIN', 'CEO']],
  ['chn-warehouse', 'Warehouse floor', 'warehouse', ['WAREHOUSE_MANAGER', 'WAREHOUSE_EXEC', 'INVENTORY_EXECUTIVE', 'QA_MANAGER', 'QA_INSPECTOR', 'ADMIN', 'SUPER_ADMIN']],
  ['chn-dispatch', 'Dispatch desk', 'dispatch', ['DISPATCHER', 'DRIVER', 'FLEET_MANAGER', 'WAREHOUSE_MANAGER', 'ADMIN', 'SUPER_ADMIN']],
  ['chn-support', 'Customer support', 'support', ['CUSTOMER_SERVICE', 'SALES_MANAGER', 'QA_MANAGER', 'ADMIN', 'SUPER_ADMIN']],
]

export const buildErpData = (snap, now = dayjs()) => {
  const products = arr(snap[K.PRODUCTS])
  const suppliers = arr(snap[K.FORECAST_SETTINGS]?.suppliers)
  const users = arr(snap[K.DEMO_USERS]).filter((u) => !['CUSTOMER', 'SUPPLIER'].includes(u.role))
  const iso = now.toISOString()
  const vendors = suppliers.map((s, i) => VENDOR_FIELDS(s, i, products))
  const allocations = deriveAllocations({ batches: arr(snap[K.BATCHES]), orders: arr(snap[K.ORDERS]), goodsReceipts: arr(snap[K.GOODS_RECEIPTS]), purchaseOrders: arr(snap[K.PURCHASE_ORDERS]) })
  const customers = Object.fromEntries(arr(snap[K.CUSTOMERS]).map((c) => [c.id, c]))
  const recurring = arr(snap[K.ORDER_TEMPLATES]).map((t, i) => {
    const c = customers[t.customerId] || {}
    const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].indexOf(t.deliveryDay)
    return {
      id: `rec-${t.id}`,
      number: `REC-${now.format('YYYY')}-${String(i + 1).padStart(4, '0')}`,
      name: t.name || `Standing order ${i + 1}`,
      customerId: t.customerId,
      hubId: c.hubId || null,
      salesmanId: c.salesRepId || null,
      deliveryAddress: [c.addressLine1, c.addressLine2].filter(Boolean).join(', '),
      frequency: t.frequency === 'Daily' ? 'DAILY' : t.frequency === 'Monthly' ? 'MONTHLY' : 'WEEKLY',
      weekdays: weekday >= 0 ? [weekday] : [1],
      intervalDays: 7,
      monthDay: 1,
      startDate: now.format('YYYY-MM-DD'),
      endDate: now.add(6, 'month').format('YYYY-MM-DD'),
      slots: [{ id: 'sl-1', slotId: 'slot-am', time: '08:00', lines: arr(t.lines).map((l, j) => ({ id: `rl-${j + 1}`, productId: l.productId, quantity: Number(l.quantity) || 1, unit: products.find((p) => p.id === l.productId)?.unit || 'CTN' })) }],
      status: t.status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED',
      sourceTemplateId: t.id,
      generated: [],
      history: [{ at: iso, byName: 'System (migration)', action: 'Created from standing order', note: t.name || '' }],
      createdAt: iso, createdBy: 'system', updatedAt: iso,
    }
  })
  const channels = CHANNELS.map(([id, name, type, roles, description]) => ({
    id, name, type, description: description || `${name} channel`,
    members: roles ? users.filter((u) => roles.includes(u.role)).map((u) => u.id) : users.map((u) => u.id),
    admins: users.filter((u) => ['ADMIN', 'SUPER_ADMIN'].includes(u.role)).map((u) => u.id),
    postingRoles: type === 'announcement' ? ['ADMIN', 'SUPER_ADMIN', 'CEO'] : null,
    createdAt: iso, createdBy: 'system', lastMessageAt: iso, archived: false,
  }))
  const messages = channels.map((c) => ({
    id: `msg-welcome-${c.id}`, channelId: c.id, senderId: 'system', senderName: 'Bellomassi', body: c.type === 'announcement'
      ? 'Welcome to Bellomassi chat. Messages are kept in this browser (prototype) and appear instantly for other signed-in tabs.'
      : `This is the ${c.name} channel. Share orders, invoices, dispatches or batches with the 📎 Share button.`,
    attachments: [], share: null, replyTo: null, pinned: true, editedAt: null, deleted: false, readBy: [], createdAt: iso,
  }))
  return {
    [K.VENDORS]: vendors,
    [K.BATCH_ALLOCATIONS]: allocations,
    [K.RECURRING_ORDERS]: recurring,
    [K.COMPLAINTS]: [],
    [K.PURCHASE_RETURNS]: [],
    [K.VENDOR_QUALITY_ALERTS]: [],
    [K.CHAT_CHANNELS]: channels,
    [K.CHAT_MESSAGES]: messages,
    [K.USER_PREFS]: {},
    [K.ERP_SETTINGS]: DEFAULT_ERP_SETTINGS,
  }
}

/** Issued invoices get their immutable source-batch snapshot once (never recomputed afterwards). */
export const withInvoiceSourceBatches = (snap, allocations) => {
  if (!Array.isArray(snap[K.INVOICES])) return snap
  let changed = false
  const invoices = snap[K.INVOICES].map((inv) => {
    if (has(inv, 'sourceBatches') || !inv.orderId || ['DRAFT', 'CANCELLED'].includes(inv.status)) return inv
    changed = true
    return { ...inv, sourceBatches: sourceBatchSnapshot(allocations, inv.orderId) }
  })
  return changed ? { ...snap, [K.INVOICES]: invoices } : snap
}
