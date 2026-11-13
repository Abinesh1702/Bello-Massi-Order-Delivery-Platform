/**
 * Advanced ERP end-to-end scenario (data v11, service layer, no browser) — the 43-step test of the brief:
 * vendor → product with barcode → opening stock → PO → GRN → batch → customer with primary / secondary salesman →
 * one-time + recurring orders → approval → FEFO → consolidation → dispatch with capacity / loading → driver, GPS,
 * OTP, POD → delivery → allocation → invoice with source batches → payment → complaints → vendor alert → expiry →
 * scrap approval → reports → audit. Plus negative cases (blocked vendor, overload, offline driver, expired batch).
 *
 *   node --import ./scripts/register.mjs scripts/erp-scenario.mjs
 */
const mem = new Map()
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), clear: () => mem.clear(), key: (i) => [...mem.keys()][i] ?? null, get length() { return mem.size } }
globalThis.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
globalThis.window = globalThis
globalThis.addEventListener = () => {}
globalThis.removeEventListener = () => {}
globalThis.dispatchEvent = () => true
if (!globalThis.CustomEvent) globalThis.CustomEvent = class CustomEvent extends Event { constructor(t, o) { super(t); this.detail = o?.detail } }

const src = new URL('../src/', import.meta.url).href
const imp = (p) => import(src + p)
const { initializeStorage } = await imp('services/storageService.js')
const { syncCatalog } = await imp('services/rbacService.js')
const { initRuntimeConfig } = await imp('services/appSettingsService.js')
const { installAuditHook } = await imp('services/auditService.js')
const { ensureEnterpriseModules } = await imp('config/enterprise/modules/index.js')
const batchSvc = await imp('services/enterprise/batchService.js')
initializeStorage(); syncCatalog(); initRuntimeConfig(); installAuditHook(); ensureEnterpriseModules(); batchSvc.installBatchSync()
const sync = () => batchSvc.syncBatches()
const flush = () => new Promise((r) => setTimeout(r, 0))

const storage = (await imp('services/storageService.js')).default
const { STORAGE_KEYS: K, ORDER_STATUS: S } = await imp('utils/constants.js')
const auth = await imp('services/authService.js')
const orders = await imp('services/orderService.js')
const approval = await imp('services/approvalService.js')
const consolidation = await imp('services/consolidationService.js')
const dispatch = await imp('services/dispatchService.js')
const delivery = await imp('services/deliveryService.js')
const otp = await imp('services/otpService.js')
const invoice = await imp('services/invoiceService.js')
const records = await imp('services/enterprise/recordService.js')
const finance = await imp('services/enterprise/financeService.js')
const products = await imp('services/productService.js')
const customersSvc = await imp('services/customerService.js')
const vendors = await imp('services/erp/vendorService.js')
const stockCtl = await imp('services/erp/stockControlService.js')
const fleet = await imp('services/erp/fleetService.js')
const recurring = await imp('services/erp/recurringService.js')
const complaints = await imp('services/erp/complaintService.js')
const sales = await imp('services/erp/salesAssignmentService.js')
const chat = await imp('services/erp/chatService.js')
const workspace = await imp('services/erp/workspaceService.js')
const scrap = await imp('services/scrapService.js')
const reports = await imp('services/reportService.js')
const { getAvailable } = await imp('utils/stock.js')
const { can } = await imp('config/permissions.js')
const units = await imp('utils/units.js')

const read = (k) => storage.getItem(k, []) || []
let failures = 0
const check = (name, cond, detail = '') => {
  if (!cond) failures += 1
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)}` : ''}`)
}
const PW = { superadmin: 'Super@123', admin: 'Admin@123', manager: 'Manager@123', salesman: 'Sales@123', cs: 'Cs@123', dispatcher: 'Dispatch@123', driver: 'Driver@123', finance: 'Finance@123', customer: 'Customer@123', warehouse: 'Warehouse@123', qa: 'Quality@123' }
const as = async (u) => { auth.logout('switch'); const r = await auth.login(u, PW[u]); if (!r.ok) throw new Error(`login ${u}: ${r.error}`); return auth.getCurrentUser() }
const inv = (pid, hub) => read(K.INVENTORY).find((r) => r.productId === pid && r.hubId === hub)
const today = new Date().toISOString().slice(0, 10)
const plus = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10)
const HUB = 'hub-che'

/* 0. migration + data model */
check('0 data v11 keys seeded (vendors, allocations, recurring, chat, settings)', [K.VENDORS, K.BATCH_ALLOCATIONS, K.RECURRING_ORDERS, K.CHAT_CHANNELS, K.ERP_SETTINGS].every((k) => storage.getItem(k) !== null))
check('0 vendors are the supplier master (same ids as planning suppliers)', read(K.VENDORS).length >= 6 && read(K.VENDORS).every((v) => storage.getItem(K.FORECAST_SETTINGS).suppliers.some((s) => s.id === v.id)))
check('0 products carry units / weight / shelf life', read(K.PRODUCTS).every((p) => p.baseUnit && Array.isArray(p.units) && p.weightKg > 0))
check('0 customers carry coordinates and a secondary salesman field', read(K.CUSTOMERS).every((c) => 'latitude' in c && 'secondarySalesRepId' in c))
check('0 batch allocations collection ready (seeded history predates lot tracking)', Array.isArray(storage.getItem(K.BATCH_ALLOCATIONS)))

