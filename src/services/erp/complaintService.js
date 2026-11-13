/**
 * Customer complaints (data v11, bellomassi_complaints) and vendor quality.
 *
 * A complaint is raised against ONE line of a Delivered / Partially Delivered order, within the complaint window
 * (default 7 days after delivery, ERP settings). Batch, PO and vendor are filled automatically from the order's batch
 * allocations; when the line was served from several batches the user selects which batch(es) and how much of each
 * (split). Workflow: Open → Under Investigation → Resolved | Rejected → Closed. Resolution (remarks required):
 *   Replacement → a linked no-charge replacement order (normal approval / dispatch flow)
 *   Credit Note → a credit note against the order's invoice (Finance approves it; that reduces the balance)
 *   Refund     → a refund voucher request recorded on the complaint and sent to Finance
 *   No Action  → closed with the reason
 * Permissions: Customer Service create / investigate / resolve · Salesman raise (own customers) · Admin full ·
 * Sales Manager and Finance view.
 *
 * Vendor quality: complaints marked vendorResponsible count against each vendor of their batches. When a vendor
 * reaches the threshold (default 3 in 30 days) an alert is recorded once per window, Admin (and the Sales Manager
 * if configured) is notified and the vendor goes On Watch; Admin may block the vendor.
 */
import dayjs from 'dayjs'
import storage from '../storageService'
import { STORAGE_KEYS as K } from '../../utils/constants'
import { can } from '../../config/permissions'
import { getCurrentUser } from '../authService'
import { logAudit } from '../auditService'
import { pushNotification } from '../notificationService'
import { uid } from '../../utils/helpers'
import { submitOrder, deliveryFromCustomer } from '../orderService'
import { createRecord } from '../enterprise/recordService'
import { setVendorStatus } from './vendorService'

const read = (k, f = []) => storage.getItem(k, f) ?? f
const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000
export const COMPLAINT_TYPES = ['Quality', 'Expired', 'Near Expiry', 'Damaged', 'Short Quantity', 'Wrong Product', 'Other']
export const VENDOR_TYPES = ['Quality', 'Expired', 'Near Expiry']
export const RESOLUTIONS = [
  { value: 'REPLACEMENT', label: 'Replacement order' }, { value: 'CREDIT_NOTE', label: 'Credit note' }, { value: 'REFUND', label: 'Refund' }, { value: 'NO_ACTION', label: 'No action' },
]
export const COMPLAINT_STATUS = {
  OPEN: { label: 'Open', tone: 'warning' }, UNDER_INVESTIGATION: { label: 'Under investigation', tone: 'info' },
  RESOLVED: { label: 'Resolved', tone: 'success' }, REJECTED: { label: 'Rejected', tone: 'danger' }, CLOSED: { label: 'Closed', tone: 'neutral' },
}
const DELIVERED = ['DELIVERED', 'PARTIALLY_DELIVERED']
const settings = () => read(K.ERP_SETTINGS, {}) || {}
export const complaintWindowDays = () => Number(settings().complaints?.windowDays) || 7

export const getComplaints = () => read(K.COMPLAINTS)
export const getComplaintById = (id, list = getComplaints()) => list.find((c) => c.id === id) || null

const ownCustomerIds = (user) => new Set(read(K.CUSTOMERS).filter((c) => c.salesRepId === user.id || c.secondarySalesRepId === user.id).map((c) => c.id))
const isSalesScope = (user) => ['SALESMAN', 'HORECA_SALES_EXEC', 'VAN_SALES_EXEC'].includes(user?.role)

/** Complaints visible to a user (salesmen: their customers; customers: their own account). */
export const visibleComplaints = (user = getCurrentUser(), list = getComplaints()) => {
  if (!user) return []
  if (user.role === 'CUSTOMER') return list.filter((c) => c.customerId === user.customerId)
  if (!can(user, 'complaints.view')) return []
  if (isSalesScope(user)) { const mine = ownCustomerIds(user); return list.filter((c) => mine.has(c.customerId) || c.raisedBy === user.id) }
  return list
}
export const canViewComplaint = (user, c) => visibleComplaints(user, [c]).length === 1

