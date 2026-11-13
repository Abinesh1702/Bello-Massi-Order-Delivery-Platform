/**
 * Migration check: loads a LocalStorage snapshot made by an earlier release (JSON of key → string), starts the
 * current code on it and verifies the upgrade keeps user data, rebuilds reservations consistently and is idempotent.
 *   node --import ./scripts/register.mjs scripts/migration-check.mjs <snapshot.json>
 */
import fs from 'node:fs'
const snap = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const mem = new Map(Object.entries(snap))
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i] ?? null, get length() { return mem.size } }
globalThis.window = globalThis; globalThis.addEventListener = () => {}; globalThis.dispatchEvent = () => true
const src = new URL('../src/', import.meta.url).href
const { initializeStorage } = await import(src + 'services/storageService.js')
const { syncCatalog } = await import(src + 'services/rbacService.js')
const { STORAGE_KEYS: K, APP_DATA_VERSION } = await import(src + 'utils/constants.js')
const { openReservationLines } = await import(src + 'utils/stockReservation.js')
const { getAvailable } = await import(src + 'utils/stock.js')
const get = (k) => JSON.parse(mem.get(k))
let fails = 0
const check = (n, c, d = '') => { if (!c) fails += 1; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${!c && d ? ` — ${JSON.stringify(d)}` : ''}`) }

const before = { orders: get(K.ORDERS), customers: get(K.CUSTOMERS), inventory: get(K.INVENTORY), movements: get(K.STOCK_MOVEMENTS), users: get(K.DEMO_USERS), roles: get(K.ROLES) }
const report = initializeStorage(); syncCatalog()
const fromVersion = JSON.parse(snap[K.APP_VERSION]).dataVersion
check(`migrated from v${report.migratedFrom} to v${APP_DATA_VERSION}`, report.migratedFrom === fromVersion && get(K.APP_VERSION).dataVersion === APP_DATA_VERSION, report)
check('no existing key was reseeded or repaired', report.repaired.length === 0 && report.seeded.every((k) => !(k in snap)), report)
const after = { orders: get(K.ORDERS), customers: get(K.CUSTOMERS), inventory: get(K.INVENTORY), movements: get(K.STOCK_MOVEMENTS), users: get(K.DEMO_USERS), roles: get(K.ROLES) }
check('orders kept (same count, ids, statuses)', after.orders.length === before.orders.length && after.orders.every((o, i) => o.id === before.orders[i].id && o.orderStatus === before.orders[i].orderStatus))
check('user edit kept (customer name)', after.customers[0].name.endsWith('(edited)'))
check('users kept', after.users.length === before.users.length)
check('on-hand stock and movements untouched', after.movements.length === before.movements.length && after.inventory.every((r, i) => r.totalQuantity === before.inventory[i].totalQuantity && (r.damagedQuantity || 0) === (before.inventory[i].damagedQuantity || 0)))
const open = {}
after.orders.forEach((o) => openReservationLines(o).forEach((l) => { const k = `${l.productId}|${o.hubId}`; open[k] = (open[k] || 0) + l.quantity }))
const mism = after.inventory.filter((r) => Math.abs((r.reservedQuantity || 0) - (open[`${r.productId}|${r.hubId}`] || 0)) > 1e-6)
check('reserved stock equals open-order reservations', mism.length === 0, mism.slice(0, 3).map((r) => [r.productId, r.hubId, r.reservedQuantity]))
check('no negative available stock after migration', after.inventory.every((r) => getAvailable(r) >= -1e-6))
const reserving = after.orders.filter((o) => ['APPROVED', 'CONSOLIDATED', 'READY_FOR_DISPATCH'].includes(o.orderStatus))
check(`every approved, not yet loaded order carries a reservation (${reserving.length})`, reserving.every((o) => o.reservation && ['RESERVED', 'PARTIAL', 'SHORT'].includes(o.reservation.status)))
const reportRoles = after.roles.filter((r) => (r.permissions || []).some((k) => ['orders.reports', 'dispatch.reports', 'invoices.reports', 'documents.reports', 'vms.view'].includes(k)))
check('roles with a module report page can open the Reports Center', reportRoles.every((r) => r.permissions.includes('reports.center')))
// Data v11 (advanced ERP) upgrade
if (fromVersion < 11) {
  const fs0 = JSON.parse(snap[K.FORECAST_SETTINGS])
  const vendors = get(K.VENDORS)
  check('v11: every planning supplier became a vendor with the same id', fs0.suppliers.every((s) => vendors.some((v) => v.id === s.id && v.name === s.name)))
  const p0 = JSON.parse(snap[K.PRODUCTS])
  const p1 = get(K.PRODUCTS)
  check('v11: products keep every existing field and gain units / shelf life', p1.every((p, i) => Object.keys(p0[i]).every((k) => JSON.stringify(p[k]) === JSON.stringify(p0[i][k])) && p.baseUnit && Array.isArray(p.units) && 'minRemainingShelfLifeDays' in p))
  check('v11: customers gain coordinates and a secondary-salesman field', get(K.CUSTOMERS).every((c) => 'latitude' in c && 'secondarySalesRepId' in c && Array.isArray(c.assignmentHistory)))
  check('v11: vehicles gain weight / volume / stop limits', get(K.VEHICLES).every((v) => v.maxWeightKg > 0 && v.maxStops > 0))
  check('v11: drivers gain offline periods', get(K.DRIVERS).every((d) => Array.isArray(d.offlinePeriods)))
  const tpl = JSON.parse(snap[K.ORDER_TEMPLATES] || '[]')
  check('v11: standing orders became recurring schedules (one each)', tpl.every((t) => get(K.RECURRING_ORDERS).filter((r) => r.sourceTemplateId === t.id).length === 1))
  check('v11: issued invoices carry a source-batch snapshot', get(K.INVOICES).filter((i) => !['DRAFT', 'CANCELLED'].includes(i.status)).every((i) => Array.isArray(i.sourceBatches)))
  check('v11: chat channels, settings and empty complaint / allocation stores exist', get(K.CHAT_CHANNELS).length > 0 && Array.isArray(get(K.COMPLAINTS)) && Array.isArray(get(K.BATCH_ALLOCATIONS)) && get(K.ERP_SETTINGS).complaints.windowDays === 7)
  const salesRole = get(K.ROLES).find((r) => r.code === 'SALESMAN')
  check('v11: roles received the new permission keys (salesman: complaints / recurring / chat)', ['complaints.create', 'recurring.manage', 'chat.access'].every((k) => salesRole.permissions.includes(k)))
  check('v11: customers and drivers cannot receive admin-only keys', !get(K.ROLES).filter((r) => ['CUSTOMER', 'DRIVER'].includes(r.code)).some((r) => r.permissions.includes('inventory.openingstock')))
}
// idempotent: a second start changes nothing
const frozen = JSON.stringify([...mem.entries()].filter(([k]) => ![K.APP_VERSION, K.AUDIT_LOGS, K.PERMISSIONS].includes(k)))
initializeStorage(); syncCatalog()
check('second start changes nothing (idempotent)', JSON.stringify([...mem.entries()].filter(([k]) => ![K.APP_VERSION, K.AUDIT_LOGS, K.PERMISSIONS].includes(k))) === frozen)
console.log(fails ? `\n${fails} check(s) failed` : '\nmigration checks passed')
process.exit(fails ? 1 : 0)