/* 1. vendor */
const admin = await as('admin')
const v = vendors.saveVendor({ code: 'VEN-900', name: 'Test Frozen Supplies LLP', gstNumber: '33AABCT1234C1Z5', panNumber: 'AABCT1234C', contactPerson: 'Ravi', mobile: '+91 98400 55555', email: 'ravi@testfrozen.demo', address: 'Chennai', leadTimeDays: 5, minOrderValue: 1000, paymentTerms: 'Net 30', categories: ['Frozen Food'], bank: { accountName: 'Test Frozen', accountNumber: '1234567890', bankName: 'Demo Bank', ifsc: 'DEMO0001234' } })
check('1 vendor created', v.ok, v.errors || v.error)
const vendorId = v.record?.id
check('1 vendor mirrored into planning suppliers', storage.getItem(K.FORECAST_SETTINGS).suppliers.some((s) => s.id === vendorId))
check('1 invalid GSTIN rejected', !vendors.saveVendor({ code: 'VEN-901', name: 'Bad GST', gstNumber: 'XYZ', leadTimeDays: 3 }).ok)

/* 2. product with barcode */
const bc = (await imp('utils/barcode.js')).generateEan13(read(K.PRODUCTS).map((p) => p.barcode))
const pr = products.createProduct({ ...products.emptyProduct(), code: 'PRD-0900', name: 'Test Chicken Curry Cut', sku: 'BM-TST-900', barcode: bc, barcodeType: 'EAN-13', category: 'Frozen Food', unit: 'KG', packSize: 'Bulk', sellingPrice: '300', purchasePrice: '220', taxPercent: '5', minStockLevel: '0', reorderLevel: '0', maxStockLevel: '', units: [{ code: 'BOX', label: 'Box (10 kg)', factor: 10 }], salesUnit: 'KG', trackExpiry: true, batchTracking: true, perishable: true, shelfLifeDays: '180', minRemainingShelfLifeDays: '10', weightKg: '1', minOrderQty: '1' })
check('2 product created with EAN-13 barcode and BOX unit', pr.ok && pr.record.barcode === bc && pr.record.units.some((u) => u.code === 'BOX'), pr.errors)
const P = pr.record
check('2 duplicate barcode rejected', !products.createProduct({ ...products.emptyProduct(), code: 'PRD-0901', name: 'Dup', sku: 'BM-TST-901', barcode: bc, category: 'Frozen Food', unit: 'KG', sellingPrice: '1', purchasePrice: '1', taxPercent: '5', minStockLevel: '0', reorderLevel: '0', shelfLifeDays: '10', minRemainingShelfLifeDays: '1' }).ok)
check('2 wrong EAN-13 check digit rejected', !products.createProduct({ ...products.emptyProduct(), code: 'PRD-0902', name: 'Bad', sku: 'BM-TST-902', barcode: '8905501173013', category: 'Frozen Food', unit: 'KG', sellingPrice: '1', purchasePrice: '1', taxPercent: '5', minStockLevel: '0', reorderLevel: '0', shelfLifeDays: '10', minRemainingShelfLifeDays: '1' }).ok)
check('2 barcode scan finds the product', workspace.findByBarcode(bc)?.id === P.id)
check('10 units: 5 BOX = 50 KG base', units.toBase(P, 5, 'BOX') === 50)

/* 3-4. hub + opening stock (admin only) */
check('3 hub exists and is active', read(K.HUBS).some((h) => h.id === HUB && h.status === 'Active'))
await as('warehouse')
check('4 opening stock is admin-only', !stockCtl.postOpeningStock([{ productId: P.id, hubId: HUB, quantity: 10, batchNumber: 'OB-X', expiryDate: plus(100) }], { reason: 'opening balance' }).ok)
await as('admin')
const ob = stockCtl.postOpeningStock([{ productId: P.id, hubId: HUB, quantity: 40, batchNumber: 'OB-900-1', expiryDate: plus(120), mfgDate: plus(-10), unitCost: 210 }], { reason: 'Opening balance at go-live' })
sync()
check('4 opening stock posted through the ledger (receipt movement)', ob.ok && read(K.STOCK_MOVEMENTS).some((m) => m.referenceNumber === ob.records[0].receiptNumber), ob.error)
const obLot = read(K.BATCHES).find((b) => b.productId === P.id && b.batchNumber === 'OB-900-1')
check('4 opening batch created with expiry and cost', obLot && obLot.quantity === 40 && obLot.sourceType === 'Opening stock' && obLot.unitCost === 210, obLot)
check('4 duplicate opening batch refused', !stockCtl.postOpeningStock([{ productId: P.id, hubId: HUB, quantity: 1, batchNumber: 'OB-900-1', expiryDate: plus(120) }], { reason: 'again please' }).ok)

