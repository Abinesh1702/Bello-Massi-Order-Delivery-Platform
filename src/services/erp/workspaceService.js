/**
 * Worker productivity (data v11): per-user preferences (favourite pages / products / customers, recent records,
 * KPI display format) in bellomassi_user_prefs, smart search across business records, quick actions and the
 * exception dashboard. Every list is filtered by the user's own permissions and data scope.
 */
import dayjs from 'dayjs'
import storage from '../storageService'
import { STORAGE_KEYS as K } from '../../utils/constants'
import { can } from '../../config/permissions'
import { getCurrentUser } from '../authService'
import { getVisibleOrders } from '../orderService'
import { invoiceBalances } from '../enterprise/financeService'
import { isExpired } from '../enterprise/batchService'
import { assignmentExceptions } from './salesAssignmentService'

const read = (k, f = []) => storage.getItem(k, f) ?? f

/* ---------- Preferences ---------- */
const EMPTY = { favourites: [], favouriteProducts: [], favouriteCustomers: [], recent: [], kpiFormat: null }
export const getPrefs = (user = getCurrentUser()) => ({ ...EMPTY, ...((read(K.USER_PREFS, {}) || {})[user?.id] || {}) })
const savePrefs = (patch, user = getCurrentUser()) => {
  if (!user) return
  const all = read(K.USER_PREFS, {}) || {}
  storage.setItem(K.USER_PREFS, { ...all, [user.id]: { ...EMPTY, ...(all[user.id] || {}), ...patch } })
}
export const toggleFavourite = (kind, id) => {
  const p = getPrefs()
  const key = { page: 'favourites', product: 'favouriteProducts', customer: 'favouriteCustomers' }[kind]
  const list = p[key] || []
  savePrefs({ [key]: list.includes(id) ? list.filter((x) => x !== id) : [id, ...list].slice(0, 30) })
}
export const isFavourite = (kind, id, prefs = getPrefs()) => (prefs[{ page: 'favourites', product: 'favouriteProducts', customer: 'favouriteCustomers' }[kind]] || []).includes(id)
export const trackRecent = (entry) => {
  const user = getCurrentUser()
  if (!user || !entry?.path) return
  const p = getPrefs(user)
  if (p.recent[0]?.path === entry.path) return
  savePrefs({ recent: [{ ...entry, at: new Date().toISOString() }, ...p.recent.filter((r) => r.path !== entry.path)].slice(0, 20) }, user)
}
export const setKpiFormat = (format) => savePrefs({ kpiFormat: format })

/* ---------- Smart search ---------- */
const hit = (type, label, sub, path, score = 1) => ({ type, label, sub, path, score })
export const smartSearch = (q, user = getCurrentUser()) => {
  const s = String(q || '').trim().toLowerCase()
  if (s.length < 2 || !user) return []
  const has = (...xs) => xs.some((x) => String(x || '').toLowerCase().includes(s))
  const exact = (...xs) => xs.some((x) => String(x || '').toLowerCase() === s)
  const out = []
  if (can(user, 'customers.view')) read(K.CUSTOMERS).filter((c) => has(c.name, c.code, c.mobile, c.city, c.gstNumber)).slice(0, 6).forEach((c) => out.push(hit('Customer', c.name, `${c.code} · ${c.city}`, `/customers/${c.id}`, exact(c.code) ? 3 : 1)))
  if (can(user, 'orders.view') || can(user, 'orders.mine')) getVisibleOrders(user).filter((o) => has(o.orderNumber, o.customerName, o.customerReference)).slice(0, 6).forEach((o) => out.push(hit('Order', o.orderNumber || 'Draft', `${o.customerName} · ${o.orderStatus}`, `/orders/${o.id}`, exact(o.orderNumber) ? 3 : 1)))
  if (can(user, 'products.view')) read(K.PRODUCTS).filter((p) => has(p.name, p.code, p.sku, p.barcode)).slice(0, 6).forEach((p) => out.push(hit('Product', p.name, `${p.sku} · ${p.barcode || 'no barcode'}`, `/products/${p.id}`, exact(p.barcode) || exact(p.sku) ? 3 : 1)))
  if (can(user, 'inventory.batch.view')) read(K.BATCHES).filter((b) => has(b.batchNumber, b.supplierBatch)).slice(0, 5).forEach((b) => out.push(hit('Batch', b.batchNumber, `${read(K.PRODUCTS).find((p) => p.id === b.productId)?.name || ''} · ${b.quantity} on hand`, `/inventory/batches?q=${encodeURIComponent(b.batchNumber)}`, exact(b.batchNumber) ? 3 : 1)))
  if (can(user, 'invoices.view')) read(K.INVOICES).filter((i) => has(i.invoiceNumber, i.orderNumber)).slice(0, 5).forEach((i) => out.push(hit('Invoice', i.invoiceNumber, `${i.orderNumber} · ${i.status}`, `/invoices/${i.id}`, exact(i.invoiceNumber) ? 3 : 1)))
  if (can(user, 'suppliers.view')) read(K.VENDORS).filter((v) => has(v.name, v.code, v.gstNumber)).slice(0, 5).forEach((v) => out.push(hit('Vendor', v.name, `${v.code} · ${v.status}`, `/vendors/${v.id}`, exact(v.code) ? 3 : 1)))
  if (can(user, 'dispatch.view')) read(K.DISPATCHES).filter((d) => has(d.dispatchNumber, d.driverName, d.vehicleNumber)).slice(0, 5).forEach((d) => out.push(hit('Dispatch', d.dispatchNumber, `${d.driverName || 'Unassigned'} · ${d.status}`, `/dispatch/${d.id}`, exact(d.dispatchNumber) ? 3 : 1)))
  if (can(user, 'dispatch.view') || can(user, 'fleet.view')) read(K.DRIVERS).filter((d) => has(d.name, d.code, d.phone)).slice(0, 4).forEach((d) => out.push(hit('Driver', d.name, `${d.code || ''} · ${d.availability}`, `/dispatch/drivers/${d.id}`)))
  if (can(user, 'complaints.view')) read(K.COMPLAINTS).filter((c) => has(c.number, c.customerName, c.orderNumber)).slice(0, 4).forEach((c) => out.push(hit('Complaint', c.number, `${c.customerName} · ${c.type}`, `/complaints/${c.id}`)))
  if (can(user, 'procurement.po.view')) read(K.PURCHASE_ORDERS).filter((p) => has(p.number, p.supplierRef)).slice(0, 4).forEach((p) => out.push(hit('Purchase order', p.number, p.status, `/purchase/orders/${p.id}`, exact(p.number) ? 3 : 1)))
  return out.sort((a, b) => b.score - a.score).slice(0, 30)
}