const deliveredAt = (o) => o.deliveredAt || read(K.DELIVERIES).filter((d) => d.orderId === o.id && d.completedAt).map((d) => d.completedAt).sort().pop() || null

/** Why an order cannot take a complaint (null when it can). */
export const complaintBlockReason = (o, now = dayjs()) => {
  if (!o) return 'Select an order.'
  if (!DELIVERED.includes(o.orderStatus)) return `${o.orderNumber} is ${String(o.orderStatus).toLowerCase().replace(/_/g, ' ')} — complaints can be raised only for delivered or partially delivered orders.`
  const at = deliveredAt(o)
  const days = complaintWindowDays()
  if (at && now.diff(dayjs(at), 'day', true) > days) return `${o.orderNumber} was delivered on ${dayjs(at).format('DD MMM YYYY')} — the ${days}-day complaint window has closed.`
  return null
}

/** Orders the user may raise a complaint against. */
export const eligibleOrders = (user = getCurrentUser()) => {
  const orders = read(K.ORDERS).filter((o) => !complaintBlockReason(o))
  if (user?.role === 'CUSTOMER') return orders.filter((o) => o.customerId === user.customerId)
  if (isSalesScope(user)) { const mine = ownCustomerIds(user); return orders.filter((o) => mine.has(o.customerId) || o.salesmanId === user.id) }
  return orders
}

/** Lines of an order with delivered quantity and the batches (allocations) that served them. */
export const complaintLines = (orderId) => {
  const o = read(K.ORDERS).find((x) => x.id === orderId)
  if (!o) return []
  const allocs = read(K.BATCH_ALLOCATIONS).filter((a) => a.orderId === orderId && a.quantity > 0)
  const deliveries = read(K.DELIVERIES).filter((d) => d.orderId === orderId && DELIVERED.includes(d.status))
  const V = Object.fromEntries(read(K.VENDORS).map((v) => [v.id, v]))
  const already = getComplaints().filter((c) => c.orderId === orderId && c.status !== 'REJECTED')
  return o.items.map((it) => {
    const delivered = r3(deliveries.reduce((s, d) => s + (Number(d.items?.find((l) => l.orderItemId === it.id)?.deliveredQuantity) || 0), 0)) || (o.orderStatus === 'DELIVERED' ? r3(it.orderedQuantity) : 0)
    const complained = r3(already.filter((c) => c.orderItemId === it.id).reduce((s, c) => s + c.quantity, 0))
    return {
      ...it, delivered, complained, open: r3(Math.max(0, delivered - complained)),
      batches: allocs.filter((a) => a.productId === it.productId).map((a) => ({ batchId: a.batchId, batchNumber: a.batchNumber, quantity: a.quantity, expiryDate: a.expiryDate, poId: a.poId, poNumber: a.poNumber, grnNumber: a.grnNumber, vendorId: a.vendorId, vendorName: V[a.vendorId]?.name || '' })),
    }
  })
}

const nextNumber = (list) => {
  const y = dayjs().format('YYYY')
  const n = list.map((c) => String(c.number || '')).filter((x) => x.startsWith(`CMP-${y}-`)).map((x) => Number(x.split('-').pop()) || 0).reduce((a, b) => Math.max(a, b), 0) + 1
  return `CMP-${y}-${String(n).padStart(4, '0')}`
}
const hist = (user, action, from, to, note = '') => ({ id: uid('cmh'), at: new Date().toISOString(), by: user?.id || 'system', byName: user?.name || 'System', action, from, to, note })

/**
 * Raise a complaint. values: { orderId, orderItemId, type, description, quantity, batches: [{ batchId, quantity }],
 * photos: [{ name, dataUrl }], contactName, contactPhone, complaintDate }.
 */