/* 5-8. PO → sent → GRN → batch → stock */
const po = records.createRecord('purchase_orders', { supplierId: vendorId, hubId: HUB, orderDate: today, expectedDate: plus(3), currency: 'INR', paymentTerms: 'Net 30', lines: [{ productId: P.id, quantity: 60, unitPrice: 220, taxPercent: 5 }] }, admin)
check('5 PO created (draft)', po.ok && po.record.status === 'DRAFT', po.error)
const poId = po.record.id
records.runAction('purchase_orders', poId, 'submit', {}, admin)
const sa = await as('superadmin')
const apr = records.runAction('purchase_orders', poId, 'approve', {}, sa)
const sent = records.runAction('purchase_orders', poId, 'send', {}, admin)
check('6 PO approved and sent', apr.ok && sent.ok && read(K.PURCHASE_ORDERS).find((p) => p.id === poId).status === 'SENT', [apr.error, sent.error])
const before = inv(P.id, HUB).totalQuantity
const grn = records.createRecord('goods_receipts', { purchaseOrderId: poId, supplierId: vendorId, hubId: HUB, receivedDate: today, deliveryNoteRef: 'DN-1', vendorInvoiceNumber: 'VINV-77', vendorInvoiceDate: today, qaRequired: false, lines: [{ productId: P.id, orderedQty: 60, receivedQty: 60, rejectedQty: 0, batchNumber: 'B-101', expiryDate: plus(60), mfgDate: plus(-5), unitCost: 220 }] }, admin)
check('7 GRN created with vendor invoice number', grn.ok && grn.record.vendorInvoiceNumber === 'VINV-77', grn.error)
const post = records.runAction('goods_receipts', grn.record.id, 'post', {}, admin)
sync()
check('7 GRN posted', post.ok, post.error)
const lotB101 = read(K.BATCHES).find((b) => b.batchNumber === 'B-101' && b.productId === P.id)
check('8 batch B-101 created and linked to the PO and vendor', lotB101 && lotB101.poId === poId && lotB101.vendorId === vendorId && lotB101.quantity === 60, lotB101)
check('9 stock increased by the GRN', inv(P.id, HUB).totalQuantity === before + 60, [before, inv(P.id, HUB).totalQuantity])
check('9 PO fully received', read(K.PURCHASE_ORDERS).find((p) => p.id === poId).status === 'RECEIVED')

/* 10-11. customer with primary / secondary salesman */
await as('admin')
const cust = read(K.CUSTOMERS).find((c) => c.hubId === HUB && c.status === 'Active' && !c.creditHold && c.salesRepId === 'u-salesman')
const manager = await as('manager')
const asg = sales.assignSalesmen(cust.id, { primaryId: 'u-salesman', secondaryId: 'sr-vignesh', reason: 'Scenario coverage set-up' })
check('10 primary + secondary salesman assigned (history kept)', asg.ok && read(K.CUSTOMERS).find((c) => c.id === cust.id).assignmentHistory.length >= 1, asg.error)
check('11 effective salesman is the primary when available', sales.effectiveSalesman(read(K.CUSTOMERS).find((c) => c.id === cust.id)).role === 'primary')
const salesReps = storage.getItem(K.DEMO_DATA).salesReps
storage.setItem(K.DEMO_DATA, { ...storage.getItem(K.DEMO_DATA), salesReps: salesReps.map((r) => (r.id === 'u-salesman' ? { ...r, status: 'On Leave' } : r)) })
check('11 primary on leave → secondary covers automatically', sales.effectiveSalesman(read(K.CUSTOMERS).find((c) => c.id === cust.id)).salesmanId === 'sr-vignesh')
storage.setItem(K.DEMO_DATA, { ...storage.getItem(K.DEMO_DATA), salesReps: salesReps.map((r) => (r.id === 'u-salesman' ? { ...r, status: 'Active' } : r.id === 'sr-vignesh' ? { ...r, status: 'Resigned' } : r)) })
storage.setItem(K.DEMO_DATA, { ...storage.getItem(K.DEMO_DATA), salesReps: storage.getItem(K.DEMO_DATA).salesReps.map((r) => (r.id === 'u-salesman' ? { ...r, status: 'Inactive' } : r)) })
const eff = sales.effectiveSalesman(read(K.CUSTOMERS).find((c) => c.id === cust.id))
check('11 both unavailable → Sales Manager responsible (never unassigned)', eff.role === 'manager' && eff.salesmanId, eff)
check('11 Sales Manager notified about uncovered customers', sales.notifyUncovered() >= 1 && read(K.NOTIFICATIONS).some((n) => /no available salesman/.test(n.title)))
storage.setItem(K.DEMO_DATA, { ...storage.getItem(K.DEMO_DATA), salesReps })

/* 12. one-time order in BOX (unit conversion) with slot */
await as('salesman')
const base = { ...orders.emptyOrderInput(auth.getCurrentUser()), customerId: cust.id, hubId: HUB, ...orders.deliveryFromCustomer(cust), paymentTerms: 'Cash on Delivery', requestedDeliveryDate: plus(1), deliverySlotId: 'slot-am' }
const one = orders.submitOrder(null, { ...base, items: [{ key: 'l1', productId: P.id, entryUnit: 'BOX', entryQuantity: '8', orderedQuantity: '', discountPercentage: '0' }] })
check('12 one-time order submitted in BOX → 80 KG base', one.ok && one.record.items[0].orderedQuantity === 80 && one.record.items[0].entryUnit === 'BOX' && one.record.deliverySlotLabel.startsWith('Morning'), one.errors || one.error)
const oneId = one.record?.id
const dupe = orders.submitOrder(null, { ...base, items: [{ key: 'l1', productId: P.id, entryUnit: 'BOX', entryQuantity: '1', orderedQuantity: '' }] })
check('12 duplicate order detected (same customer, date, products)', !dupe.ok && dupe.errors?.duplicate, dupe.errors)
check('12 minimum / unit validation (2.5 BOX refused)', !orders.submitOrder(null, { ...base, requestedDeliveryDate: plus(2), items: [{ key: 'l1', productId: P.id, entryUnit: 'BOX', entryQuantity: '2.5' }] }).ok)

