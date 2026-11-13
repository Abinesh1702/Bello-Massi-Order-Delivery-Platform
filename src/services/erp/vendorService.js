/**
 * Vendor master (data v11, bellomassi_vendors) — the single source for suppliers / vendors.
 *
 * The planning parameters of a vendor (name, lead time, minimum order value, categories) are mirrored into the
 * forecast settings' supplier list, which replenishment, forecasting and the AI tools read; the mirror is written
 * only by this service (and edits made on the forecasting settings page flow back through syncFromPlanning).
 * Status: Active · On Watch (quality alert — POs still allowed, flagged) · Blocked (no new purchase orders / GRNs).
 */
import dayjs from 'dayjs'
import storage from '../storageService'
import { STORAGE_KEYS as K } from '../../utils/constants'
import { can } from '../../config/permissions'
import { getCurrentUser } from '../authService'
import { logAudit } from '../auditService'
import { pushNotification } from '../notificationService'
import { isValidEmail, uid } from '../../utils/helpers'

const read = (k, f = []) => storage.getItem(k, f) ?? f
export const VENDOR_STATUSES = ['Active', 'On Watch', 'Blocked']
export const VENDOR_STATUS_TONE = { Active: 'success', 'On Watch': 'warning', Blocked: 'danger' }
export const PAYMENT_TERMS = ['Advance', 'COD', 'Net 7', 'Net 15', 'Net 30', 'Net 45', 'Net 60']

export const getVendors = () => read(K.VENDORS)
export const getVendorById = (id, list = getVendors()) => list.find((v) => v.id === id) || null
export const isVendorBlocked = (id) => getVendorById(id)?.status === 'Blocked'

/** Legacy supplier shape (planning mirror) for a vendor. */
const planningOf = (v, prev = {}) => ({
  ...prev, id: v.id, name: v.name, leadTimeDays: v.leadTimeDays, minOrderValue: v.minOrderValue, categories: v.categories || [],
  contactEmail: v.email || '', contactPhone: v.mobile || '', country: v.country || prev.country || '', status: v.status,
})

const writeVendors = (list) => {
  const fs = storage.getItem(K.FORECAST_SETTINGS, null)
  const writes = [[K.VENDORS, list]]
  if (fs && Array.isArray(fs.suppliers)) {
    const prev = Object.fromEntries(fs.suppliers.map((s) => [s.id, s]))
    writes.push([K.FORECAST_SETTINGS, { ...fs, suppliers: list.map((v) => planningOf(v, prev[v.id])) }])
  }
  return storage.transaction(writes)
}

const hist = (user, action, note = '') => ({ id: uid('vh'), at: new Date().toISOString(), by: user?.id || 'system', byName: user?.name || 'System', action, note })

const GST_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/

export const validateVendor = (v, existingId = null, list = getVendors()) => {
  const e = {}
  const name = String(v.name || '').trim()
  const code = String(v.code || '').trim().toUpperCase()
  if (name.length < 2) e.name = 'Enter the vendor name.'
  else if (list.some((x) => x.id !== existingId && x.name.toLowerCase() === name.toLowerCase())) e.name = 'Another vendor has this name.'
  if (!code) e.code = 'Enter a vendor code.'
  else if (list.some((x) => x.id !== existingId && String(x.code).toUpperCase() === code)) e.code = 'This code is already used.'
  if (v.gstNumber && !GST_RE.test(String(v.gstNumber).trim().toUpperCase())) e.gstNumber = 'Enter a valid 15-character GSTIN (e.g. 33AABCB1234C1Z5).'
  if (v.panNumber && !PAN_RE.test(String(v.panNumber).trim().toUpperCase())) e.panNumber = 'Enter a valid PAN (e.g. AABCB1234C).'
  if (v.email && !isValidEmail(v.email)) e.email = 'Enter a valid email address.'
  if (v.mobile && !/^[+\d][\d\s-]{6,19}$/.test(String(v.mobile).trim())) e.mobile = 'Enter a valid phone number.'
  const lead = Number(v.leadTimeDays)
  if (!Number.isInteger(lead) || lead < 1 || lead > 180) e.leadTimeDays = 'Enter 1–180 days.'
  if (!(Number(v.minOrderValue || 0) >= 0)) e.minOrderValue = 'Enter 0 or more.'
  if (v.bank?.ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(v.bank.ifsc).toUpperCase())) e['bank.ifsc'] = 'IFSC is 11 characters (e.g. HDFC0001234).'
  if (!VENDOR_STATUSES.includes(v.status || 'Active')) e.status = 'Choose a status.'
  return e
}