export const createComplaint = (values) => {
  const user = getCurrentUser()
  const customerSelf = user?.role === 'CUSTOMER'
  if (!can(user, 'complaints.create') && !customerSelf) return { ok: false, error: 'You do not have permission to raise complaints.' }
  const e = {}
  const o = read(K.ORDERS).find((x) => x.id === values.orderId)
  const why = complaintBlockReason(o)
  if (why) e.orderId = why
  if (o && customerSelf && o.customerId !== user.customerId) e.orderId = 'You can raise complaints only for your own orders.'
  if (o && isSalesScope(user) && !ownCustomerIds(user).has(o.customerId) && o.salesmanId !== user.id) e.orderId = 'You can raise complaints only for your own customers.'
  const line = o && !why ? complaintLines(o.id).find((l) => l.id === values.orderItemId) : null
  if (o && !why && !line) e.orderItemId = 'Select the order line.'
  if (!COMPLAINT_TYPES.includes(values.type)) e.type = 'Choose the complaint type.'
  if (String(values.description || '').trim().length < 10) e.description = 'Describe the problem (at least 10 characters).'
  const q = r3(values.quantity)
  if (!(q > 0)) e.quantity = 'Enter the affected quantity.'
  else if (line && q > line.open) e.quantity = `Only ${line.open} ${line.unit} of this line is still open for complaints (delivered ${line.delivered}, already in complaints ${line.complained}).`
  const photos = values.photos || []
  if ((settings().complaints?.requirePhotosFor || []).includes(values.type) && !photos.length) e.photos = `Add at least one photo for a ${values.type.toLowerCase()} complaint.`
  if (photos.some((f) => String(f.dataUrl || '').length > 450 * 1024)) e.photos = 'Each photo must be under 300 KB.'
  // Batch selection / split
  let batches = []
  if (line && !e.quantity) {
    const sel = (values.batches || []).filter((b) => Number(b.quantity) > 0)
    if (line.batches.length === 1 && !sel.length) batches = [{ ...line.batches[0], quantity: q }]
    else if (line.batches.length > 1) {
      if (!sel.length) e.batches = 'This line was served from several batches — choose the affected batch(es) and quantities.'
      else {
        const total = r3(sel.reduce((s, b) => s + Number(b.quantity), 0))
        if (total !== q) e.batches = `Batch quantities (${total}) must add up to the complaint quantity (${q}).`
        sel.forEach((b) => {
          const a = line.batches.find((x) => x.batchId === b.batchId)
          if (!a) e.batches = 'Choose batches that served this line.'
          else if (Number(b.quantity) > a.quantity) e.batches = `Batch ${a.batchNumber} supplied only ${a.quantity} ${line.unit}.`
        })
        batches = sel.map((b) => ({ ...line.batches.find((x) => x.batchId === b.batchId), quantity: r3(b.quantity) }))
      }
    }
  }
  if (Object.keys(e).length) return { ok: false, errors: e, error: Object.values(e)[0] }
  const list = getComplaints()
  const now = new Date().toISOString()
  const customer = read(K.CUSTOMERS).find((c) => c.id === o.customerId)
  const invoice = read(K.INVOICES).find((i) => i.orderId === o.id && i.status !== 'CANCELLED')
  const vendorIds = [...new Set(batches.map((b) => b.vendorId).filter(Boolean))]
  const record = {
    id: uid('cmp'), number: nextNumber(list), status: 'OPEN',
    orderId: o.id, orderNumber: o.orderNumber, customerId: o.customerId, customerName: o.customerName, hubId: o.hubId, invoiceId: invoice?.id || null, invoiceNumber: invoice?.invoiceNumber || null,
    orderItemId: line.id, productId: line.productId, productName: line.productName, unit: line.unit, quantity: q, unitPrice: line.unitPrice,
    batches, batchNumbers: batches.map((b) => b.batchNumber), poIds: [...new Set(batches.map((b) => b.poId).filter(Boolean))], poNumbers: [...new Set(batches.map((b) => b.poNumber).filter(Boolean))],
    vendorIds, vendorId: vendorIds[0] || null,
    type: values.type, vendorResponsible: values.vendorResponsible ?? VENDOR_TYPES.includes(values.type),
    description: String(values.description).trim(), photos,
    contactName: String(values.contactName || customer?.contactPerson || '').trim(), contactPhone: String(values.contactPhone || customer?.mobile || '').trim(),
    complaintDate: values.complaintDate || dayjs().format('YYYY-MM-DD'), deliveredAt: deliveredAt(o),
    raisedBy: user.id, raisedByName: user.name, assignedTo: null, resolution: null, resolutionRemarks: '', linkedOrderId: null, linkedOrderNumber: null, creditNoteId: null, creditNoteNumber: null, refund: null,
    createdAt: now, updatedAt: now, history: [hist(user, 'Raised', null, 'OPEN', values.type)],
  }
  const res = storage.setItem(K.COMPLAINTS, [record, ...list])
  if (!res.ok) return { ok: false, error: res.error }
  logAudit({ module: 'service', action: 'Complaint raised', entity: 'Complaint', recordId: record.id, recordLabel: record.number, description: `${record.type} · ${record.productName} · ${q} ${record.unit} · ${o.orderNumber}` })
  pushNotification({ title: `Complaint ${record.number}: ${record.type}`, message: `${record.customerName} · ${record.productName} (${q} ${record.unit})${record.batchNumbers.length ? ` · batch ${record.batchNumbers.join(', ')}` : ''}.`, type: 'warning', roles: ['CUSTOMER_SERVICE', 'ADMIN', 'QA_MANAGER'], link: `/complaints/${record.id}`, category: 'service' })
  checkVendorQuality(record.vendorIds)
  return { ok: true, record }
}