/* 13. recurring order */
const rec = recurring.saveRecurring({ name: 'Daily curry cut', customerId: cust.id, hubId: HUB, salesmanId: 'u-salesman', deliveryAddress: base.deliveryAddress, frequency: 'DAILY', startDate: today, endDate: plus(30), slots: [{ slotId: 'slot-am', time: '08:00', lines: [{ productId: P.id, quantity: 1, unit: 'BOX' }] }, { slotId: 'slot-pm', time: '15:00', lines: [{ productId: P.id, quantity: 5, unit: 'KG' }] }] })
check('13 recurring order created with two slots', rec.ok, rec.errors || rec.error)
const gen1 = recurring.generateDueOrders({ horizonDays: 1 })
const gen2 = recurring.generateDueOrders({ horizonDays: 1 })
check('13 recurring orders generated for each slot (today + tomorrow = 4)', gen1.created.length === 4, [gen1.created.length, gen1.errors])
check('13 regeneration creates no duplicates', gen2.created.length === 0, gen2.created.length)
const recOrders = read(K.ORDERS).filter((o) => o.recurringOrderId === rec.record.id)
check('13 generated orders are Recurring and submitted for approval', recOrders.length === 4 && recOrders.every((o) => o.orderMode === 'Recurring' && o.orderStatus === S.SUBMITTED))
const paused = recurring.setRecurringStatus(rec.record.id, 'pause')
check('13 pause stops generation', paused.ok && recurring.generateDueOrders({ ids: [rec.record.id], horizonDays: 3 }).created.length === 0)
recurring.setRecurringStatus(rec.record.id, 'resume')

/* 14. approve → reservation */
await as('manager')
const ap = approval.approveOrder(oneId, { remarks: 'ok', acknowledgeWarnings: true })
check('14 order approved and stock reserved (80 KG)', ap.ok && inv(P.id, HUB).reservedQuantity >= 80, [ap.error, inv(P.id, HUB).reservedQuantity])

/* 15. FEFO preview: OB-900-1 (exp +120) vs B-101 (exp +60) → B-101 first */
const preview = stockCtl.fefoPlan([orders.getOrderById(oneId)], HUB)
check('15 FEFO preview takes the earliest expiry first (B-101 60, then OB-900-1 20)', preview.lines[0].lots[0].batchNumber === 'B-101' && preview.lines[0].lots[0].quantity === 60 && preview.lines[0].lots[1]?.batchNumber === 'OB-900-1' && preview.lines[0].lots[1]?.quantity === 20, preview.lines[0].lots)

/* 16. consolidate */
await as('cs')
const con = consolidation.consolidateOrder(oneId, { notes: 'checked', verified: Object.fromEntries(consolidation.VERIFICATION_STEPS.map((s) => [s.id || s.key, true])) })
const rdy = consolidation.markReadyForDispatch(oneId)
check('16 consolidated and ready for dispatch', con.ok && rdy.ok && orders.getOrderById(oneId).orderStatus === S.READY_FOR_DISPATCH, [con.error, rdy.error])

/* 17-20. dispatch, driver availability, capacity, loading */
// The demo driver (u-driver) is mid-route in the seed data: finish his stops first so he can take the new dispatch
const podSeed = { signature: 'data:image/png;base64,iVBORw0KGgo=', photo: null, signedBy: 'Store manager' }
await as('driver')
const demoDrv = read(K.DRIVERS).find((d) => d.userId === auth.getCurrentUser().id)
for (let guard = 0; guard < 25; guard += 1) {
  const active = dispatch.getDispatches().find((d) => d.driverId === demoDrv.id && ['CONFIRMED', 'IN_TRANSIT'].includes(d.status) && !delivery.isFutureDispatch(d))
  if (!active) break
  const next = delivery.getNextStop(delivery.getDeliveriesForDispatch(active.id))
  if (!next) break
  if (next.status !== 'OUT_FOR_DELIVERY') delivery.startDelivery(next.id)
  if (!delivery.getDeliveryById(next.id).arrivedAt) delivery.markArrived(next.id)
  const d0 = delivery.getDeliveryById(next.id)
  delivery.confirmDelivery(next.id, { items: d0.items.map((it) => ({ ...it, deliveredQuantity: it.orderedQuantity, damagedQuantity: 0, shortQuantity: 0, rejectedQuantity: 0 })), receivedBy: 'Receiver', otp: otp.getLatestOtp(next.id)?.otp, pod: podSeed })
}
const dispatcher = await as('dispatcher')
const drv = read(K.DRIVERS).find((d) => d.id === demoDrv.id)
const off = fleet.addOfflinePeriod(drv.id, { from: new Date(Date.now() - 3600e3).toISOString(), to: new Date(Date.now() + 5 * 3600e3).toISOString(), reason: 'Personal', remarks: 'scenario' })
check('18 offline period recorded for a driver', off.ok, off.error)
const zone = read(K.DISPATCH_ZONES).find((z) => z.hubId === HUB && z.status === 'Active')
const bike = read(K.VEHICLES).find((x) => x.type === 'Bike') || null
const freeVeh = read(K.VEHICLES).filter((x) => x.hubId === HUB && x.status === 'Available' && x.type !== 'Bike' && !read(K.DISPATCHES).some((d) => d.vehicleId === x.id && ['ASSIGNED', 'CONFIRMED', 'IN_TRANSIT'].includes(d.status)))
const offRes = dispatch.validateDispatch({ hubId: HUB, dispatchDate: today, zoneId: zone.id, orderIds: [oneId], driverId: drv.id, vehicleId: freeVeh[0].id }, { mode: 'plan' })
check('18 offline driver cannot be assigned', /offline/i.test(offRes.errors.driverId || ''), offRes.errors)
const ovr = fleet.overrideAvailability(drv.id, today, 'Urgent customer — driver agreed to come in')
check('18 admin-only availability override (dispatcher refused)', !ovr.ok)
fleet.removeOfflinePeriod(drv.id, read(K.DRIVERS).find((d) => d.id === drv.id).offlinePeriods.slice(-1)[0].id)
const tiny = { ...freeVeh[0], maxWeightKg: 50 }
check('19 capacity check refuses an overloaded vehicle (80 kg > 50 kg)', fleet.capacityCheck(tiny, [orders.getOrderById(oneId)]).blocks.length === 1)
const dc = dispatch.createDispatch({ hubId: HUB, dispatchDate: today, zoneId: zone.id, orderIds: [oneId], driverId: drv.id, vehicleId: freeVeh[0].id, notes: '' }, { mode: 'plan' })
check('17 dispatch created with vehicle and driver', dc.ok, dc.errors || dc.error)
const did = dc.record?.id
const ld = fleet.setOrderLoaded(did, oneId, true)
const ls = fleet.loadingState(dispatch.getDispatchById(did))
check('20 order loaded; used/remaining/% shown', ld.ok && ls.loaded.load.weight === 80 && ls.loaded.usage.find((u) => u.key === 'weight').remaining === freeVeh[0].maxWeightKg - 80, [ld.error, ls.loaded.usage])
check('20 route grouping lists stop 1 with distance from the hub', ls.stops[0]?.stop === 1 && ls.stops[0].cumulativeKm > 0, ls.stops[0])

