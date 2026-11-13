/**
 * Period A vs Period B business comparison (data v11). Every KPI is computed from the stored records of each period
 * on that collection's own business date and returns the records behind it, so a KPI click shows exactly what was
 * counted. Snapshot KPIs (stock, outstanding, vendors on watch) are marked `current` — they do not depend on a period.
 */
import dayjs from 'dayjs'
import storage from '../storageService'
import { STORAGE_KEYS as K } from '../../utils/constants'
import { inRange, resolveRange, resolveSpecific } from '../../utils/periods'
import { compareValues } from '../../utils/dashboardFilter'
import { weightOf } from '../../utils/units'
import { invoiceBalances } from '../enterprise/financeService'
import { isExpired } from '../enterprise/batchService'
import { capacityCheck } from './fleetService'
import { currencySymbol } from '../../utils/formatters'

const read = (k, f = []) => storage.getItem(k, f) ?? f
const SALE = (o) => !['DRAFT', 'CANCELLED', 'REJECTED'].includes(o.orderStatus)
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100

/** Period from a picker value: { type: 'month'|'quarter'|'year'|'custom'|'preset', value, from, to }. */
export const periodFrom = (p) => {
  if (!p) return null
  if (p.type === 'custom') return resolveRange('custom', { from: p.from, to: p.to })
  if (p.type === 'preset') return resolveRange(p.value)
  if (p.type === 'quarter') { const [y, q] = String(p.value).split('-'); const s = dayjs(new Date(Number(y), (Number(q.slice(1)) - 1) * 3, 1)); return { key: `q:${p.value}`, start: s, end: s.add(3, 'month').subtract(1, 'day').endOf('day'), label: `Q${q.slice(1)} ${y}` } }
  return resolveSpecific(p.type, p.value)
}
export const defaultPeriods = () => {
  const now = dayjs()
  return { a: { type: 'month', value: now.format('YYYY-MM') }, b: { type: 'month', value: now.subtract(1, 'month').format('YYYY-MM') } }
}

const rows = (list, map) => list.map(map)
const M = (id, label, type, fn, extra = {}) => ({ id, label, type, fn, ...extra })

