/**
 * Stock control (data v11): FEFO batch planning for dispatch, manual override, expiry detection → scrap request,
 * return to vendor and admin-only opening stock. Quantities still live only in the single ledger
 * (inventory + stock movements); this service decides WHICH lots a movement takes and records why.
 *
 * FEFO eligibility of a lot for a dispatch:
 *   quantity > 0 · QA status AVAILABLE · not expired · remaining shelf life ≥ product.minRemainingShelfLifeDays.
 * Sorted by expiry date, then receipt date. Lots are shared across the lines of one dispatch (a lot used by line 1
 * is not offered again to line 2). Short usable stock blocks confirmation with a message such as
 * "Only 40 KG usable; 20 KG is expired or near expiry". An override (fefo.override) may pick near-expiry lots or a
 * different order of lots with a reason and confirmation — expired or QA-blocked lots can never be chosen.
 */
import dayjs from 'dayjs'
import storage from '../storageService'
import { STORAGE_KEYS as K } from '../../utils/constants'
import { MOVEMENT_TYPES as MT } from '../../config/masterData'
import { can } from '../../config/permissions'
import { getCurrentUser } from '../authService'
import { logAudit } from '../auditService'
import { pushNotification } from '../notificationService'
import { createStockReceipt, postScrapWriteOff, validateReceipt } from '../inventoryService'
import { daysToExpiry, isExpired } from '../enterprise/batchService'
import { uid } from '../../utils/helpers'
import { lotSource } from '../../utils/batchAllocation'

const read = (k, f = []) => storage.getItem(k, f) ?? f
const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000
const fefoSort = (a, b) => {
  const ea = a.expiryDate || '9999-12-31'
  const eb = b.expiryDate || '9999-12-31'
  return ea === eb ? String(a.receivedAt || '').localeCompare(String(b.receivedAt || '')) : ea.localeCompare(eb)
}

/** Classify one lot for a product: usable / near-expiry / expired / blocked. */
export const lotEligibility = (lot, product, today = dayjs()) => {
  if (isExpired(lot, today)) return { code: 'EXPIRED', label: 'Expired', usable: false, overridable: false }
  if (lot.qaStatus && lot.qaStatus !== 'AVAILABLE') return { code: 'BLOCKED', label: lot.qaStatus === 'QA_HOLD' ? 'QA hold' : 'Blocked', usable: false, overridable: false }
  const min = Number(product?.minRemainingShelfLifeDays) || 0
  const d = daysToExpiry(lot, today)
  if (d !== null && min > 0 && d < min) return { code: 'NEAR_EXPIRY', label: `${d} d left (min ${min})`, usable: false, overridable: true }
  return { code: 'USABLE', label: d === null ? 'No expiry' : `${d} d left`, usable: true, overridable: true }
}

const lotsAt = (productId, hubId, batches) => batches.filter((b) => b.productId === productId && b.hubId === hubId && b.quantity > 0)

/**
 * FEFO plan for a set of orders leaving one hub. overrides: { [`${orderId}|${itemId}`]: [{ batchId, quantity }] }.
 * Returns { lines: [{ key, orderId, orderNumber, itemId, productId, productName, unit, quantity, lots, short, message, overridden }],
 *           blocks: string[], warnings: string[], key → lots map (lotPlan) }.
 */