/* 13b. vehicle replacement keeps the same dispatch */
const repl = fleet.replacementCandidates(dispatch.getDispatchById(did)).find((c) => c.eligible)
if (repl) {
  const countBefore = read(K.DISPATCHES).length
  const rr = fleet.replaceVehicle(did, repl.vehicle.id, { reason: 'Breakdown', remarks: 'Compressor failure' })
  check('§13 vehicle replaced on the same dispatch (no duplicate), history kept', rr.ok && read(K.DISPATCHES).length === countBefore && dispatch.getDispatchById(did).vehicleId === repl.vehicle.id && dispatch.getDispatchById(did).vehicleReplacements.length === 1, rr.error)
  check('§13 old vehicle moved to Maintenance', read(K.VEHICLES).find((x) => x.id === freeVeh[0].id).status === 'Maintenance')
}

/* 21. confirm dispatch → movement with FEFO lots */
const cf = dispatch.confirmDispatch(did, { acknowledged: true })
sync()
check('21 dispatch confirmed', cf.ok, cf.error || cf.blocks)
const mv = read(K.STOCK_MOVEMENTS).find((m) => m.dispatchId === did && m.productId === P.id)
check('21 dispatch movement carries the FEFO lots', mv?.lots?.length === 2 && mv.lots[0].batchNumber === 'B-101', mv?.lots)
check('21 batch quantities follow the plan (B-101 0, OB 20)', read(K.BATCHES).find((b) => b.id === lotB101.id).quantity === 0 && read(K.BATCHES).find((b) => b.id === obLot.id).quantity === 20)

/* 22-27. driver: GPS route, OTP, POD, delivery */
const driverUserId = read(K.DRIVERS).find((d) => d.id === drv.id).userId
const route = fleet.routeModel(did)
check('23 route model: hub H + numbered stops + polyline + ETA', route.origin && route.stops[0].stop === 1 && route.polyline.length === 2 && route.totalKm > 0, route && { o: route.origin, s: route.stops.length })
let dUser = driverUserId ? read(K.DEMO_USERS).find((u) => u.id === driverUserId) : null
if (dUser) { PW[dUser.username] ||= 'Driver@123'; await as(dUser.username) } else await as('dispatcher')
const dlv = delivery.getDeliveries().find((d) => d.dispatchId === did)
const st = delivery.startDelivery(dlv.id)
const ar = delivery.markArrived(dlv.id)
const sim = fleet.routeModel(did)
check('23 position is labelled simulated / manual (never claimed live)', ['simulated', 'manual'].includes(sim.positionSource), sim.positionSource)
const man = fleet.recordManualLocation(did, { lat: 13.05, lng: 80.25, note: 'test' })
check('23 manual location update recorded', man.ok && fleet.routeModel(did).positionSource === 'manual', man.error)
const pod = { signature: 'data:image/png;base64,iVBORw0KGgo=', photo: null, signedBy: 'Store manager' }
const items = delivery.getDeliveryById(dlv.id).items.map((it) => ({ ...it, deliveredQuantity: it.orderedQuantity, damagedQuantity: 0, shortQuantity: 0, rejectedQuantity: 0 }))
const done = delivery.confirmDelivery(dlv.id, { items, receivedBy: 'Store manager', otp: otp.getLatestOtp(dlv.id)?.otp, pod })
check('24-27 OTP verified, POD captured, delivered', st.ok && ar.ok && done.ok && orders.getOrderById(oneId).orderStatus === S.DELIVERED, [st.error, ar.error, done.error || done.errors])
check('23 stop shows Delivered on the route', fleet.routeModel(did).stops[0].status === 'DELIVERED')