/** KPI definitions per overview. fn(range, data) → { value, records: [{ id, label, sub, value, link }] }. */
export const OVERVIEWS = [
  { id: 'sales', label: 'Sales', permission: ['orders.view', 'orders.reports'], kpis: [
    M('salesValue', 'Sales value', 'money', (r, d) => { const os = d.orders.filter((o) => SALE(o) && inRange(o.orderDate, r)); return { value: r2(os.reduce((s, o) => s + o.totalAmount, 0)), records: rows(os, (o) => ({ id: o.id, label: o.orderNumber, sub: o.customerName, value: o.totalAmount, link: `/orders/${o.id}` })) } }),
    M('avgOrder', 'Average order value', 'money', (r, d) => { const os = d.orders.filter((o) => SALE(o) && inRange(o.orderDate, r)); return { value: os.length ? r2(os.reduce((s, o) => s + o.totalAmount, 0) / os.length) : 0, records: rows(os, (o) => ({ id: o.id, label: o.orderNumber, sub: o.customerName, value: o.totalAmount, link: `/orders/${o.id}` })) } }),
    M('kgSold', 'Quantity sold (kg)', 'kg', (r, d) => { const its = d.orders.filter((o) => SALE(o) && inRange(o.orderDate, r)).flatMap((o) => o.items.map((it) => ({ o, it }))); return { value: Math.round(its.reduce((s, x) => s + weightOf(d.P[x.it.productId], x.it.orderedQuantity), 0)), records: rows(its, (x) => ({ id: `${x.o.id}-${x.it.id}`, label: x.o.orderNumber, sub: x.it.productName, value: weightOf(d.P[x.it.productId], x.it.orderedQuantity), link: `/orders/${x.o.id}` })) } }),
  ] },
  { id: 'orders', label: 'Orders', permission: ['orders.view', 'orders.mine'], kpis: [
    M('orders', 'Orders placed', 'count', (r, d) => { const os = d.orders.filter((o) => o.orderStatus !== 'DRAFT' && inRange(o.orderDate, r)); return { value: os.length, records: rows(os, (o) => ({ id: o.id, label: o.orderNumber, sub: `${o.customerName} · ${o.orderStatus}`, value: o.totalAmount, link: `/orders/${o.id}` })) } }),
    M('recurring', 'Recurring orders', 'count', (r, d) => { const os = d.orders.filter((o) => o.recurringOrderId && inRange(o.orderDate, r)); return { value: os.length, records: rows(os, (o) => ({ id: o.id, label: o.orderNumber, sub: o.customerName, link: `/orders/${o.id}` })) } }),
    M('cancelled', 'Cancelled / rejected', 'count', (r, d) => { const os = d.orders.filter((o) => ['CANCELLED', 'REJECTED'].includes(o.orderStatus) && inRange(o.orderDate, r)); return { value: os.length, records: rows(os, (o) => ({ id: o.id, label: o.orderNumber, sub: o.orderStatus, link: `/orders/${o.id}` })) } }, { invert: true }),
  ] },
  { id: 'delivery', label: 'Delivery', permission: ['dispatch.view', 'deliveries.view'], kpis: [
    M('delivered', 'Deliveries completed', 'count', (r, d) => { const ds = d.deliveries.filter((x) => ['DELIVERED', 'PARTIALLY_DELIVERED'].includes(x.status) && inRange(x.completedAt, r)); return { value: ds.length, records: rows(ds, (x) => ({ id: x.id, label: x.orderNumber, sub: x.customerName, link: `/dispatch/deliveries/${x.id}` })) } }),
    M('onTime', 'On-time delivery %', 'pct', (r, d) => { const D = Object.fromEntries(d.dispatches.map((x) => [x.id, x])); const ds = d.deliveries.filter((x) => ['DELIVERED', 'PARTIALLY_DELIVERED'].includes(x.status) && inRange(x.completedAt, r)); const ok = ds.filter((x) => D[x.dispatchId] && dayjs(x.completedAt).format('YYYY-MM-DD') <= D[x.dispatchId].dispatchDate); return { value: ds.length ? Math.round((ok.length / ds.length) * 1000) / 10 : 0, records: rows(ds, (x) => ({ id: x.id, label: x.orderNumber, sub: ok.includes(x) ? 'On time' : 'Late', link: `/dispatch/deliveries/${x.id}` })) } }),
    M('failed', 'Failed deliveries', 'count', (r, d) => { const ds = d.deliveries.filter((x) => ['FAILED', 'RETURNED'].includes(x.status) && inRange(x.failedAt || x.completedAt, r)); return { value: ds.length, records: rows(ds, (x) => ({ id: x.id, label: x.orderNumber, sub: x.failureReason || x.status, link: `/dispatch/deliveries/${x.id}` })) } }, { invert: true }),
  ] },
  { id: 'inventory', label: 'Inventory', permission: ['inventory.stock.view', 'inventory.dashboard'], kpis: [
    M('received', 'Quantity received', 'qty', (r, d) => { const ms = d.movements.filter((m) => m.movementType === 'Stock Receipt' && inRange(m.date, r)); return { value: r2(ms.reduce((s, m) => s + m.quantity, 0)), records: rows(ms, (m) => ({ id: m.id, label: m.movementNumber, sub: `${d.P[m.productId]?.name} · ${m.referenceNumber}`, value: m.quantity, link: '/inventory/movements' })) } }),
    M('dispatched', 'Quantity dispatched', 'qty', (r, d) => { const ms = d.movements.filter((m) => m.movementType === 'Stock Dispatch' && inRange(m.date, r)); return { value: r2(ms.reduce((s, m) => s + m.quantity, 0)), records: rows(ms, (m) => ({ id: m.id, label: m.movementNumber, sub: `${d.P[m.productId]?.name} · ${m.orderNumber || ''}`, value: m.quantity, link: '/inventory/movements' })) } }),
    M('scrapped', 'Scrapped value', 'money', (r, d) => { const ss = d.scrap.filter((x) => x.writeOff && inRange(x.writeOff.at, r)); return { value: r2(ss.reduce((s, x) => s + (x.value || 0), 0)), records: rows(ss, (x) => ({ id: x.id, label: x.scrapNumber, sub: `${x.productName} · ${x.reason}`, value: x.value, link: `/inventory/scrap/requests/${x.id}` })) } }, { invert: true }),
    M('expiredNow', 'Expired lots on hand', 'count', (r, d) => { const bs = d.batches.filter((b) => b.quantity > 0 && isExpired(b)); return { value: bs.length, records: rows(bs, (b) => ({ id: b.id, label: b.batchNumber, sub: `${d.P[b.productId]?.name} · ${b.quantity}`, link: '/inventory/expiry' })) } }, { current: true, invert: true }),
  ] },
  { id: 'purchase', label: 'Purchase', permission: ['procurement.po.view'], kpis: [
    M('poValue', 'PO value', 'money', (r, d) => { const ps = d.pos.filter((p) => !['DRAFT', 'CANCELLED', 'REJECTED'].includes(p.status) && inRange(p.orderDate, r)); return { value: r2(ps.reduce((s, p) => s + (p.total || 0), 0)), records: rows(ps, (p) => ({ id: p.id, label: p.number, sub: `${d.V[p.supplierId]?.name || ''} · ${p.status}`, value: p.total, link: `/procurement/purchase-orders/${p.id}` })) } }),
    M('grnAccepted', 'GRN accepted qty', 'qty', (r, d) => { const gs = d.grns.filter((g) => g.status === 'POSTED' && inRange(g.receivedDate, r)); return { value: r2(gs.reduce((s, g) => s + g.lines.reduce((a, l) => a + (Number(l.receivedQty) || 0) - (Number(l.rejectedQty) || 0), 0), 0)), records: rows(gs, (g) => ({ id: g.id, label: g.number, sub: d.V[g.supplierId]?.name, link: `/warehouse/receiving/${g.id}` })) } }),
    M('grnRejected', 'GRN rejected qty', 'qty', (r, d) => { const gs = d.grns.filter((g) => g.status === 'POSTED' && inRange(g.receivedDate, r) && g.lines.some((l) => Number(l.rejectedQty) > 0)); return { value: r2(gs.reduce((s, g) => s + g.lines.reduce((a, l) => a + (Number(l.rejectedQty) || 0), 0), 0)), records: rows(gs, (g) => ({ id: g.id, label: g.number, sub: d.V[g.supplierId]?.name, link: `/warehouse/receiving/${g.id}` })) } }, { invert: true }),
  ] },
  { id: 'vendor', label: 'Vendor quality', permission: ['vendorquality.view', 'suppliers.view'], kpis: [
    M('vendorComplaints', 'Vendor complaints', 'count', (r, d) => { const cs = d.complaints.filter((c) => c.vendorResponsible && inRange(c.createdAt, r)); return { value: cs.length, records: rows(cs, (c) => ({ id: c.id, label: c.number, sub: `${c.type} · ${(c.vendorIds || []).map((x) => d.V[x]?.name).join(', ')}`, link: `/complaints/${c.id}` })) } }, { invert: true }),
    M('alerts', 'Quality alerts', 'count', (r, d) => { const as = d.alerts.filter((a) => inRange(a.createdAt, r)); return { value: as.length, records: rows(as, (a) => ({ id: a.id, label: a.vendorName, sub: `${a.count} complaints`, link: `/vendors/${a.vendorId}` })) } }, { invert: true }),
    M('onWatch', 'Vendors on watch / blocked', 'count', (r, d) => { const vs = d.vendors.filter((v) => v.status !== 'Active'); return { value: vs.length, records: rows(vs, (v) => ({ id: v.id, label: v.name, sub: v.status, link: `/vendors/${v.id}` })) } }, { current: true, invert: true }),
  ] },
  { id: 'finance', label: 'Finance', permission: ['finance.view', 'invoices.view', 'finance.ar.view'], kpis: [
    M('invoiced', 'Invoiced', 'money', (r, d) => { const is = d.invoices.filter((i) => !['CANCELLED', 'DRAFT'].includes(i.status) && inRange(i.invoiceDate, r)); return { value: r2(is.reduce((s, i) => s + (i.totals?.grandTotal || 0), 0)), records: rows(is, (i) => ({ id: i.id, label: i.invoiceNumber, sub: i.orderNumber, value: i.totals?.grandTotal, link: `/invoices/${i.id}` })) } }),
    M('collected', 'Collections', 'money', (r, d) => { const ps = d.payments.filter((p) => p.status === 'POSTED' && inRange(p.paymentDate, r)); return { value: r2(ps.reduce((s, p) => s + (Number(p.amount) || 0), 0)), records: rows(ps, (p) => ({ id: p.id, label: p.number, sub: `${d.C[p.customerId]?.name || ''} · ${p.method}`, value: p.amount, link: `/finance/payments/${p.id}` })) } }),
    M('outstanding', 'Outstanding (open invoices)', 'money', () => { const bs = invoiceBalances().filter((b) => b.balance > 0); return { value: r2(bs.reduce((s, b) => s + b.balance, 0)), records: rows(bs, (b) => ({ id: b.id, label: b.invoiceNumber, sub: b.overdueDays ? `${b.overdueDays} d overdue` : 'Not due', value: b.balance, link: `/invoices/${b.id}` })) } }, { current: true, invert: true }),
  ] },
  { id: 'fleet', label: 'Fleet', permission: ['fleet.view', 'dispatch.view'], kpis: [
    M('dispatches', 'Dispatches', 'count', (r, d) => { const ds = d.dispatches.filter((x) => x.status !== 'CANCELLED' && inRange(x.dispatchDate, r)); return { value: ds.length, records: rows(ds, (x) => ({ id: x.id, label: x.dispatchNumber, sub: `${x.vehicleNumber || '—'} · ${x.status}`, link: `/dispatch/${x.id}` })) } }),
    M('utilisation', 'Avg weight utilisation %', 'pct', (r, d) => { const ds = d.dispatches.filter((x) => x.vehicleId && x.status !== 'CANCELLED' && inRange(x.dispatchDate, r)); const pcts = ds.map((x) => capacityCheck(d.VE[x.vehicleId], x.orderIds.map((o) => d.O[o]).filter(Boolean)).usage[0].pct || 0); return { value: pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : 0, records: rows(ds, (x, i) => ({ id: x.id, label: x.dispatchNumber, sub: `${pcts[i]}% of ${x.vehicleNumber}`, link: `/dispatch/${x.id}` })) } }),
    M('replacements', 'Vehicle replacements', 'count', (r, d) => { const rs = d.dispatches.flatMap((x) => (x.vehicleReplacements || []).filter((v) => inRange(v.at, r)).map((v) => ({ ...v, dispatchId: x.id }))); return { value: rs.length, records: rows(rs, (v) => ({ id: v.id, label: v.dispatchNumber, sub: `${v.fromVehicleNumber} → ${v.toVehicleNumber} · ${v.reason}`, link: `/dispatch/${v.dispatchId}` })) } }, { invert: true }),
  ] },
  { id: 'customer', label: 'Customer', permission: ['customers.view'], kpis: [
    M('activeCustomers', 'Ordering customers', 'count', (r, d) => { const ids = [...new Set(d.orders.filter((o) => SALE(o) && inRange(o.orderDate, r)).map((o) => o.customerId))]; return { value: ids.length, records: ids.map((id) => ({ id, label: d.C[id]?.name || id, sub: d.C[id]?.city, link: `/customers/${id}` })) } }),
    M('newCustomers', 'New customers', 'count', (r, d) => { const cs = d.customers.filter((c) => inRange(c.createdAt, r)); return { value: cs.length, records: rows(cs, (c) => ({ id: c.id, label: c.name, sub: c.code, link: `/customers/${c.id}` })) } }),
    M('complaints', 'Complaints', 'count', (r, d) => { const cs = d.complaints.filter((c) => inRange(c.createdAt, r)); return { value: cs.length, records: rows(cs, (c) => ({ id: c.id, label: c.number, sub: `${c.customerName} · ${c.type}`, link: `/complaints/${c.id}` })) } }, { invert: true }),
  ] },
]