export const nextVendorCode = (list = getVendors()) => {
  const n = list.map((v) => Number(String(v.code).replace(/\D/g, '')) || 0).reduce((a, b) => Math.max(a, b), 0) + 1
  return `VEN-${String(n).padStart(3, '0')}`
}

export const saveVendor = (values, id = null) => {
  const user = getCurrentUser()
  if (!can(user, 'suppliers.manage')) return { ok: false, error: 'You do not have permission to manage vendors.' }
  const list = getVendors()
  const existing = id ? getVendorById(id, list) : null
  if (id && !existing) return { ok: false, error: 'This vendor no longer exists.' }
  const errors = validateVendor(values, id, list)
  if (existing && values.status && values.status !== existing.status && !can(user, 'vendors.block')) errors.status = 'Only an administrator can change the vendor status.'
  if (Object.keys(errors).length) return { ok: false, errors, error: 'Please fix the highlighted fields.' }
  const now = new Date().toISOString()
  const clean = {
    code: String(values.code).trim().toUpperCase(), name: String(values.name).trim(), gstNumber: String(values.gstNumber || '').trim().toUpperCase(),
    panNumber: String(values.panNumber || '').trim().toUpperCase(), contactPerson: String(values.contactPerson || '').trim(), mobile: String(values.mobile || '').trim(),
    email: String(values.email || '').trim(), address: String(values.address || '').trim(), city: String(values.city || '').trim(), country: String(values.country || 'India').trim(),
    categories: values.categories || [], productsSupplied: values.productsSupplied || [], paymentTerms: values.paymentTerms || 'Net 30',
    leadTimeDays: Number(values.leadTimeDays), minOrderValue: Number(values.minOrderValue || 0),
    bank: { accountName: '', accountNumber: '', bankName: '', ifsc: '', ...(values.bank || {}) },
  }
  const record = existing
    ? { ...existing, ...clean, status: values.status || existing.status, updatedAt: now, history: [...(existing.history || []), hist(user, 'Updated')] }
    : { id: uid('ven'), ...clean, status: 'Active', statusReason: '', history: [hist(user, 'Created')], createdAt: now, updatedAt: now }
  const res = writeVendors(existing ? list.map((v) => (v.id === id ? record : v)) : [record, ...list])
  if (!res.ok) return { ok: false, error: res.error }
  logAudit({ module: 'vendors', action: existing ? 'Vendor updated' : 'Vendor created', entity: 'Vendor', recordId: record.id, recordLabel: `${record.code} ${record.name}` })
  return { ok: true, record }
}

/** Status change (Admin): Blocked vendors cannot receive POs; On Watch flags them. Reason required except for Active. */
export const setVendorStatus = (id, status, reason = '', { user = getCurrentUser(), system = false } = {}) => {
  if (!system && !can(user, 'vendors.block')) return { ok: false, error: 'Only an administrator can block or unblock vendors.' }
  if (!VENDOR_STATUSES.includes(status)) return { ok: false, error: 'Unknown vendor status.' }
  const list = getVendors()
  const v = getVendorById(id, list)
  if (!v) return { ok: false, error: 'This vendor no longer exists.' }
  if (v.status === status) return { ok: true, record: v, unchanged: true }
  if (status !== 'Active' && String(reason).trim().length < 5) return { ok: false, error: 'Enter a reason (at least 5 characters).' }
  const record = { ...v, status, statusReason: String(reason).trim(), statusChangedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), history: [...(v.history || []), hist(system ? null : user, `Status → ${status}`, reason)] }
  const res = writeVendors(list.map((x) => (x.id === id ? record : x)))
  if (!res.ok) return { ok: false, error: res.error }
  logAudit({ module: 'vendors', action: `Vendor ${status}`, entity: 'Vendor', recordId: id, recordLabel: v.name, description: reason })
  if (status === 'Blocked') pushNotification({ title: `Vendor blocked: ${v.name}`, message: `No new purchase orders can be raised. ${reason}`, type: 'danger', roles: ['ADMIN', 'PROCUREMENT_MANAGER', 'PROCUREMENT_EXEC', 'BUYER'], link: `/vendors/${id}`, category: 'procurement' })
  return { ok: true, record }
}