const transition = (id, to, { from, note = '', patch = {}, requireNote = false, permission = 'complaints.manage' }) => {
  const user = getCurrentUser()
  if (!can(user, permission)) return { ok: false, error: 'You do not have permission to change complaints.' }
  const list = getComplaints()
  const c = getComplaintById(id, list)
  if (!c) return { ok: false, error: 'This complaint no longer exists.' }
  if (!from.includes(c.status)) return { ok: false, error: `${c.number} is ${COMPLAINT_STATUS[c.status].label.toLowerCase()}.` }
  if (requireNote && String(note).trim().length < 5) return { ok: false, error: 'Enter remarks (at least 5 characters).' }
  const record = { ...c, ...patch, status: to, updatedAt: new Date().toISOString(), history: [...c.history, hist(user, COMPLAINT_STATUS[to].label, c.status, to, note)] }
  const res = storage.setItem(K.COMPLAINTS, list.map((x) => (x.id === id ? record : x)))
  if (!res.ok) return { ok: false, error: res.error }
  logAudit({ module: 'service', action: `Complaint ${COMPLAINT_STATUS[to].label.toLowerCase()}`, entity: 'Complaint', recordId: id, recordLabel: c.number, description: note })
  return { ok: true, record }
}

export const startInvestigation = (id, { note = '', vendorResponsible } = {}) => {
  const res = transition(id, 'UNDER_INVESTIGATION', { from: ['OPEN'], note, patch: { assignedTo: getCurrentUser()?.id, assignedToName: getCurrentUser()?.name, ...(vendorResponsible !== undefined ? { vendorResponsible } : {}) } })
  if (res.ok) checkVendorQuality(res.record.vendorIds)
  return res
}

