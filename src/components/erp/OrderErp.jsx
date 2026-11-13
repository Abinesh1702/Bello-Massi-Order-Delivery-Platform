/**
 * Order / invoice additions (data v11): source batches (allocations — batch, PO, GRN, vendor) and the unit-aware
 * line progress (ordered / dispatched / delivered / returned / remaining in the base unit and the entry unit).
 */
import { Link } from 'react-router-dom'
import { Layers, Gauge } from 'lucide-react'
import Card, { CardHeader } from '../common/Card'
import { useStoredValue } from '../../hooks/useLocalStorage'
import { usePermission } from '../../hooks/usePermission'
import { STORAGE_KEYS as K } from '../../utils/constants'
import { lineProgress } from '../../utils/units'
import { formatDate } from '../../utils/formatters'

const NONE = []

export function SourceBatchesCard({ orderId, snapshot = null, title = 'Source batches', subtitle }) {
  const allocs = useStoredValue(K.BATCH_ALLOCATIONS, NONE)
  const products = useStoredValue(K.PRODUCTS, NONE)
  const vendors = useStoredValue(K.VENDORS, NONE)
  const canPo = usePermission('procurement.po.view')
  const canVendor = usePermission('suppliers.view')
  const P = Object.fromEntries(products.map((p) => [p.id, p]))
  const V = Object.fromEntries(vendors.map((v) => [v.id, v]))
  const rows = snapshot || allocs.filter((a) => a.orderId === orderId && a.quantity > 0)
  return (
    <Card>
      <CardHeader title={title} icon={Layers} subtitle={subtitle || (snapshot ? 'Snapshot taken when the invoice was issued — it does not change afterwards.' : 'Batches taken first-expiry-first-out at dispatch, net of returns.')} />
      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-muted"><th className="py-2 pr-2">Product</th><th className="py-2 pr-2">Batch</th><th className="py-2 pr-2 text-right">Qty</th><th className="py-2 pr-2">Expiry</th><th className="py-2 pr-2">PO</th><th className="py-2">Vendor</th></tr></thead>
            <tbody>{rows.map((a) => (
              <tr key={`${a.batchId}-${a.productId}`} className="border-b border-line/60">
                <td className="py-2 pr-2">{P[a.productId]?.name || a.productId}</td>
                <td className="py-2 pr-2 font-medium">{a.batchNumber}</td>
                <td className="py-2 pr-2 text-right tabular">{a.quantity} {P[a.productId]?.unit}</td>
                <td className="py-2 pr-2 whitespace-nowrap">{formatDate(a.expiryDate)}</td>
                <td className="py-2 pr-2 whitespace-nowrap">{a.poId ? (canPo ? <Link className="text-brand hover:underline" to={`/procurement/purchase-orders/${a.poId}`}>{a.poNumber}</Link> : a.poNumber) : <span className="text-muted">Opening / internal</span>}</td>
                <td className="py-2">{a.vendorId ? (canVendor ? <Link className="text-brand hover:underline" to={`/vendors/${a.vendorId}`}>{V[a.vendorId]?.name || a.vendorId}</Link> : V[a.vendorId]?.name) : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <p className="text-sm text-muted">{snapshot ? 'No batch allocation was recorded for this order.' : 'Batches are allocated when the dispatch is confirmed.'}</p>}
    </Card>
  )
}

export function LineProgressCard({ order }) {
  const deliveries = useStoredValue(K.DELIVERIES, NONE)
  const mine = deliveries.filter((d) => d.orderId === order.id)
  return (
    <Card>
      <CardHeader title="Quantities by unit" icon={Gauge} subtitle="Base-unit quantities per line: ordered, dispatched, delivered, returned and remaining." />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-muted"><th className="py-2 pr-2">Product</th><th className="py-2 pr-2">Ordered as</th><th className="py-2 pr-2 text-right">Ordered</th><th className="py-2 pr-2 text-right">Dispatched</th><th className="py-2 pr-2 text-right">Delivered</th><th className="py-2 pr-2 text-right">Returned</th><th className="py-2 text-right">Remaining</th></tr></thead>
          <tbody>{order.items.map((it) => { const p = lineProgress(it, mine); return (
            <tr key={it.id} className="border-b border-line/60">
              <td className="py-2 pr-2">{it.productName}</td>
              <td className="py-2 pr-2 text-xs text-muted">{it.entryUnit && it.entryUnit !== it.unit ? `${it.entryQuantity} ${it.entryUnit}` : `${it.orderedQuantity} ${it.unit}`}</td>
              <td className="py-2 pr-2 text-right tabular">{p.ordered} {it.unit}</td>
              <td className="py-2 pr-2 text-right tabular">{p.dispatched}</td>
              <td className="py-2 pr-2 text-right tabular">{p.delivered}</td>
              <td className="py-2 pr-2 text-right tabular">{p.returned}</td>
              <td className="py-2 text-right font-medium tabular">{p.remaining}</td>
            </tr>) })}</tbody>
        </table>
      </div>
    </Card>
  )
}