export const fefoPlan = (orders, hubId, { overrides = null, batches = read(K.BATCHES), products = read(K.PRODUCTS) } = {}) => {
  const P = Object.fromEntries(products.map((p) => [p.id, p]))
  const pool = Object.fromEntries(batches.filter((b) => b.hubId === hubId && b.quantity > 0).map((b) => [b.id, r3(b.quantity)]))
  const lines = []
  const blocks = []
  const warnings = []
  orders.forEach((o) => (o.items || []).forEach((it) => {
    const product = P[it.productId]
    const key = `${o.id}|${it.id}`
    const need = r3(it.orderedQuantity)
    const base = { key, orderId: o.id, orderNumber: o.orderNumber, itemId: it.id, productId: it.productId, productName: it.productName, unit: it.unit, quantity: need }
    if (!product?.trackInventory) { lines.push({ ...base, lots: [], short: 0, tracked: false }); return }
    const lots = lotsAt(it.productId, hubId, batches)
    const chosen = []
    let remaining = need
    const override = overrides?.[key]
    if (override?.length) {
      override.forEach((x) => {
        const b = lots.find((l) => l.id === x.batchId)
        if (!b) { blocks.push(`${o.orderNumber}: batch selected for ${it.productName} no longer has stock.`); return }
        const el = lotEligibility(b, product)
        if (!el.overridable) { blocks.push(`${o.orderNumber}: batch ${b.batchNumber} is ${el.label.toLowerCase()} and can never be dispatched.`); return }
        const take = Math.min(r3(x.quantity), pool[b.id] || 0, remaining)
        if (take > 0) { chosen.push({ batchId: b.id, batchNumber: b.batchNumber, expiryDate: b.expiryDate, quantity: take, eligibility: el.code }); pool[b.id] = r3(pool[b.id] - take); remaining = r3(remaining - take) }
      })
    } else {
      lots.filter((b) => lotEligibility(b, product).usable).sort(fefoSort).forEach((b) => {
        if (remaining <= 0) return
        const take = Math.min(pool[b.id] || 0, remaining)
        if (take > 0) { chosen.push({ batchId: b.id, batchNumber: b.batchNumber, expiryDate: b.expiryDate, quantity: take, eligibility: 'USABLE' }); pool[b.id] = r3(pool[b.id] - take); remaining = r3(remaining - take) }
      })
    }
    const unusable = r3(lots.filter((b) => !lotEligibility(b, product).usable).reduce((s, b) => s + b.quantity, 0))
    const usableQty = r3(chosen.reduce((s, c) => s + c.quantity, 0))
    let message = ''
    if (remaining > 0) {
      message = `Only ${usableQty} ${it.unit} usable${unusable ? `; ${unusable} ${it.unit} is expired or near expiry` : ''} — ${it.productName} needs ${need} ${it.unit} (${o.orderNumber}).`
      blocks.push(message)
    } else if (chosen.some((c) => c.eligibility === 'NEAR_EXPIRY')) warnings.push(`${o.orderNumber}: ${it.productName} uses near-expiry stock (override).`)
    lines.push({ ...base, lots: chosen, short: remaining > 0 ? remaining : 0, unusable, message, overridden: Boolean(override?.length), tracked: true })
  }))
  const lotPlan = Object.fromEntries(lines.filter((l) => l.lots.length).map((l) => [l.key, l.lots.map(({ batchId, batchNumber, quantity }) => ({ batchId, batchNumber, quantity }))]))
  return { lines, blocks: [...new Set(blocks)], warnings, lotPlan }
}

/** Candidate lots for overriding one line (all lots at the hub with eligibility), FEFO order. */
export const overrideCandidates = (productId, hubId) => {
  const product = read(K.PRODUCTS).find((p) => p.id === productId)
  return lotsAt(productId, hubId, read(K.BATCHES)).sort(fefoSort).map((b) => ({ ...b, eligibility: lotEligibility(b, product) }))
}