/** Mark whether the vendor is responsible (counts toward vendor quality). */
export const setVendorResponsible = (id, value, note = '') => {
  const user = getCurrentUser()
  if (!can(user, 'complaints.manage')) return { ok: false, error: 'You do not have permission to change complaints.' }
  const list = getComplaints()
  const c = getComplaintById(id, list)
  if (!c) return { ok: false, error: 'This complaint no longer exists.' }
  const record = { ...c, vendorResponsible: Boolean(value), updatedAt: new Date().toISOString(), history: [...c.history, hist(user, value ? 'Vendor responsible' : 'Not vendor responsible', c.status, c.status, note)] }
  storage.setItem(K.COMPLAINTS, list.map((x) => (x.id === id ? record : x)))
  checkVendorQuality(c.vendorIds)
  return { ok: true, record }
}

export const rejectComplaint = (id, note) => transition(id, 'REJECTED', { from: ['OPEN', 'UNDER_INVESTIGATION'], note, requireNote: true, patch: { resolutionRemarks: String(note || '').trim() } })
export const closeComplaint = (id, note = '') => transition(id, 'CLOSED', { from: ['RESOLVED', 'REJECTED'], note })

/** Resolve with Replacement / Credit Note / Refund / No Action (remarks required). */
export const resolveComplaint = (id, { resolution, remarks, refundAmount, refundMode = 'Bank transfer' }) => {
  const user = getCurrentUser()
  if (!can(user, 'complaints.manage')) return { ok: false, error: 'You do not have permission to resolve complaints.' }
  const c = getComplaintById(id)
  if (!c) return { ok: false, error: 'This complaint no longer exists.' }
  if (!['OPEN', 'UNDER_INVESTIGATION'].includes(c.status)) return { ok: false, error: `${c.number} is already ${COMPLAINT_STATUS[c.status].label.toLowerCase()}.` }
  if (!RESOLUTIONS.some((r) => r.value === resolution)) return { ok: false, error: 'Choose the resolution.' }
  if (String(remarks || '').trim().length < 5) return { ok: false, error: 'Enter the resolution remarks (at least 5 characters).' }
  const patch = { resolution, resolutionRemarks: String(remarks).trim(), resolvedAt: new Date().toISOString(), resolvedBy: user.id, resolvedByName: user.name }
  const lineValue = Math.round(c.quantity * (Number(c.unitPrice) || 0) * 100) / 100
  if (resolution === 'REPLACEMENT') {
    if (c.linkedOrderId) return { ok: false, error: `Replacement ${c.linkedOrderNumber} already exists.` }
    const o = read(K.ORDERS).find((x) => x.id === c.orderId)
    const customer = read(K.CUSTOMERS).find((x) => x.id === c.customerId)
    const res = submitOrder(null, {
      orderDate: dayjs().format('YYYY-MM-DD'), orderType: 'Standard', orderPriority: 'Urgent', orderSource: 'complaint',
      customerId: c.customerId, salesmanId: o?.salesmanId || customer?.salesRepId, hubId: o?.hubId || customer?.hubId,
      ...deliveryFromCustomer(customer), deliveryAddress: o?.deliveryAddress || deliveryFromCustomer(customer).deliveryAddress,
      requestedDeliveryDate: dayjs().add(1, 'day').format('YYYY-MM-DD'), deliveryInstructions: `Replacement for complaint ${c.number}`, paymentTerms: 'Cash on Delivery',
      customerReference: c.number, notes: `No-charge replacement for ${c.orderNumber} (${c.type}).`, sourceComplaintId: c.id, confirmDuplicate: true,
      items: [{ key: uid('ln'), productId: c.productId, orderedQuantity: String(c.quantity), discountPercentage: '0', itemNotes: `Replacement · ${c.number}` }],
    })
    if (!res.ok) return { ok: false, error: res.error || Object.values(res.errors || {})[0] }
    patch.linkedOrderId = res.record.id
    patch.linkedOrderNumber = res.record.orderNumber
  }
  if (resolution === 'CREDIT_NOTE') {
    if (c.creditNoteId) return { ok: false, error: `Credit note ${c.creditNoteNumber} already exists.` }
    if (!c.invoiceId) return { ok: false, error: `${c.orderNumber} has no invoice yet — invoice the order first, or choose another resolution.` }
    const vatRate = Number(read(K.ENTERPRISE_SETTINGS, {})?.finance?.vatRate) || 0
    const amount = Math.round((lineValue / (1 + vatRate / 100)) * 100) / 100
    const res = createRecord('credit_notes', { customerId: c.customerId, invoiceId: c.invoiceId, date: dayjs().format('YYYY-MM-DD'), reason: `Complaint ${c.number}: ${c.type} — ${c.productName} ${c.quantity} ${c.unit}`, amount, complaintId: c.id }, user, { system: true })
    if (!res.ok) return { ok: false, error: res.error }
    patch.creditNoteId = res.record.id
    patch.creditNoteNumber = res.record.number
  }
  if (resolution === 'REFUND') {
    const amt = Number(refundAmount ?? lineValue)
    if (!(amt > 0)) return { ok: false, error: 'Enter the refund amount.' }
    if (amt > lineValue + 0.01) return { ok: false, error: `Refund cannot exceed the line value (${lineValue}).` }
    patch.refund = { amount: Math.round(amt * 100) / 100, mode: refundMode, status: 'REQUESTED', requestedAt: new Date().toISOString(), requestedByName: user.name }
    pushNotification({ title: `Refund requested: ${c.number}`, message: `${c.customerName}: ${patch.refund.amount} by ${refundMode}. Pay it and record the voucher in Finance.`, type: 'warning', roles: ['FINANCE', 'ADMIN'], link: `/complaints/${c.id}`, category: 'finance' })
  }
  return transition(id, 'RESOLVED', { from: ['OPEN', 'UNDER_INVESTIGATION'], note: `${RESOLUTIONS.find((r) => r.value === resolution).label}: ${remarks}`, patch })
}