/** Product found by an exact barcode / SKU / code (scanner input). */
export const findByBarcode = (code) => {
  const s = String(code || '').trim().toLowerCase()
  if (!s) return null
  return read(K.PRODUCTS).find((p) => [p.barcode, p.sku, p.code].some((x) => String(x || '').toLowerCase() === s)) || null
}

/* ---------- Quick actions ---------- */
export const QUICK_ACTIONS = [
  { id: 'qa-order', label: 'New order', path: '/orders/workspace', permission: 'orders.create', icon: 'FilePlus2' },
  { id: 'qa-receipt', label: 'Stock receipt', path: '/inventory/stock-receipts/create', permission: 'inventory.receipts.manage', icon: 'PackagePlus' },
  { id: 'qa-dispatch', label: 'Plan dispatch', path: '/dispatch/planning', permission: 'dispatch.manage', icon: 'Truck' },
  { id: 'qa-adjust', label: 'Stock adjustment', path: '/inventory/stock-adjustments/create', permission: 'inventory.adjustments.manage', icon: 'SlidersHorizontal' },
  { id: 'qa-complaint', label: 'Raise complaint', path: '/complaints/create', permission: 'complaints.create', icon: 'MessageSquareWarning' },
  { id: 'qa-customer', label: 'New customer', path: '/customers/create', permission: 'customers.manage', icon: 'UserPlus' },
  { id: 'qa-recurring', label: 'Recurring order', path: '/orders/recurring/create', permission: 'recurring.manage', icon: 'Repeat' },
  { id: 'qa-opening', label: 'Opening stock', path: '/inventory/new-stock', permission: 'inventory.openingstock', icon: 'Boxes' },
]
export const quickActionsFor = (user = getCurrentUser()) => QUICK_ACTIONS.filter((a) => can(user, a.permission))

/* ---------- Exceptions ---------- */
/**
 * Exception dashboard: failed deliveries, insufficient stock, expired stock, unassigned orders, unavailable drivers
 * and vehicles, late deliveries, open complaints, overdue POs, overdue payments, customers without an available
 * salesman. Each row: { kind, severity, title, detail, path }. Filtered by permission.
 */