/** Save a manual FEFO override on a dispatch (reason + confirmation, audited). Pass overrides = null to clear. */
export const saveDispatchOverride = (dispatchId, overrides, { reason = '', confirmed = false } = {}) => {
  const user = getCurrentUser()
  if (!can(user, 'fefo.override')) return { ok: false, error: 'You do not have permission to override the FEFO plan.' }
  const dispatches = read(K.DISPATCHES)
  const d = dispatches.find((x) => x.id === dispatchId)
  if (!d) return { ok: false, error: 'This dispatch no longer exists.' }
  if (d.stockDeducted) return { ok: false, error: `${d.dispatchNumber} is already confirmed — its batches cannot change.` }
  if (overrides) {
    if (String(reason).trim().length < 10) return { ok: false, error: 'Enter the reason for the override (at least 10 characters).' }
    if (!confirmed) return { ok: false, error: 'Confirm that you accept responsibility for the override.' }
    const orders = read(K.ORDERS).filter((o) => d.orderIds.includes(o.id))
    const plan = fefoPlan(orders, d.hubId, { overrides })
    const bad = plan.blocks.find((b) => /can never|no longer/.test(b))
    if (bad) return { ok: false, error: bad }
  }
  const now = new Date().toISOString()
  const record = { ...d, fefoOverride: overrides ? { overrides, reason: String(reason).trim(), by: user.id, byName: user.name, at: now } : null, updatedAt: now }
  const res = storage.setItem(K.DISPATCHES, dispatches.map((x) => (x.id === dispatchId ? record : x)))
  if (!res.ok) return { ok: false, error: res.error }
  logAudit({ module: 'dispatch', action: overrides ? 'FEFO override' : 'FEFO override cleared', entity: 'Dispatch', recordId: d.id, recordLabel: d.dispatchNumber, description: reason })
  return { ok: true, record }
}

/* ------------------------------------------------------------------ */
/* Expiry                                                              */
/* ------------------------------------------------------------------ */

export const expiryRows = ({ hubId = '', productId = '', category = '', vendorId = '' } = {}) => {
  const P = Object.fromEntries(read(K.PRODUCTS).map((p) => [p.id, p]))
  const H = Object.fromEntries(read(K.HUBS).map((h) => [h.id, h]))
  const V = Object.fromEntries(read(K.VENDORS).map((v) => [v.id, v]))
  const grns = Object.fromEntries(read(K.GOODS_RECEIPTS).map((g) => [g.id, g]))
  const pos = Object.fromEntries(read(K.PURCHASE_ORDERS).map((p) => [p.id, p]))
  const scraps = read(K.SCRAP_REQUESTS)
  return read(K.BATCHES)
    .filter((b) => b.quantity > 0 && b.expiryDate)
    .filter((b) => (!hubId || b.hubId === hubId) && (!productId || b.productId === productId) && (!category || P[b.productId]?.category === category))
    .map((b) => {
      const src = lotSource(b, grns, pos)
      const days = daysToExpiry(b)
      const p = P[b.productId]
      const unitCost = Number(b.unitCost ?? src.unitCost ?? p?.purchasePrice) || 0
      const scrap = scraps.find((s) => s.batchId === b.id && !['CANCELLED'].includes(s.status))
      return {
        ...b, productName: p?.name || b.productId, productCode: p?.code, category: p?.category, unit: p?.unit, hubName: H[b.hubId]?.name || b.hubId,
        vendorId: src.vendorId, vendorName: V[src.vendorId]?.name || '', poNumber: src.poNumber, days,
        bucket: days < 0 ? 'EXPIRED' : days <= 7 ? 'D7' : days <= 30 ? 'D30' : 'OK', value: Math.round(b.quantity * unitCost * 100) / 100,
        scrapRequestId: scrap?.id || null, scrapNumber: scrap?.scrapNumber || null, scrapStatus: scrap?.status || null,
      }
    })
    .filter((r) => !vendorId || r.vendorId === vendorId)
    .sort((a, b) => a.days - b.days)
}

const nextNumberIn = (prefix, numbers) => {
  const y = dayjs().format('YYYY')
  const n = numbers.filter((x) => String(x || '').startsWith(`${prefix}-${y}-`)).map((x) => Number(String(x).split('-').pop()) || 0).reduce((a, b) => Math.max(a, b), 0) + 1
  return `${prefix}-${y}-${String(n).padStart(4, '0')}`
}