/** Finance marks a requested refund as paid (reference required). */
export const markRefundPaid = (id, reference) => {
  const user = getCurrentUser()
  if (!can(user, 'finance.ar.manage')) return { ok: false, error: 'Only Finance can record refunds.' }
  const list = getComplaints()
  const c = getComplaintById(id, list)
  if (!c?.refund || c.refund.status !== 'REQUESTED') return { ok: false, error: 'There is no open refund on this complaint.' }
  if (String(reference || '').trim().length < 3) return { ok: false, error: 'Enter the payment reference.' }
  const record = { ...c, refund: { ...c.refund, status: 'PAID', paidAt: new Date().toISOString(), paidByName: user.name, reference: String(reference).trim() }, updatedAt: new Date().toISOString(), history: [...c.history, hist(user, 'Refund paid', c.status, c.status, reference)] }
  storage.setItem(K.COMPLAINTS, list.map((x) => (x.id === id ? record : x)))
  logAudit({ module: 'finance', action: 'Refund paid', entity: 'Complaint', recordId: id, recordLabel: c.number, description: `${c.refund.amount} · ${reference}` })
  return { ok: true, record }
}

/* ------------------------------------------------------------------ */
/* Vendor quality                                                       */
/* ------------------------------------------------------------------ */

const vqSettings = () => ({ threshold: 3, windowDays: 30, notifySalesManager: true, autoWatch: true, ...(settings().vendorQuality || {}) })

/** Vendor-responsible complaints of a vendor in the window ending `at`. */
export const vendorComplaints = (vendorId, { days = vqSettings().windowDays, at = dayjs(), list = getComplaints() } = {}) =>
  list.filter((c) => c.vendorResponsible && c.status !== 'REJECTED' && (c.vendorIds || []).includes(vendorId) && (days === null || dayjs(c.createdAt).isAfter(dayjs(at).subtract(days, 'day'))))