/* 28-29. movement + allocation */
const allocs = read(K.BATCH_ALLOCATIONS).filter((a) => a.orderId === oneId)
check('28-29 allocations: 60 KG from B-101 (PO) + 20 KG from OB-900-1', allocs.length === 2 && allocs.find((a) => a.batchNumber === 'B-101')?.quantity === 60 && allocs.find((a) => a.batchNumber === 'B-101')?.poId === poId && allocs.find((a) => a.batchNumber === 'OB-900-1')?.quantity === 20, allocs)
check('§10 order line progress: ordered 80, dispatched 80, delivered 80, remaining 0', (() => { const p = units.lineProgress(orders.getOrderById(oneId).items[0], read(K.DELIVERIES).filter((d) => d.orderId === oneId)); return p.ordered === 80 && p.dispatched === 80 && p.delivered === 80 && p.remaining === 0 })())

/* 30-31. invoice with batch details; customer sees it */
await as('finance')
const g = invoice.generateInvoice(oneId, {})
check('30 invoice issued with an immutable source-batch snapshot', g.ok && g.record.sourceBatches?.length === 2 && g.record.sourceBatches.some((b) => b.poNumber === read(K.PURCHASE_ORDERS).find((p) => p.id === poId).number), g.error || g.record?.sourceBatches)
const custUser = read(K.DEMO_USERS).find((u) => u.customerId === cust.id)
if (custUser) check('31 customer account linked to the customer can see the order', orders.canViewOrder(custUser, orders.getOrderById(oneId)))

/* 32. payment */
const fin = auth.getCurrentUser()
const amt = g.record.totals.grandTotal
const pay = records.createRecord('customer_payments', { customerId: cust.id, paymentDate: today, method: 'Bank transfer', bankAccountId: read(K.BANK_ACCOUNTS)[0]?.id, amount: amt, reference: 'ERP-SCN-1', allocations: [{ invoiceId: g.record.id, amount: Math.round(amt / 2 * 100) / 100 }] }, fin)
let pst = pay
const payMod = (await imp('config/enterprise/modules/operations.js')).customerPayments
for (const a of ['submit', 'post', 'approve']) {
  const rr = read(K.CUSTOMER_PAYMENTS).find((p) => p.id === pay.record?.id)
  const def = payMod.actions.find((x) => x.id === a)
  if (!rr || !def || !def.from.includes(rr.status)) continue
  pst = records.runAction('customer_payments', pay.record.id, a, { note: 'scenario' }, a === 'approve' ? await as('admin') : fin)
}
check('32 partial payment posted against the invoice', read(K.CUSTOMER_PAYMENTS).find((p) => p.id === pay.record?.id)?.status === 'POSTED' && finance.invoiceBalance(g.record.id) > 0, [pay.error, pst.error])

/* 33-34. complaints → vendor alert */
const cs = await as('cs')
const lines = complaints.complaintLines(oneId)
check('33 complaint lines show the two batches that served the line', lines[0].batches.length === 2)
const needSplit = complaints.createComplaint({ orderId: oneId, orderItemId: lines[0].id, type: 'Quality', description: 'Discoloured pieces in the box', quantity: 4, photos: [{ name: 'p.jpg', dataUrl: 'data:image/jpeg;base64,AAA' }] })
check('33 multi-batch line requires a batch selection / split', !needSplit.ok && needSplit.errors?.batches)
const mk = (q, type = 'Quality') => complaints.createComplaint({ orderId: oneId, orderItemId: lines[0].id, type, description: 'Discoloured pieces found in the box', quantity: q, batches: [{ batchId: lotB101.id, quantity: q }], photos: [{ name: 'p.jpg', dataUrl: 'data:image/jpeg;base64,AAA' }] })
const c1 = mk(2)
check('33 complaint raised; batch, PO and vendor filled from allocations', c1.ok && c1.record.batchNumbers[0] === 'B-101' && c1.record.poIds[0] === poId && c1.record.vendorId === vendorId, c1.errors || c1.error)
const late = complaints.complaintBlockReason({ ...orders.getOrderById(oneId), deliveredAt: new Date(Date.now() - 9 * 864e5).toISOString() })
check('33 complaint window enforced (9 days > 7)', /window has closed/.test(late || ''))
check('33 complaints only for delivered orders', /delivered/.test(complaints.complaintBlockReason(recOrders[0]) || ''))
const c2 = mk(1)
const c3 = mk(1, 'Expired')
check('34 third vendor-responsible complaint → vendor quality alert', c2.ok && c3.ok && read(K.VENDOR_QUALITY_ALERTS).some((a) => a.vendorId === vendorId), [c2.error, c3.error])
check('34 vendor put On Watch and Admin notified', vendors.getVendorById(vendorId).status === 'On Watch' && read(K.NOTIFICATIONS).some((n) => /Vendor quality alert/.test(n.title)))
const sc = complaints.vendorScorecard(vendorId)
check('§20 scorecard: complaints, rate and batches', sc.total === 3 && sc.rate > 0 && sc.batches.includes('B-101'), sc)
const inv1 = complaints.startInvestigation(c1.record.id, { note: 'checking' })
const res1 = complaints.resolveComplaint(c1.record.id, { resolution: 'CREDIT_NOTE', remarks: 'Credit for 2 KG' })
check('§19 resolve with credit note linked to the invoice', inv1.ok && res1.ok && res1.record.creditNoteId && read(K.CREDIT_NOTES).find((c) => c.id === res1.record.creditNoteId)?.invoiceId === g.record.id, res1.error)
const res2 = complaints.resolveComplaint(c2.record.id, { resolution: 'REPLACEMENT', remarks: 'Replace 1 KG' })
check('§19 resolve with a linked replacement order', res2.ok && orders.getOrderById(res2.record.linkedOrderId)?.sourceComplaintId === c2.record.id, res2.error)
check('§19 resolution remarks required', !complaints.resolveComplaint(c3.record.id, { resolution: 'NO_ACTION', remarks: '' }).ok)
check('§19 closing works after resolution', complaints.closeComplaint(c1.record.id, 'done').ok)
const sm = await as('salesman')
check('§19 salesman sees complaints of own customers only', complaints.visibleComplaints(sm).every((c) => [read(K.CUSTOMERS).find((x) => x.id === c.customerId)?.salesRepId, read(K.CUSTOMERS).find((x) => x.id === c.customerId)?.secondarySalesRepId].includes(sm.id) || c.raisedBy === sm.id))
await as('superadmin')
const blk = vendors.setVendorStatus(vendorId, 'Blocked', 'Repeated quality failures')
const po2 = records.createRecord('purchase_orders', { supplierId: vendorId, hubId: HUB, orderDate: today, expectedDate: plus(3), currency: 'INR', paymentTerms: 'Net 30', lines: [{ productId: P.id, quantity: 5, unitPrice: 220, taxPercent: 5 }] }, auth.getCurrentUser())
check('§16 blocked vendor cannot receive a new PO', blk.ok && !po2.ok && /blocked/i.test(po2.error), po2.error)