/** Planning edits (forecast settings page) flow back to the vendor master. */
export const syncFromPlanning = () => storage.withoutWriteHooks(() => {
  const fs = storage.getItem(K.FORECAST_SETTINGS, null)
  const vendors = getVendors()
  if (!fs || !Array.isArray(fs.suppliers) || !vendors.length) return
  let changed = false
  const next = vendors.map((v) => {
    const s = fs.suppliers.find((x) => x.id === v.id)
    if (!s) return v
    const patch = {}
    if (s.name && s.name !== v.name) patch.name = s.name
    if (Number(s.leadTimeDays) && Number(s.leadTimeDays) !== v.leadTimeDays) patch.leadTimeDays = Number(s.leadTimeDays)
    if (s.minOrderValue !== undefined && Number(s.minOrderValue) !== v.minOrderValue) patch.minOrderValue = Number(s.minOrderValue)
    if (!Object.keys(patch).length) return v
    changed = true
    return { ...v, ...patch, updatedAt: new Date().toISOString() }
  })
  // Suppliers added on the planning page (legacy path) become vendors too
  fs.suppliers.filter((s) => !vendors.some((v) => v.id === s.id)).forEach((s) => {
    changed = true
    next.push({ id: s.id, code: nextVendorCode(next), name: s.name, gstNumber: '', panNumber: '', contactPerson: '', mobile: s.contactPhone || '', email: s.contactEmail || '', address: '', city: '', country: s.country || 'India', categories: s.categories || [], productsSupplied: [], paymentTerms: 'Net 30', leadTimeDays: Number(s.leadTimeDays) || 7, minOrderValue: Number(s.minOrderValue) || 0, bank: {}, status: 'Active', statusReason: '', history: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  })
  if (changed) storage.setItem(K.VENDORS, next)
})

let installed = false
export const installVendorSync = () => {
  if (installed) return
  installed = true
  storage.addWriteHook((key) => { if (key === K.FORECAST_SETTINGS) queueMicrotask(syncFromPlanning) })
}

/* ---------- Purchase history & traceability ---------- */
export const vendorPurchaseSummary = (vendorId) => {
  const pos = read(K.PURCHASE_ORDERS).filter((p) => p.supplierId === vendorId)
  const grns = read(K.GOODS_RECEIPTS).filter((g) => g.supplierId === vendorId)
  const batches = read(K.BATCHES).filter((b) => (b.vendorId || b.supplierId) === vendorId)
  const received = grns.filter((g) => g.status === 'POSTED').reduce((s, g) => s + (g.lines || []).reduce((a, l) => a + (Number(l.receivedQty) || 0) - (Number(l.rejectedQty) || 0), 0), 0)
  const value = pos.filter((p) => !['CANCELLED', 'REJECTED', 'DRAFT'].includes(p.status)).reduce((s, p) => s + (Number(p.total) || 0), 0)
  const lastPo = [...pos].sort((a, b) => String(b.orderDate).localeCompare(String(a.orderDate)))[0] || null
  return { pos, grns, batches, receivedQty: Math.round(received * 1000) / 1000, poValue: Math.round(value * 100) / 100, lastPoDate: lastPo?.orderDate || null, openPos: pos.filter((p) => ['APPROVED', 'SENT', 'CONFIRMED', 'PARTIALLY_RECEIVED'].includes(p.status)).length }
}

export const supplierOptions = ({ includeBlocked = false } = {}) => getVendors()
  .filter((v) => includeBlocked || v.status !== 'Blocked')
  .map((v) => ({ value: v.id, label: `${v.name}${v.status === 'On Watch' ? ' (On Watch)' : ''}` }))

export const daysSince = (iso) => (iso ? dayjs().diff(dayjs(iso), 'day') : null)