/**
 * Expiry detection (runs on sign-in and every N minutes): for every lot with stock that has passed its expiry date —
 * marks the lot (expiredDetectedAt), keeps it blocked (batchService already holds it out of available stock, so it
 * cannot be dispatched or transferred), raises ONE scrap request (Pending Approval) per lot and notifies Admin.
 * Idempotent: a lot that already has a scrap request (any status but Cancelled) is not raised again.
 */
export const detectExpiry = ({ now = dayjs() } = {}) => {
  const settings = read(K.ERP_SETTINGS, {}) || {}
  const batches = read(K.BATCHES)
  const expired = batches.filter((b) => b.quantity > 0 && isExpired(b, now))
  if (!expired.length) return { ok: true, detected: 0, raised: 0 }
  const scraps = read(K.SCRAP_REQUESTS)
  const P = Object.fromEntries(read(K.PRODUCTS).map((p) => [p.id, p]))
  const H = Object.fromEntries(read(K.HUBS).map((h) => [h.id, h]))
  const grns = Object.fromEntries(read(K.GOODS_RECEIPTS).map((g) => [g.id, g]))
  const pos = Object.fromEntries(read(K.PURCHASE_ORDERS).map((p) => [p.id, p]))
  const iso = now.toISOString()
  const created = []
  let marked = 0
  const nextBatches = batches.map((b) => {
    if (!(b.quantity > 0 && isExpired(b, now)) || b.expiredDetectedAt) return b
    marked += 1
    return { ...b, expiredDetectedAt: iso, history: [...(b.history || []), { at: iso, action: 'Expired', note: `Expired on ${b.expiryDate}; blocked from dispatch and transfer.` }] }
  })
  if (settings.expiry?.autoScrapRequest !== false) {
    expired.forEach((b) => {
      if (scraps.some((s) => s.batchId === b.id && s.status !== 'CANCELLED') || created.some((s) => s.batchId === b.id)) return
      const p = P[b.productId]
      const src = lotSource(b, grns, pos)
      const unitCost = Number(b.unitCost ?? src.unitCost ?? p?.purchasePrice) || 0
      created.push({
        id: uid('scr'), scrapNumber: nextNumberIn('SCR', [...scraps, ...created].map((s) => s.scrapNumber)), status: 'PENDING_APPROVAL',
        productId: b.productId, productName: p?.name || '', productCode: p?.code || '', category: p?.category || '', unit: p?.unit || '',
        batchId: b.id, batchNumber: b.batchNumber, hubId: b.hubId, hubName: H[b.hubId]?.name || '', warehouseId: b.warehouseId || null,
        stockSource: 'blocked', quantity: r3(b.quantity), unitCost, value: Math.round(b.quantity * unitCost * 100) / 100, reason: 'Expired',
        remarks: `Raised automatically: batch ${b.batchNumber} expired on ${dayjs(b.expiryDate).format('DD MMM YYYY')}.`, photos: [], documents: [],
        requestDate: now.format('YYYY-MM-DD'), expiryDate: b.expiryDate, vendorId: src.vendorId, poId: src.poId, poNumber: src.poNumber, origin: 'Expiry detection',
        requestedBy: 'system', requestedByName: 'System (expiry detection)', createdAt: iso, updatedAt: iso, submittedAt: iso,
        history: [{ id: uid('sch'), at: iso, action: 'Raised by expiry detection', by: null, byName: 'System', note: `${b.quantity} ${p?.unit || ''} blocked` }, { id: uid('sch'), at: iso, action: 'Pending approval', by: null, byName: 'System', note: 'Waiting for an approver' }],
        approvedBy: null, approvedByName: null, approvedAt: null, approvalRemarks: '', rejectedBy: null, rejectedByName: null, rejectedAt: null, rejectionReason: '',
        writeOff: null, cancelledAt: null, cancelReason: '',
      })
    })
  }
  if (!marked && !created.length) return { ok: true, detected: expired.length, raised: 0 }
  const writes = [[K.BATCHES, nextBatches]]
  if (created.length) writes.push([K.SCRAP_REQUESTS, [...created, ...scraps]])
  const res = storage.withoutWriteHooks(() => storage.transaction(writes))
  if (!res.ok) return { ok: false, error: res.error }
  if (created.length) {
    const value = created.reduce((s, c) => s + c.value, 0)
    pushNotification({ title: `${created.length} expired batch${created.length === 1 ? '' : 'es'} blocked`, message: `Scrap request${created.length === 1 ? '' : 's'} ${created.slice(0, 3).map((c) => c.scrapNumber).join(', ')}${created.length > 3 ? '…' : ''} raised for approval (value ${Math.round(value).toLocaleString('en-IN')}).`, type: 'danger', roles: ['ADMIN', 'WAREHOUSE_MANAGER'], link: '/inventory/expiry', category: 'inventory' })
  }
  return { ok: true, detected: expired.length, marked, raised: created.length, requests: created }
}