export const exceptionList = (user = getCurrentUser(), now = dayjs()) => {
  const out = []
  const add = (kind, severity, title, detail, path) => out.push({ id: `${kind}-${out.length}`, kind, severity, title, detail, path })
  const today = now.format('YYYY-MM-DD')
  if (can(user, 'dispatch.view') || can(user, 'deliveries.view')) {
    read(K.DELIVERIES).filter((d) => d.status === 'FAILED' && !d.returnedToHub).forEach((d) => add('Failed delivery', 'high', `${d.orderNumber} failed`, `${d.customerName} · ${d.failureReason || 'no reason'}`, `/dispatch/deliveries/${d.id}`))
    const D = Object.fromEntries(read(K.DISPATCHES).map((d) => [d.id, d]))
    read(K.DELIVERIES).filter((d) => ['DISPATCHED', 'OUT_FOR_DELIVERY'].includes(d.status) && D[d.dispatchId]?.dispatchDate && D[d.dispatchId].dispatchDate < today).forEach((d) => add('Late delivery', 'high', `${d.orderNumber} is late`, `Planned ${dayjs(D[d.dispatchId].dispatchDate).format('DD MMM')} · ${d.customerName}`, `/dispatch/deliveries/${d.id}`))
    read(K.ORDERS).filter((o) => o.orderStatus === 'READY_FOR_DISPATCH' && !o.dispatchId).forEach((o) => add('Unassigned order', 'medium', `${o.orderNumber} has no dispatch`, `${o.customerName} · deliver ${dayjs(o.requestedDeliveryDate).format('DD MMM')}`, `/dispatch/ready-orders`))
    read(K.DRIVERS).filter((d) => d.status === 'Active' && (d.suspended || ['Offline', 'On Leave'].includes(d.availability))).forEach((d) => {
      const planned = read(K.DISPATCHES).find((x) => x.driverId === d.id && ['ASSIGNED', 'PLANNED'].includes(x.status) && x.dispatchDate >= today)
      if (planned) add('Driver unavailable', 'high', `${d.name} is ${d.suspended ? 'suspended' : d.availability.toLowerCase()}`, `Assigned to ${planned.dispatchNumber}`, `/dispatch/${planned.id}`)
    })
    read(K.VEHICLES).filter((v) => ['Maintenance', 'Suspended', 'Inactive'].includes(v.status)).forEach((v) => {
      const planned = read(K.DISPATCHES).find((x) => x.vehicleId === v.id && ['ASSIGNED', 'PLANNED', 'CONFIRMED'].includes(x.status))
      if (planned) add('Vehicle unavailable', 'high', `${v.vehicleNumber} is ${v.status.toLowerCase()}`, `Planned on ${planned.dispatchNumber} — replace the vehicle`, `/dispatch/${planned.id}`)
    })
  }
  if (can(user, 'inventory.stock.view') || can(user, 'inventory.batch.view')) {
    read(K.ORDERS).filter((o) => o.stockWarning && ['SUBMITTED', 'APPROVED'].includes(o.orderStatus)).forEach((o) => add('Insufficient stock', 'medium', `${o.orderNumber} is short of stock`, o.customerName, `/orders/${o.id}`))
    const expired = read(K.BATCHES).filter((b) => b.quantity > 0 && isExpired(b, now))
    if (expired.length) add('Expired stock', 'high', `${expired.length} expired batch${expired.length === 1 ? '' : 'es'} on hand`, expired.slice(0, 3).map((b) => b.batchNumber).join(', '), '/inventory/expiry')
  }
  if (can(user, 'complaints.view')) read(K.COMPLAINTS).filter((c) => ['OPEN', 'UNDER_INVESTIGATION'].includes(c.status)).forEach((c) => add('Customer complaint', c.status === 'OPEN' ? 'medium' : 'low', `${c.number} · ${c.type}`, `${c.customerName} · ${c.productName}`, `/complaints/${c.id}`))
  if (can(user, 'procurement.po.view')) read(K.PURCHASE_ORDERS).filter((p) => ['APPROVED', 'SENT', 'CONFIRMED', 'PARTIALLY_RECEIVED'].includes(p.status) && p.expectedDate && p.expectedDate < today).forEach((p) => add('PO overdue', 'medium', `${p.number} is overdue`, `Expected ${dayjs(p.expectedDate).format('DD MMM')} · ${read(K.VENDORS).find((v) => v.id === p.supplierId)?.name || ''}`, `/purchase/orders/${p.id}`))
  if (can(user, 'finance.ar.view') || can(user, 'invoices.view')) invoiceBalances().filter((i) => i.balance > 0 && i.overdueDays > 0).sort((a, b) => b.overdueDays - a.overdueDays).slice(0, 15).forEach((i) => add('Payment overdue', i.overdueDays > 30 ? 'high' : 'medium', `${i.invoiceNumber || i.number || i.id} overdue ${i.overdueDays} d`, `${read(K.CUSTOMERS).find((c) => c.id === i.customerId)?.name || ''} · balance ${Math.round(i.balance).toLocaleString('en-IN')}`, `/invoices/${i.id}`))
  if (can(user, 'customers.assignment.manage')) assignmentExceptions(now).filter((x) => x.eff.role === 'manager').forEach((x) => add('No salesman', 'medium', `${x.customer.name} has no available salesman`, x.eff.reason, '/sales/assignments'))
  const rank = { high: 0, medium: 1, low: 2 }
  return out.sort((a, b) => rank[a.severity] - rank[b.severity])
}