const loadData = () => {
  const idx = (l) => Object.fromEntries(l.map((x) => [x.id, x]))
  const d = {
    orders: read(K.ORDERS), deliveries: read(K.DELIVERIES), dispatches: read(K.DISPATCHES), movements: read(K.STOCK_MOVEMENTS), scrap: read(K.SCRAP_REQUESTS), batches: read(K.BATCHES),
    pos: read(K.PURCHASE_ORDERS), grns: read(K.GOODS_RECEIPTS), complaints: read(K.COMPLAINTS), alerts: read(K.VENDOR_QUALITY_ALERTS), vendors: read(K.VENDORS),
    invoices: read(K.INVOICES), payments: read(K.CUSTOMER_PAYMENTS), customers: read(K.CUSTOMERS), products: read(K.PRODUCTS), vehicles: read(K.VEHICLES),
  }
  return { ...d, P: idx(d.products), V: idx(d.vendors), C: idx(d.customers), O: idx(d.orders), VE: idx(d.vehicles) }
}

/** Compute every KPI of the given overviews for both periods. */
export const comparePeriods = (rangeA, rangeB, overviewIds = null) => {
  const d = loadData()
  return OVERVIEWS.filter((o) => !overviewIds || overviewIds.includes(o.id)).map((o) => ({
    ...o,
    kpis: o.kpis.map((k) => {
      const a = k.fn(rangeA, d)
      const b = k.current ? a : k.fn(rangeB, d)
      return { ...k, a, b, cmp: k.current ? null : compareValues(a.value, b.value) }
    }),
  }))
}