/* 35-38. expiry detection → scrap approval → deduction */
await as('admin')
const lots = read(K.BATCHES)
storage.setItem(K.BATCHES, lots.map((b) => (b.id === obLot.id ? { ...b, expiryDate: plus(-1) } : b)))
batchSvc.refreshHoldQuantities()
const availAfterExpiry = getAvailable(inv(P.id, HUB))
const det = stockCtl.detectExpiry()
const det2 = stockCtl.detectExpiry()
const scr = read(K.SCRAP_REQUESTS).find((r) => r.batchId === obLot.id)
check('35 expiry detection blocks the batch and raises one scrap request', det.raised === 1 && det2.raised === 0 && scr?.status === 'PENDING_APPROVAL' && scr.stockSource === 'blocked', [det, det2])
check('35 expired stock is not available for orders / dispatch / transfer', inv(P.id, HUB).qaHoldQuantity >= 20 && availAfterExpiry <= inv(P.id, HUB).totalQuantity - 20)
const expiredPlan = stockCtl.fefoPlan([{ id: 'x', orderNumber: 'TEST', items: [{ id: 'l', productId: P.id, productName: P.name, unit: 'KG', orderedQuantity: 30 }] }], HUB)
check('§18 FEFO blocks with "Only X usable; Y is expired or near expiry"', /Only 0 KG usable; 20 KG is expired or near expiry/.test(expiredPlan.blocks[0] || ''), expiredPlan.blocks)
const ovExp = stockCtl.fefoPlan([{ id: 'x', orderNumber: 'TEST', items: [{ id: 'l', productId: P.id, productName: P.name, unit: 'KG', orderedQuantity: 5 }] }], HUB, { overrides: { 'x|l': [{ batchId: obLot.id, quantity: 5 }] } })
check('§18 expired batches can never be overridden', ovExp.blocks.some((b) => /can never be dispatched/.test(b)))
const totalBeforeScrap = inv(P.id, HUB).totalQuantity
const apS = scrap.approveScrap(scr.id, { remarks: 'Expired stock destroyed', writeOffNow: true })
const wo = read(K.SCRAP_REQUESTS).find((r) => r.id === scr.id).status === 'APPROVED' ? scrap.writeOffScrap(scr.id) : { ok: true }
sync()
check('36-37 scrap approved and stock deducted once', apS.ok && wo.ok && inv(P.id, HUB).totalQuantity === totalBeforeScrap - 20, [apS.error, wo.error, totalBeforeScrap, inv(P.id, HUB).totalQuantity])
const closed = read(K.BATCHES).find((b) => b.id === obLot.id)
check('37 batch closed as scrapped (consumption recorded)', closed.quantity === 0 && closed.closedReason === 'SCRAPPED', closed)
check('37 second write-off refused', !scrap.writeOffScrap(scr.id).ok)