/** Check thresholds for the given vendors; records one alert per vendor and window, puts the vendor On Watch. */
export const checkVendorQuality = (vendorIds = null) => {
  const cfg = vqSettings()
  const vendors = read(K.VENDORS).filter((v) => !vendorIds || vendorIds.includes(v.id))
  const alerts = read(K.VENDOR_QUALITY_ALERTS)
  const created = []
  vendors.forEach((v) => {
    const recent = vendorComplaints(v.id)
    if (recent.length < cfg.threshold) return
    const open = alerts.find((a) => a.vendorId === v.id && dayjs(a.createdAt).isAfter(dayjs().subtract(cfg.windowDays, 'day')))
    if (open) return
    const alert = {
      id: uid('vqa'), vendorId: v.id, vendorName: v.name, count: recent.length, threshold: cfg.threshold, windowDays: cfg.windowDays,
      complaintIds: recent.map((c) => c.id), complaintNumbers: recent.map((c) => c.number), batchNumbers: [...new Set(recent.flatMap((c) => c.batchNumbers || []))],
      products: [...new Set(recent.map((c) => c.productName))], status: 'OPEN', createdAt: new Date().toISOString(),
    }
    created.push(alert)
    pushNotification({ title: `Vendor quality alert: ${v.name}`, message: `${recent.length} vendor-responsible complaints in ${cfg.windowDays} days (threshold ${cfg.threshold}). Batches ${alert.batchNumbers.slice(0, 4).join(', ')}.`, type: 'danger', roles: cfg.notifySalesManager ? ['ADMIN', 'SALES_MANAGER', 'QA_MANAGER'] : ['ADMIN', 'QA_MANAGER'], link: `/vendors/${v.id}`, category: 'procurement' })
    if (cfg.autoWatch && v.status === 'Active') setVendorStatus(v.id, 'On Watch', `Quality alert: ${recent.length} complaints in ${cfg.windowDays} days (${alert.complaintNumbers.join(', ')})`, { system: true })
  })
  if (created.length) storage.setItem(K.VENDOR_QUALITY_ALERTS, [...created, ...alerts])
  return created
}

export const acknowledgeAlert = (alertId, note = '') => {
  const user = getCurrentUser()
  if (!can(user, 'vendors.block')) return { ok: false, error: 'Only an administrator can acknowledge vendor alerts.' }
  const alerts = read(K.VENDOR_QUALITY_ALERTS)
  storage.setItem(K.VENDOR_QUALITY_ALERTS, alerts.map((a) => (a.id === alertId ? { ...a, status: 'ACKNOWLEDGED', acknowledgedAt: new Date().toISOString(), acknowledgedByName: user.name, note } : a)))
  return { ok: true }
}

/** Scorecard of a vendor: complaints, rate per quantity supplied, types, monthly trend, batches, alerts. */
export const vendorScorecard = (vendorId) => {
  const all = vendorComplaints(vendorId, { days: null })
  const supplied = read(K.BATCHES).filter((b) => (b.vendorId || b.supplierId) === vendorId).reduce((s, b) => s + (Number(b.receivedQuantity) || 0), 0)
  const complainedQty = all.reduce((s, c) => s + c.quantity, 0)
  const types = COMPLAINT_TYPES.map((t) => ({ type: t, count: all.filter((c) => c.type === t).length })).filter((t) => t.count)
  const trend = Array.from({ length: 6 }, (_, i) => {
    const m = dayjs().subtract(5 - i, 'month')
    return { month: m.format('MMM YY'), count: all.filter((c) => dayjs(c.createdAt).isSame(m, 'month')).length }
  })
  return {
    total: all.length, last30: vendorComplaints(vendorId).length, suppliedQty: r3(supplied), complainedQty: r3(complainedQty),
    rate: supplied ? Math.round((complainedQty / supplied) * 10000) / 100 : 0, types, trend,
    batches: [...new Set(all.flatMap((c) => c.batchNumbers || []))], complaints: all,
    alerts: read(K.VENDOR_QUALITY_ALERTS).filter((a) => a.vendorId === vendorId), threshold: vqSettings().threshold, windowDays: vqSettings().windowDays,
  }
}