/* ---------- KPI display formats ---------- */
export const KPI_FORMATS = [
  { value: 'compact', label: 'Compact (12.3L)' }, { value: 'full', label: 'Full (12,34,567)' }, { value: 'currencyExact', label: 'Currency + exact' },
  { value: 'number', label: 'Number only' }, { value: 'percentage', label: 'Percentage (A vs B)' }, { value: 'quantity', label: 'Quantity / KG' },
]
const compactIn = (n) => {
  const a = Math.abs(n)
  if (a >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`
  if (a >= 1e5) return `${(n / 1e5).toFixed(2)}L`
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(Math.round(n * 100) / 100)
}
export const formatKpi = (value, type, format, { cmp = null, symbol = currencySymbol() } = {}) => {
  const n = Number(value) || 0
  const full = n.toLocaleString('en-IN', { maximumFractionDigits: 2 })
  if (format === 'percentage' && cmp) return cmp.pct === null ? (cmp.diff ? 'new' : '0%') : `${cmp.pct > 0 ? '+' : ''}${cmp.pct.toFixed(1)}%`
  if (type === 'pct') return `${n}%`
  if (format === 'number') return full
  if (format === 'quantity') return type === 'kg' || type === 'qty' ? `${full} ${type === 'kg' ? 'kg' : 'units'}` : type === 'money' ? `${symbol}${full}` : full
  if (type === 'money') {
    if (format === 'full') return `${symbol}${full}`
    if (format === 'currencyExact') return `${symbol}${compactIn(n)} (${symbol}${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`
    return `${symbol}${compactIn(n)}`
  }
  if (type === 'kg') return format === 'full' ? `${full} kg` : `${compactIn(n)} kg`
  return format === 'full' || format === 'currencyExact' ? full : compactIn(n)
}
