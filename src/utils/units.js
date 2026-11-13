/**
 * Units of measure (data v11). Every product keeps ONE base unit — the unit inventory, reservations, stock movements
 * and lots are counted in (product.baseUnit, equal to product.unit for existing products). Other units are defined
 * per product as { code, label, factor } where factor = base units in one of that unit:
 *   Whole Chicken: base CTN, unit KG factor 1/12 (1 CTN = 12 KG) → 24 KG = 2 CTN.
 *   Chicken Curry Cut (base KG): unit BOX factor 10 → 5 BOX = 50 KG; dispatch 30 KG → remaining 20 KG.
 * Sales / purchase / inventory / dispatch / delivery units are chosen from that list; every calculation converts to
 * the base unit first (toBase) and only formats back for display (fromBase / formatQty).
 */

export const UNIT_CATALOG = [
  { code: 'PCS', label: 'Pieces', decimals: false },
  { code: 'UNIT', label: 'Units', decimals: false },
  { code: 'BOX', label: 'Boxes', decimals: false },
  { code: 'PACK', label: 'Packs', decimals: false },
  { code: 'CTN', label: 'Cartons', decimals: false },
  { code: 'SET', label: 'Sets', decimals: false },
  { code: 'KG', label: 'Kilograms', decimals: true },
  { code: 'G', label: 'Grams', decimals: true },
  { code: 'LTR', label: 'Litres', decimals: true },
  { code: 'ML', label: 'Millilitres', decimals: true },
]
export const DECIMAL_UNIT_CODES = UNIT_CATALOG.filter((u) => u.decimals).map((u) => u.code)
export const UNIT_ROLES = [
  ['salesUnit', 'Sales unit'], ['purchaseUnit', 'Purchase unit'], ['inventoryUnit', 'Inventory unit'], ['dispatchUnit', 'Dispatch unit'], ['deliveryUnit', 'Delivery unit'],
]

const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000
export const unitLabel = (code) => UNIT_CATALOG.find((u) => u.code === code)?.label || code

/** Base unit + every alternative unit of a product (always includes the base unit with factor 1). */
export const productUnits = (product) => {
  if (!product) return []
  const base = product.baseUnit || product.unit
  const list = [{ code: base, label: unitLabel(base), factor: 1, base: true }]
  ;(product.units || []).forEach((u) => {
    if (!u?.code || u.code === base || list.some((x) => x.code === u.code)) return
    const factor = Number(u.factor)
    if (factor > 0) list.push({ code: u.code, label: u.label || unitLabel(u.code), factor, base: false })
  })
  return list
}

export const unitFactor = (product, code) => productUnits(product).find((u) => u.code === code)?.factor ?? null

/** Quantity in `code` → base units. Returns null for an unknown unit. */
export const toBase = (product, qty, code) => {
  const f = unitFactor(product, code || product?.baseUnit || product?.unit)
  return f === null ? null : r3(Number(qty) * f)
}
/** Base quantity → `code`. */
export const fromBase = (product, baseQty, code) => {
  const f = unitFactor(product, code)
  return f ? r3(Number(baseQty) / f) : null
}

/** Whether a quantity is valid for the unit (whole units only for count units). */
export const validUnitQuantity = (code, qty) => {
  const q = Number(qty)
  if (!Number.isFinite(q) || q <= 0) return false
  return DECIMAL_UNIT_CODES.includes(code) || Number.isInteger(q)
}

/** "5 BOX (50 KG)" — entered quantity with its base equivalent. */
export const formatQty = (product, baseQty, code = null) => {
  const base = product?.baseUnit || product?.unit || ''
  if (!code || code === base) return `${r3(baseQty)} ${base}`
  const q = fromBase(product, baseQty, code)
  return `${q} ${code} (${r3(baseQty)} ${base})`
}

/** Net weight (kg) of a base-unit quantity. */
export const weightOf = (product, baseQty) => r3((Number(product?.weightKg) || 0) * (Number(baseQty) || 0))
export const volumeOf = (product, baseQty) => Math.round((Number(product?.volumeM3) || 0) * (Number(baseQty) || 0) * 10000) / 10000

/**
 * Parse a pack description into net kg per base unit: "10 × 1.2 kg" → 12, "12 × 500 g" → 6, "12 × 1 L" → 12.
 * Returns { weightKg, inner: { count, size, unit } | null } or null when the text has no weight.
 */
export const parsePackSize = (text) => {
  const s = String(text || '').toLowerCase().replace(/\s+/g, ' ')
  const m = s.match(/(\d+(?:\.\d+)?)\s*[×x*]\s*(\d+(?:\.\d+)?)\s*(kg|g|l|ml)\b/)
  const single = s.match(/^(\d+(?:\.\d+)?)\s*(kg|g|l|ml)\b/) || s.match(/(\d+(?:\.\d+)?)\s*(kg|g|l|ml)\s*tin/)
  const toKg = (n, u) => (u === 'g' || u === 'ml' ? n / 1000 : n)
  if (m) {
    const count = Number(m[1])
    const size = Number(m[2])
    return { weightKg: r3(count * toKg(size, m[3])), inner: { count, size, unit: m[3] } }
  }
  if (single) return { weightKg: r3(toKg(Number(single[1]), single[2])), inner: null }
  return null
}

/** Order-line quantity breakdown in base units: ordered / dispatched / delivered / returned / remaining. */
export const lineProgress = (item, deliveries = []) => {
  const ordered = r3(item.orderedQuantity)
  let dispatched = 0
  let delivered = 0
  let returned = 0
  deliveries.filter((d) => d.status !== 'CANCELLED').forEach((d) => {
    const l = (d.items || []).find((x) => x.orderItemId === item.id)
    if (!l) return
    dispatched += Number(l.dispatchedQuantity) || 0
    delivered += Number(l.deliveredQuantity) || 0
    returned += Number(l.returnedQuantity ?? (d.returnedToHub ? Math.max(0, (Number(l.dispatchedQuantity) || 0) - (Number(l.deliveredQuantity) || 0)) : 0)) || 0
  })
  dispatched = r3(dispatched)
  delivered = r3(delivered)
  returned = r3(returned)
  return { ordered, dispatched, delivered, returned, remaining: r3(Math.max(0, ordered - delivered)) }
}