/* ------------------------------------------------------------------ */
/* Return to vendor                                                    */
/* ------------------------------------------------------------------ */

export const getPurchaseReturns = () => read(K.PURCHASE_RETURNS)

/** Send a lot (or part of it) back to its vendor: stock deduction + Return-to-Vendor movement + PO return document. */
export const returnToVendor = ({ batchId, quantity, reason, scrapRequestId = null }) => {
  const user = getCurrentUser()
  if (!can(user, 'purchase.returns.manage') && !can(user, 'scrap.approve')) return { ok: false, error: 'You do not have permission to return stock to vendors.' }
  const b = read(K.BATCHES).find((x) => x.id === batchId)
  if (!b) return { ok: false, error: 'This batch no longer exists.' }
  const q = r3(quantity)
  if (!(q > 0)) return { ok: false, error: 'Enter the quantity to return.' }
  if (q > b.quantity) return { ok: false, error: `Batch ${b.batchNumber} has only ${b.quantity} on hand.` }
  if (String(reason || '').trim().length < 5) return { ok: false, error: 'Enter the reason for the return (at least 5 characters).' }
  const src = lotSource(b, Object.fromEntries(read(K.GOODS_RECEIPTS).map((g) => [g.id, g])), Object.fromEntries(read(K.PURCHASE_ORDERS).map((p) => [p.id, p])))
  if (!src.vendorId) return { ok: false, error: `Batch ${b.batchNumber} has no vendor on record (opening or internal stock) — scrap it instead.` }
  const blocked = isExpired(b) || b.qaStatus !== 'AVAILABLE'
  const list = getPurchaseReturns()
  const number = nextNumberIn('PRN', list.map((x) => x.number))
  const product = read(K.PRODUCTS).find((p) => p.id === b.productId)
  const vendor = read(K.VENDORS).find((v) => v.id === src.vendorId)
  let record
  const res = postScrapWriteOff(
    { productId: b.productId, hubId: b.hubId, quantity: q, source: blocked ? 'blocked' : 'available', reference: number, notes: `Return to ${vendor?.name || 'vendor'} · batch ${b.batchNumber} — ${reason}`, lots: [{ batchId: b.id, batchNumber: b.batchNumber, quantity: q }], type: MT.RETURN_TO_VENDOR, documentKey: K.PURCHASE_RETURNS },
    (movement) => {
      const now = new Date().toISOString()
      record = {
        id: uid('prn'), number, status: 'RETURNED', vendorId: src.vendorId, vendorName: vendor?.name || '', poId: src.poId, poNumber: src.poNumber, grnNumber: src.grnNumber,
        batchId: b.id, batchNumber: b.batchNumber, productId: b.productId, productName: product?.name || '', unit: product?.unit || '', hubId: b.hubId,
        quantity: q, unitCost: Number(b.unitCost ?? src.unitCost) || 0, value: Math.round(q * (Number(b.unitCost ?? src.unitCost) || 0) * 100) / 100,
        reason: String(reason).trim(), scrapRequestId, movementId: movement.id, movementNumber: movement.movementNumber, createdAt: now, createdBy: user.id, createdByName: user.name,
        history: [{ at: now, byName: user.name, action: 'Returned to vendor', note: `${movement.movementNumber} · ${q} ${product?.unit || ''}` }],
      }
      return [record, ...getPurchaseReturns()]
    },
  )
  if (!res.ok) return { ok: false, error: res.error }
  if (scrapRequestId) {
    const scraps = read(K.SCRAP_REQUESTS)
    storage.setItem(K.SCRAP_REQUESTS, scraps.map((s) => (s.id === scrapRequestId ? { ...s, returnedToVendor: { number, at: record.createdAt, quantity: q }, updatedAt: record.createdAt, history: [...(s.history || []), { id: uid('sch'), at: record.createdAt, action: 'Returned to vendor', by: user.id, byName: user.name, note: `${number} · ${q} ${record.unit}` }] } : s)))
  }
  logAudit({ module: 'inventory', action: 'Return to vendor', entity: 'Purchase return', recordId: record.id, recordLabel: number, description: `${q} ${record.unit} ${record.productName} (batch ${b.batchNumber}) to ${record.vendorName}: ${reason}` })
  return { ok: true, record, movement: res.movement }
}