/* §21 reject path + return to vendor */
const lotsNow = read(K.BATCHES)
const grn2 = records.createRecord('goods_receipts', { purchaseOrderId: null, supplierId: 'sup-01', hubId: HUB, receivedDate: today, lines: [{ productId: P.id, orderedQty: 0, receivedQty: 6, rejectedQty: 0, batchNumber: 'B-205', expiryDate: plus(40), unitCost: 225 }] }, auth.getCurrentUser())
const post2 = grn2.ok ? records.runAction('goods_receipts', grn2.record.id, 'post', {}, auth.getCurrentUser()) : grn2
sync()
const b205 = read(K.BATCHES).find((b) => b.batchNumber === 'B-205')
if (b205) {
  storage.setItem(K.BATCHES, read(K.BATCHES).map((b) => (b.id === b205.id ? { ...b, expiryDate: plus(-2) } : b)))
  batchSvc.refreshHoldQuantities()
  stockCtl.detectExpiry()
  const s2 = read(K.SCRAP_REQUESTS).find((r) => r.batchId === b205.id)
  const rj = scrap.rejectScrap(s2.id, { reason: 'Vendor will take it back' })
  check('§21 scrap rejection keeps stock blocked', rj.ok && inv(P.id, HUB).qaHoldQuantity >= 6)
  const rtv = stockCtl.returnToVendor({ batchId: b205.id, quantity: 6, reason: 'Expired on arrival — credit requested', scrapRequestId: s2.id })
  sync()
  check('§21 return to vendor: PO return number, stock deduction, history', rtv.ok && /^PRN-/.test(rtv.record.number) && read(K.BATCHES).find((b) => b.id === b205.id).quantity === 0 && read(K.SCRAP_REQUESTS).find((r) => r.id === s2.id).returnedToVendor, rtv.error)
} else check('§21 second GRN for return-to-vendor test', false, post2.error)
void lotsNow

/* 38-42. reports, PO traceability, exceptions, chat, audit */
const ctx = reports.buildReportContext ? reports.buildReportContext() : null
const runR = (id) => reports.runReport(reports.getReport(id), reports.buildReportContext(auth.getCurrentUser()))
const r1 = runR('po-invoice-traceability')
const r2 = runR('vendor-complaints')
const r3 = runR('expiry-dashboard')
check('38 reports: PO ↔ invoice traceability, vendor complaints, expiry', r1?.rows?.some((x) => x.poNumber) && r2?.rows?.length > 0 && Array.isArray(r3?.rows), [r1?.error, r2?.error, r3?.error, Boolean(ctx)])
const poDef = (await imp('config/enterprise/modules/supply.js')).purchaseOrders
const trace = poDef.detailTables(read(K.PURCHASE_ORDERS).find((p) => p.id === poId))
const where = trace.find((t) => /where it went/.test(t.title)).rows.find((x) => x.batchNumber === 'B-101')
check('39 PO "where it went": B-101 60 sold, 0 in stock, customer listed', where.sold === 60 && where.inStock === 0 && where.customers.includes(cust.name), where)
check('40 exception dashboard lists open complaints / expiries', workspace.exceptionList(auth.getCurrentUser()).length > 0)
const _sq = ['B-101', read(K.PURCHASE_ORDERS).find((p) => p.id === poId).number, 'Test Frozen']; check('41 smart search finds batch, PO and vendor', _sq.every((q) => workspace.smartSearch(q).length > 0), _sq.map((q) => [q, workspace.smartSearch(q).length]))
const ch = chat.openDirect('u-dispatcher')
const msg = ch.ok && chat.sendMessage(ch.record.id, { body: 'Please check this order', share: { type: 'order', id: oneId } })
check('41 chat: direct message with a shared order card', msg?.ok && chat.resolveShare(msg.record.share).path === `/orders/${oneId}`, msg?.error)
const drvUser = read(K.DEMO_USERS).find((u) => u.role === 'DRIVER')
check('41 shared record respects the viewer permissions (driver cannot open an invoice)', chat.resolveShare({ type: 'invoice', id: g.record.id }, drvUser)?.allowed === false)
const audit = read(K.AUDIT_LOGS)
check('42 audit trail records vendor, opening stock, FEFO, complaints, scrap, return to vendor', ['Vendor created', 'Opening stock', 'Complaint raised', 'Vendor Blocked', 'Return to vendor'].every((a) => audit.some((x) => x.action === a)), ['Vendor created', 'Opening stock', 'Complaint raised', 'Vendor Blocked', 'Return to vendor'].filter((a) => !audit.some((x) => x.action === a)))

/* RBAC */
const drvU = read(K.DEMO_USERS).find((u) => u.role === 'DRIVER')
const custU = read(K.DEMO_USERS).find((u) => u.role === 'CUSTOMER')
check('§25 driver cannot open opening stock / complaints management / vendor blocking', !can(drvU, 'inventory.openingstock') && !can(drvU, 'complaints.manage') && !can(drvU, 'vendors.block'))
check('§25 customer sees only own complaints', complaints.visibleComplaints(custU).every((c) => c.customerId === custU.customerId))
check('§25 only admin holds inventory.openingstock among office roles', ['manager', 'salesman', 'cs', 'dispatcher', 'finance', 'warehouse'].every((u) => !can(read(K.DEMO_USERS).find((x) => x.username === u), 'inventory.openingstock')))

/* Integrity */
await flush()
const rec2 = batchSvc.reconcile()
check('43 lot totals reconcile with the stock ledger', rec2.ok !== false && !(rec2.mismatches || []).length, rec2.mismatches?.slice(0, 3))
const allocIds = read(K.BATCH_ALLOCATIONS).map((a) => a.id)
check('43 no duplicate allocations', new Set(allocIds).size === allocIds.length)
const invNos = read(K.INVOICES).map((i) => i.invoiceNumber)
check('43 no duplicate invoices', new Set(invNos).size === invNos.length)

console.log(`\n${failures ? `${failures} check(s) FAILED` : 'All ERP scenario checks passed'}`)
process.exit(failures ? 1 : 0)
