/**
 * Advanced ERP reports (data v11) — same definition shape as every report in the Reports Center
 * (services/reportService), so they get the same viewer, filters, export, favourites and permission checks.
 * Every figure is computed from LocalStorage records; nothing is hard-coded.
 */
import dayjs from 'dayjs'
import { STORAGE_KEYS as K } from '../../utils/constants'
import storage from '../storageService'
import { batchLifecycle, batchQuantities, lotSource } from '../../utils/batchAllocation'
import { expiryRows } from './stockControlService'
import { vendorScorecard, visibleComplaints, COMPLAINT_STATUS } from './complaintService'
import { effectiveSalesman, personName } from './salesAssignmentService'
import { visibleRecurring, RECURRING_STATUS } from './recurringService'
import { capacityCheck } from './fleetService'

const read = (k, f = []) => storage.getItem(k, f) ?? f
const col = (key, label, type = 'text', extra = {}) => ({ key, label, type, ...extra })
const money = (key, label) => col(key, label, 'currency', { sum: true })
const qty = (key, label) => col(key, label, 'number', { sum: true })
const day = (iso) => (iso ? dayjs(iso).format('YYYY-MM-DD') : '')
const idx = (k) => Object.fromEntries(read(k).map((x) => [x.id, x]))

export const ERP_REPORTS = [
  /* Purchasing / traceability */
  { id: 'po-invoice-traceability', category: 'purchasing', title: 'PO ↔ Invoice Traceability', popular: true, permission: ['procurement.po.view', 'invoices.view', 'inventory.batch.view'],
    description: 'For every customer invoice line: which batch, purchase order, goods receipt and vendor the goods came from (batch allocations, snapshot at invoice issue).',
    columns: [col('invoice', 'Invoice'), col('invoiceDate', 'Invoice date', 'date'), col('customer', 'Customer'), col('product', 'Product'), col('batchNumber', 'Batch'), qty('quantity', 'Qty'), col('expiry', 'Expiry', 'date'), col('poNumber', 'PO'), col('grnNumber', 'GRN'), col('vendor', 'Vendor')],
    rows: () => {
      const C = idx(K.CUSTOMERS); const P = idx(K.PRODUCTS); const V = idx(K.VENDORS)
      return read(K.INVOICES).filter((i) => i.status !== 'CANCELLED').flatMap((i) => (i.sourceBatches || []).map((b, n) => ({ id: `${i.id}-${n}`, link: `/invoices/${i.id}`, invoice: i.invoiceNumber, invoiceDate: i.invoiceDate, customer: C[i.customerId]?.name, product: P[b.productId]?.name, batchNumber: b.batchNumber, quantity: b.quantity, expiry: b.expiryDate, poNumber: b.poNumber || '— (opening / internal)', grnNumber: b.grnNumber || '', vendor: V[b.vendorId]?.name || '' })))
    } },
  { id: 'batch-lifecycle', category: 'purchasing', title: 'Batch Lifecycle', permission: ['inventory.batch.view', 'procurement.po.view'],
    description: 'Every batch from receipt to its outcome: received, available, dispatched (sold), returned by customers, scrapped and returned to the vendor.',
    columns: [col('batchNumber', 'Batch'), col('product', 'Product'), col('hub', 'Hub'), col('source', 'Source'), col('poNumber', 'PO'), col('vendor', 'Vendor'), col('expiry', 'Expiry', 'date'), qty('received', 'Received'), qty('available', 'Available'), qty('dispatched', 'Sold'), qty('returned', 'Customer returns'), qty('scrapped', 'Scrapped'), qty('returnedToVendor', 'To vendor'), col('status', 'Status', 'badge')],
    rows: () => {
      const P = idx(K.PRODUCTS); const H = idx(K.HUBS); const V = idx(K.VENDORS); const G = idx(K.GOODS_RECEIPTS); const PO = idx(K.PURCHASE_ORDERS)
      return read(K.BATCHES).map((b) => { const s = lotSource(b, G, PO); const q = batchQuantities(b); return { id: b.id, link: `/inventory/batches?q=${encodeURIComponent(b.batchNumber)}`, batchNumber: b.batchNumber, product: P[b.productId]?.name, hub: H[b.hubId]?.name, source: b.sourceType, poNumber: s.poNumber || '', vendor: V[s.vendorId]?.name || '', expiry: b.expiryDate, received: q.received, available: q.available, dispatched: q.dispatched, returned: q.returned, scrapped: q.scrapped, returnedToVendor: q.returnedToVendor, status: batchLifecycle(b).label } })
    }, chart: { by: 'status', value: 'count' } },
  { id: 'batch-allocations', category: 'inventory', title: 'Batch Allocation Register', permission: 'inventory.batch.view',
    description: 'Which batches each order received (FEFO at dispatch), with the source PO and vendor, net of customer returns.',
    columns: [col('order', 'Order'), col('customer', 'Customer'), col('product', 'Product'), col('batchNumber', 'Batch'), qty('quantity', 'Qty'), col('expiry', 'Expiry', 'date'), col('poNumber', 'PO'), col('vendor', 'Vendor'), col('at', 'Dispatched', 'date')],
    rows: () => { const C = idx(K.CUSTOMERS); const P = idx(K.PRODUCTS); const V = idx(K.VENDORS); return read(K.BATCH_ALLOCATIONS).filter((a) => a.quantity > 0).map((a) => ({ id: a.id, link: `/orders/${a.orderId}`, order: a.orderNumber, customer: C[a.customerId]?.name, product: P[a.productId]?.name, batchNumber: a.batchNumber, quantity: a.quantity, expiry: a.expiryDate, poNumber: a.poNumber || '', vendor: V[a.vendorId]?.name || '', at: day(a.firstAt) })) } },
  { id: 'expiry-dashboard', category: 'inventory', title: 'Expiry Report (expired · 7 days · 30 days)', permission: ['inventory.expiry.view', 'inventory.batch.view'],
    description: 'Lots on hand by expiry bucket with value at cost and the scrap request raised for expired lots.',
    columns: [col('batchNumber', 'Batch'), col('product', 'Product'), col('hub', 'Hub'), col('vendor', 'Vendor'), col('expiry', 'Expiry', 'date'), col('days', 'Days left', 'number'), qty('quantity', 'Qty'), money('value', 'Value'), col('bucket', 'Bucket', 'badge'), col('scrap', 'Scrap request')],
    rows: () => expiryRows().filter((r) => r.bucket !== 'OK').map((r) => ({ id: r.id, link: '/inventory/expiry', batchNumber: r.batchNumber, product: r.productName, hub: r.hubName, vendor: r.vendorName, expiry: r.expiryDate, days: r.days, quantity: r.quantity, value: r.value, bucket: { EXPIRED: 'Expired', D7: '≤ 7 days', D30: '≤ 30 days' }[r.bucket], scrap: r.scrapNumber ? `${r.scrapNumber} (${r.scrapStatus})` : '' })),
    chart: { by: 'bucket', value: 'value' } },
  { id: 'purchase-returns', category: 'purchasing', title: 'Returns to Vendor', permission: ['procurement.po.view', 'purchase.returns.manage'],
    description: 'Stock returned to vendors (PO returns) with batch, quantity, value and reason.',
    columns: [col('number', 'Return no.'), col('date', 'Date', 'date'), col('vendor', 'Vendor'), col('poNumber', 'Original PO'), col('batchNumber', 'Batch'), col('product', 'Product'), qty('quantity', 'Qty'), money('value', 'Value'), col('reason', 'Reason')],
    rows: () => read(K.PURCHASE_RETURNS).map((r) => ({ id: r.id, number: r.number, date: day(r.createdAt), vendor: r.vendorName, poNumber: r.poNumber || '', batchNumber: r.batchNumber, product: r.productName, quantity: r.quantity, value: r.value, reason: r.reason })) },

  /* Supplier / vendor quality */
  { id: 'vendor-complaints', category: 'supplier', title: 'Vendor Complaint Analysis', popular: true, permission: ['vendorquality.view', 'suppliers.view'],
    description: 'Vendor-responsible complaints per vendor: total, last 30 days, complaint rate against quantity supplied, batches affected and alerts.',
    columns: [col('vendor', 'Vendor'), col('status', 'Status', 'badge'), col('total', 'Complaints', 'number', { sum: true }), col('last30', 'Last 30 days', 'number', { sum: true }), qty('supplied', 'Qty supplied'), qty('complained', 'Qty complained'), col('rate', 'Complaint rate %', 'percent'), col('types', 'Types'), col('batches', 'Batches'), col('alerts', 'Alerts', 'number')],
    rows: () => read(K.VENDORS).map((v) => { const s = vendorScorecard(v.id); return { id: v.id, link: `/vendors/${v.id}`, vendor: v.name, status: v.status, total: s.total, last30: s.last30, supplied: s.suppliedQty, complained: s.complainedQty, rate: s.rate, types: s.types.map((t) => `${t.type} ${t.count}`).join(', '), batches: s.batches.join(', '), alerts: s.alerts.length } }).sort((a, b) => b.total - a.total),
    chart: { by: 'vendor', value: 'total' } },
  { id: 'vendor-master', category: 'supplier', title: 'Vendor Master', permission: 'suppliers.view',
    description: 'Vendors with code, GSTIN, contact, payment terms, products supplied and status.',
    columns: [col('code', 'Code'), col('vendor', 'Vendor'), col('gst', 'GSTIN'), col('contact', 'Contact'), col('mobile', 'Mobile'), col('terms', 'Payment terms'), col('products', 'Products', 'number'), col('leadTime', 'Lead time (d)', 'number'), col('status', 'Status', 'badge')],
    rows: () => read(K.VENDORS).map((v) => ({ id: v.id, link: `/vendors/${v.id}`, code: v.code, vendor: v.name, gst: v.gstNumber, contact: v.contactPerson, mobile: v.mobile, terms: v.paymentTerms, products: (v.productsSupplied || []).length, leadTime: v.leadTimeDays, status: v.status })) },

  /* Customer service */
  { id: 'complaint-register', category: 'service', title: 'Complaint Register', popular: true, permission: 'complaints.view',
    description: 'Customer complaints with order, product, batch, vendor, type, status and resolution.',
    columns: [col('number', 'Complaint'), col('date', 'Date', 'date'), col('customer', 'Customer'), col('order', 'Order'), col('product', 'Product'), qty('quantity', 'Qty'), col('batches', 'Batch'), col('vendor', 'Vendor'), col('type', 'Type'), col('vendorResponsible', 'Vendor resp.'), col('status', 'Status', 'badge'), col('resolution', 'Resolution')],
    rows: (ctx) => { const V = idx(K.VENDORS); return visibleComplaints(ctx.user).map((c) => ({ id: c.id, link: `/complaints/${c.id}`, number: c.number, date: c.complaintDate, customer: c.customerName, order: c.orderNumber, product: c.productName, quantity: c.quantity, batches: (c.batchNumbers || []).join(', '), vendor: (c.vendorIds || []).map((x) => V[x]?.name).join(', '), type: c.type, vendorResponsible: c.vendorResponsible ? 'Yes' : 'No', status: COMPLAINT_STATUS[c.status]?.label, resolution: c.resolution || '' })) },
    chart: { by: 'type', value: 'count' } },

  /* Sales */
  { id: 'recurring-orders', category: 'sales', title: 'Recurring Orders', permission: 'recurring.view',
    description: 'Recurring schedules with frequency, slots, generated orders and status.',
    columns: [col('number', 'Schedule'), col('customer', 'Customer'), col('frequency', 'Frequency'), col('slots', 'Slots', 'number'), col('start', 'Start', 'date'), col('end', 'End', 'date'), col('generated', 'Orders generated', 'number', { sum: true }), col('last', 'Last generated', 'date'), col('status', 'Status', 'badge')],
    rows: (ctx) => { const C = idx(K.CUSTOMERS); const orders = read(K.ORDERS); return visibleRecurring(ctx.user).map((r) => ({ id: r.id, link: `/orders/recurring/${r.id}`, number: r.number, customer: C[r.customerId]?.name, frequency: r.frequency, slots: (r.slots || []).length, start: r.startDate, end: r.endDate, generated: orders.filter((o) => o.recurringOrderId === r.id).length, last: day(r.lastGeneratedAt), status: RECURRING_STATUS[r.status]?.label })) } },
  { id: 'salesman-coverage', category: 'sales', title: 'Salesman Coverage', permission: ['customers.view', 'customers.assignment.manage'],
    description: 'Primary and secondary salesman per customer, who covers today and why (leave, resignation, inactive).',
    columns: [col('customer', 'Customer'), col('primary', 'Primary'), col('secondary', 'Secondary'), col('effective', 'Covering today'), col('role', 'Coverage', 'badge'), col('reason', 'Reason')],
    rows: () => read(K.CUSTOMERS).filter((c) => c.status !== 'Inactive').map((c) => { const e = effectiveSalesman(c); return { id: c.id, link: `/customers/${c.id}`, customer: c.name, primary: personName(c.salesRepId), secondary: c.secondarySalesRepId ? personName(c.secondarySalesRepId) : '—', effective: personName(e.salesmanId), role: { primary: 'Primary', secondary: 'Secondary (fallback)', manager: 'Sales Manager (reassign)' }[e.role], reason: e.reason } }) },

  /* Dispatch & fleet */
  { id: 'vehicle-replacements', category: 'fleet', title: 'Vehicle Replacements', permission: ['fleet.view', 'dispatch.view'],
    description: 'Every vehicle replacement on a dispatch: original and replacement vehicle, reason, driver, user and time.',
    columns: [col('at', 'Date', 'datetime'), col('dispatch', 'Dispatch'), col('from', 'Original vehicle'), col('to', 'Replacement'), col('reason', 'Reason'), col('remarks', 'Remarks'), col('driver', 'Driver'), col('by', 'By')],
    rows: () => read(K.DISPATCHES).flatMap((d) => (d.vehicleReplacements || []).map((r) => ({ id: r.id, link: `/dispatch/${d.id}`, at: r.at, dispatch: d.dispatchNumber, from: r.fromVehicleNumber, to: r.toVehicleNumber, reason: r.reason, remarks: r.remarks, driver: r.driverName, by: r.byName }))) },
  { id: 'capacity-utilisation', category: 'dispatch', title: 'Vehicle Capacity Utilisation', permission: ['dispatch.view', 'dispatch.reports'],
    description: 'Weight, volume and stops loaded per dispatch against the vehicle limits.',
    columns: [col('dispatch', 'Dispatch'), col('date', 'Date', 'date'), col('vehicle', 'Vehicle'), qty('weight', 'Weight (kg)'), col('weightPct', 'Weight %', 'percent'), col('volumePct', 'Volume %', 'percent'), col('stops', 'Stops', 'number'), col('stopsPct', 'Stops %', 'percent'), col('status', 'Status', 'badge')],
    rows: () => { const O = idx(K.ORDERS); const VE = idx(K.VEHICLES); return read(K.DISPATCHES).filter((d) => d.vehicleId && d.status !== 'CANCELLED').map((d) => { const c = capacityCheck(VE[d.vehicleId], d.orderIds.map((x) => O[x]).filter(Boolean)); const u = Object.fromEntries(c.usage.map((x) => [x.key, x])); return { id: d.id, link: `/dispatch/${d.id}`, dispatch: d.dispatchNumber, date: d.dispatchDate, vehicle: d.vehicleNumber, weight: c.load.weight, weightPct: u.weight.pct ?? 0, volumePct: u.volume.pct ?? 0, stops: c.load.stops, stopsPct: u.stops.pct ?? 0, status: d.status } }) } },
  { id: 'driver-availability', category: 'fleet', title: 'Driver Availability & Offline Periods', permission: ['dispatch.view', 'fleet.view'],
    description: 'Offline / leave periods, suspensions and admin overrides per driver.',
    columns: [col('driver', 'Driver'), col('hub', 'Hub'), col('type', 'Type'), col('from', 'From', 'datetime'), col('to', 'To', 'datetime'), col('reason', 'Reason'), col('remarks', 'Remarks')],
    rows: () => { const H = idx(K.HUBS); return read(K.DRIVERS).flatMap((d) => [...(d.offlinePeriods || []).map((p) => ({ id: p.id, driver: d.name, hub: H[d.hubId]?.name, type: p.type, from: p.from, to: p.to, reason: p.reason, remarks: p.remarks })), ...(d.availabilityOverrides || []).map((o) => ({ id: o.id, driver: d.name, hub: H[d.hubId]?.name, type: 'Admin override', from: o.date, to: o.date, reason: o.reason, remarks: `by ${o.byName}` }))]) } },
]