/* ------------------------------------------------------------------ */
/* Opening stock (admin only)                                           */
/* ------------------------------------------------------------------ */

/**
 * Admin-only "New stock": opening stock / opening batch / import lines. Each line goes through the normal stock
 * receipt (one RECEIPT movement in the ledger) carrying its batch details, so batchService creates the opening
 * batch from the movement — there is no second way of creating stock. All lines are validated first; nothing is
 * posted unless every line is valid.
 */
export const postOpeningStock = (lines, { reason = '', receiptDate = dayjs().format('YYYY-MM-DD'), attachments = [], kind = 'Opening stock' } = {}) => {
  const user = getCurrentUser()
  if (!can(user, 'inventory.openingstock')) return { ok: false, error: 'Only an administrator can post opening stock.' }
  if (!lines.length) return { ok: false, error: 'Add at least one line.' }
  if (String(reason).trim().length < 5) return { ok: false, error: 'Enter the reason (at least 5 characters).', errors: { reason: 'Enter the reason (at least 5 characters).' } }
  const results = []
  const seen = new Set()
  for (const [i, l] of lines.entries()) {
    const k = `${l.productId}|${l.hubId}|${String(l.batchNumber || '').trim().toUpperCase()}`
    if (l.batchNumber && seen.has(k)) return { ok: false, error: `Line ${i + 1}: the same batch appears twice.` }
    seen.add(k)
    const dup = l.batchNumber && read(K.BATCHES).find((b) => b.productId === l.productId && b.hubId === l.hubId && String(b.batchNumber).toUpperCase() === String(l.batchNumber).trim().toUpperCase())
    if (dup) return { ok: false, error: `Line ${i + 1}: batch ${l.batchNumber} already exists for this product at this hub.` }
  }
  for (const [i, l] of lines.entries()) {
    const e = validateReceipt({ ...l, receiptDate, requireBatch: true })
    if (Object.keys(e).length) return { ok: false, error: `Line ${i + 1}: ${Object.values(e)[0]}`, errors: e, line: i }
  }
  for (const [i, l] of lines.entries()) {
    const r = createStockReceipt({ ...l, receiptDate, sourceType: kind, requireBatch: true, referenceNumber: l.referenceNumber || `OPENING-${dayjs().format('YYYYMMDD')}`, notes: `${kind}: ${reason}`, reason, attachments })
    if (!r.ok) return { ok: false, error: `Line ${i + 1}: ${Object.values(r.errors || {})[0] || 'could not be posted'}`, errors: r.errors, line: i, posted: results }
    results.push(r.record)
  }
  logAudit({ module: 'inventory', action: kind, entity: 'Stock receipt', recordId: results[0]?.id, recordLabel: results.map((r) => r.receiptNumber).join(', '), description: `${results.length} line(s): ${reason}` })
  return { ok: true, records: results }
}
