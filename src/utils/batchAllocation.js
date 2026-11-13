/**
 * Batch allocations (data v11, bellomassi_batch_allocations) — pure derivation, shared by the seed, the migration
 * and batchService. An allocation says "order X received Q of batch B" and carries the batch's source: vendor,
 * purchase order and goods receipt. It is DERIVED from the lot consumption the single stock ledger already records
 * (dispatch movements consume lots; delivery returns / dispatch reversals give quantity back), so it can never
 * disagree with stock and is never double-counted. Ids are deterministic (batch × order), so rebuilding is idempotent.
 *
 * Example: order SO-1 for 80 KG → { B-101 (PO-0012) 50 KG } + { B-205 (PO-0015) 30 KG }.
 */
const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000
const OUT_TYPES_FOR_ORDERS = new Set(['Stock Dispatch', 'Van Stock Load', 'Stock Dispatch Reversal', 'Delivery Return', 'Van Return', 'Sales Return'])

/** Source document chain for a lot: GRN → PO → vendor (falls back to what the lot carries). */
export const lotSource = (lot, grnById = {}, poById = {}) => {
  const grn = lot.grnId ? grnById[lot.grnId] : null
  const poId = lot.poId || grn?.purchaseOrderId || null
  const po = poId ? poById[poId] : null
  return {
    vendorId: lot.vendorId || lot.supplierId || grn?.supplierId || po?.supplierId || null,
    poId,
    poNumber: po?.number || lot.poNumber || null,
    grnId: grn?.id || lot.grnId || null,
    grnNumber: grn?.number || lot.grnNumber || null,
    unitCost: Number(lot.unitCost ?? grn?.lines?.find((l) => l.productId === lot.productId)?.unitCost) || null,
  }
}

export const deriveAllocations = ({ batches = [], orders = [], goodsReceipts = [], purchaseOrders = [] }) => {
  const grnById = Object.fromEntries(goodsReceipts.map((g) => [g.id, g]))
  const poById = Object.fromEntries(purchaseOrders.map((p) => [p.id, p]))
  const orderById = Object.fromEntries(orders.map((o) => [o.id, o]))
  const map = new globalThis.Map()
  batches.forEach((b) => {
    ;(b.consumption || []).forEach((c) => {
      if (!c.orderId) return
      if (c.type && !OUT_TYPES_FOR_ORDERS.has(c.type)) return
      const key = `${b.id}|${c.orderId}`
      if (!map.has(key)) {
        const o = orderById[c.orderId]
        const src = lotSource(b, grnById, poById)
        const item = o?.items?.find((it) => it.productId === b.productId)
        map.set(key, {
          id: `bal-${b.id}-${c.orderId}`,
          orderId: c.orderId, orderNumber: c.orderNumber || o?.orderNumber || null, orderItemId: item?.id || null,
          customerId: o?.customerId || null, productId: b.productId, hubId: b.hubId,
          batchId: b.id, batchNumber: b.batchNumber, expiryDate: b.expiryDate || null, mfgDate: b.mfgDate || null,
          ...src, dispatchedQuantity: 0, returnedQuantity: 0, quantity: 0, movements: [], firstAt: c.at || null, lastAt: c.at || null,
        })
      }
      const a = map.get(key)
      if (c.qty > 0) a.dispatchedQuantity = r3(a.dispatchedQuantity + c.qty)
      else a.returnedQuantity = r3(a.returnedQuantity - c.qty)
      a.quantity = r3(a.dispatchedQuantity - a.returnedQuantity)
      if (c.movementNumber && !a.movements.includes(c.movementNumber)) a.movements.push(c.movementNumber)
      if (c.at && (!a.lastAt || c.at > a.lastAt)) a.lastAt = c.at
    })
  })
  return [...map.values()].map((a) => ({ ...a, value: a.unitCost ? Math.round(a.quantity * a.unitCost * 100) / 100 : null }))
}

/** Allocation set of one order, as stored on invoices (immutable snapshot). */
export const sourceBatchSnapshot = (allocations, orderId) => allocations
  .filter((a) => a.orderId === orderId && a.quantity > 0)
  .map((a) => ({ batchId: a.batchId, batchNumber: a.batchNumber, productId: a.productId, quantity: a.quantity, expiryDate: a.expiryDate, poId: a.poId, poNumber: a.poNumber, vendorId: a.vendorId, grnNumber: a.grnNumber }))

/** Lifecycle of a lot from its quantities and dates. */
export const batchLifecycle = (b, today = new Date().toISOString().slice(0, 10)) => {
  if (b.closedReason === 'SCRAPPED' || (b.scrappedQuantity > 0 && !(b.quantity > 0))) return { code: 'SCRAPPED', label: 'Scrapped', tone: 'neutral' }
  if (b.closedReason === 'RETURNED_TO_VENDOR' && !(b.quantity > 0)) return { code: 'RETURNED_TO_VENDOR', label: 'Returned to vendor', tone: 'neutral' }
  if (!(b.quantity > 0)) return { code: 'CONSUMED', label: 'Fully consumed', tone: 'neutral' }
  if (b.expiryDate && b.expiryDate < today) return { code: 'EXPIRED', label: 'Expired', tone: 'danger' }
  if (b.qaStatus && b.qaStatus !== 'AVAILABLE') return { code: 'BLOCKED', label: b.qaStatus === 'QA_HOLD' ? 'QA hold' : 'Blocked', tone: 'warning' }
  if (b.receivedQuantity && b.quantity < b.receivedQuantity) return { code: 'PARTIAL', label: 'Partially consumed', tone: 'info' }
  return { code: 'AVAILABLE', label: 'Available', tone: 'success' }
}

/** Quantities of a lot by outcome, from its consumption log. */
export const batchQuantities = (b) => {
  const sum = (pred) => r3((b.consumption || []).filter(pred).reduce((s, c) => s + c.qty, 0))
  const dispatched = sum((c) => c.orderId && c.qty > 0)
  const returned = r3(-sum((c) => c.orderId && c.qty < 0))
  const scrapped = sum((c) => c.type === 'Scrap Write-off')
  const toVendor = sum((c) => c.type === 'Return to Vendor')
  const other = r3(sum((c) => c.qty > 0) - dispatched - scrapped - toVendor)
  return { received: r3(b.receivedQuantity), available: r3(b.quantity), dispatched, returned, scrapped, returnedToVendor: toVendor, otherOut: Math.max(0, other) }
}
