import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AlarmClock, CalendarX2, Hourglass, Boxes, Plus, Trash2, Upload, Undo2, Recycle, PackagePlus, ScanBarcode, Filter } from 'lucide-react'
import { toast } from 'sonner'
import dayjs from 'dayjs'
import PageHeader from '../../components/common/PageHeader'
import Card, { CardHeader } from '../../components/common/Card'
import Badge from '../../components/common/Badge'
import Button from '../../components/common/Button'
import Modal from '../../components/common/Modal'
import Input from '../../components/common/Input'
import Select from '../../components/common/Select'
import Textarea from '../../components/common/Textarea'
import DataTable from '../../components/common/DataTable'
import FilterToolbar from '../../components/common/FilterToolbar'
import EmptyState from '../../components/common/EmptyState'
import StatCard, { StatGrid } from '../../components/dashboard/StatCard'
import { useStoredValue } from '../../hooks/useLocalStorage'
import { usePermission } from '../../hooks/usePermission'
import { STORAGE_KEYS as K } from '../../utils/constants'
import { detectExpiry, expiryRows, postOpeningStock, returnToVendor } from '../../services/erp/stockControlService'
import { createStockReceipt } from '../../services/inventoryService'
import { findByBarcode } from '../../services/erp/workspaceService'
import { parseCsv } from '../../services/csvService'
import { formatDate, formatMoney } from '../../utils/formatters'
import { ScanButton } from '../../components/erp/ErpUi'
import { PRODUCT_CATEGORIES } from '../../config/masterData'

const NONE = []
const BUCKET = { EXPIRED: { label: 'Expired', tone: 'danger' }, D7: { label: '≤ 7 days', tone: 'danger' }, D30: { label: '≤ 30 days', tone: 'warning' }, OK: { label: '> 30 days', tone: 'success' } }

/* ------------------------------------------------------------------ Expiry */
export function ExpiryPage() {
  useStoredValue(K.BATCHES, NONE)
  useStoredValue(K.SCRAP_REQUESTS, NONE)
  const hubs = useStoredValue(K.HUBS, NONE)
  const vendors = useStoredValue(K.VENDORS, NONE)
  const canRtv = usePermission('purchase.returns.manage')
  const canScrap = usePermission('scrap.approve')
  const [f, setF] = useState({ hubId: '', category: '', vendorId: '', bucket: 'ALERT', q: '' })
  const [rtv, setRtv] = useState(null)
  const [reason, setReason] = useState('')
  const all = expiryRows({ hubId: f.hubId, category: f.category, vendorId: f.vendorId })
  const rows = all.filter((r) => (f.bucket === 'ALERT' ? r.bucket !== 'OK' : !f.bucket || r.bucket === f.bucket) && (!f.q || [r.batchNumber, r.productName, r.poNumber].some((x) => String(x || '').toLowerCase().includes(f.q.toLowerCase()))))
  const sum = (b) => all.filter((r) => r.bucket === b)
  const val = (list) => formatMoney(list.reduce((s, r) => s + r.value, 0))
  const scan = () => { const r = detectExpiry(); toast[r.raised ? 'warning' : 'success'](r.raised ? `${r.raised} expired batch(es) blocked; scrap request(s) raised for approval.` : `Scan complete — ${r.detected || 0} expired batch(es), all already have a scrap request.`) }
  const doRtv = () => { const r = returnToVendor({ batchId: rtv.id, quantity: rtv.quantity, reason, scrapRequestId: rtv.scrapRequestId }); if (!r.ok) { toast.error(r.error); return } toast.success(`${r.record.number}: ${rtv.quantity} ${rtv.unit} returned to ${r.record.vendorName}`); setRtv(null); setReason('') }
  return (
    <>
      <PageHeader title="Expiry control" description="Lots on hand by expiry. Expired lots are blocked from orders, dispatch and transfers; the expiry scan raises one scrap request per expired lot for approval." actions={<Button variant="secondary" icon={AlarmClock} onClick={scan}>Run expiry scan</Button>} />
      <StatGrid cols={4}>
        <StatCard label="Expired" value={sum('EXPIRED').length} hint={val(sum('EXPIRED'))} icon={CalendarX2} tone="danger" />
        <StatCard label="Expiring ≤ 7 days" value={sum('D7').length} hint={val(sum('D7'))} icon={Hourglass} tone="danger" />
        <StatCard label="Expiring ≤ 30 days" value={sum('D30').length} hint={val(sum('D30'))} icon={Hourglass} tone="warning" />
        <StatCard label="Lots with expiry" value={all.length} hint={val(all)} icon={Boxes} />
      </StatGrid>
      <Card className="mt-4">
        <FilterToolbar query={f.q} onQuery={(q) => setF({ ...f, q })} placeholder="Search batch, product, PO…" total={all.length} filteredCount={rows.length} activeCount={['hubId', 'category', 'vendorId'].filter((k) => f[k]).length} onReset={() => setF({ hubId: '', category: '', vendorId: '', bucket: 'ALERT', q: '' })}>
          <Select aria-label="Bucket" value={f.bucket} onChange={(e) => setF({ ...f, bucket: e.target.value })} options={[{ value: 'ALERT', label: 'Expired + ≤ 30 days' }, ...Object.entries(BUCKET).map(([v, m]) => ({ value: v, label: m.label }))]} placeholder="All" />
          <Select aria-label="Hub" value={f.hubId} onChange={(e) => setF({ ...f, hubId: e.target.value })} options={hubs.map((h) => ({ value: h.id, label: h.name }))} placeholder="All hubs" />
          <Select aria-label="Category" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} options={PRODUCT_CATEGORIES.map((c) => ({ value: c, label: c }))} placeholder="All categories" />
          <Select aria-label="Vendor" value={f.vendorId} onChange={(e) => setF({ ...f, vendorId: e.target.value })} options={vendors.map((v) => ({ value: v.id, label: v.name }))} placeholder="All vendors" />
        </FilterToolbar>
        <DataTable rows={rows} pageSize="default" empty={<EmptyState icon={Boxes} title="Nothing in this bucket" description="No lots match the filters." />}
          columns={[
            { key: 'batchNumber', header: 'Batch', render: (r) => <span className="font-medium text-ink">{r.batchNumber}<span className="block text-xs font-normal text-muted">{r.poNumber ? `PO ${r.poNumber}` : r.sourceType}</span></span> },
            { key: 'productName', header: 'Product', render: (r) => <Link to={`/products/${r.productId}`} className="hover:underline">{r.productName}</Link> },
            { key: 'hubName', header: 'Hub', hideBelow: 'md' },
            { key: 'vendorName', header: 'Vendor', hideBelow: 'xl', render: (r) => r.vendorName || '—' },
            { key: 'expiryDate', header: 'Expiry', render: (r) => <span>{formatDate(r.expiryDate)}<span className="block text-xs text-muted">{r.days < 0 ? `${-r.days} d ago` : `${r.days} d left`}</span></span> },
            { key: 'quantity', header: 'Qty', align: 'right', render: (r) => `${r.quantity} ${r.unit}` },
            { key: 'value', header: 'Value', align: 'right', hideBelow: 'sm', render: (r) => formatMoney(r.value) },
            { key: 'bucket', header: 'Status', render: (r) => <Badge tone={BUCKET[r.bucket].tone} dot>{BUCKET[r.bucket].label}</Badge> },
            { key: 'act', header: 'Action', align: 'right', render: (r) => (
              <span className="flex justify-end gap-1">
                {r.scrapRequestId && <Button size="xs" variant="secondary" icon={Recycle} to={`/inventory/scrap/requests/${r.scrapRequestId}`}>{r.scrapNumber}</Button>}
                {r.bucket === 'EXPIRED' && !r.scrapRequestId && canScrap && <Button size="xs" variant="secondary" onClick={scan}>Raise scrap</Button>}
                {r.vendorId && canRtv && r.bucket !== 'OK' && (!r.scrapStatus || r.scrapStatus === 'REJECTED') && <Button size="xs" variant="outline" icon={Undo2} onClick={() => setRtv(r)}>Return</Button>}
              </span>
            ) },
          ]} />
      </Card>
      <Modal open={Boolean(rtv)} onClose={() => setRtv(null)} title={`Return ${rtv?.batchNumber} to vendor`} icon={Undo2}
        footer={<><Button variant="secondary" onClick={() => setRtv(null)}>Cancel</Button><Button onClick={doRtv}>Return {rtv?.quantity} {rtv?.unit}</Button></>}>
        {rtv && <p className="mb-3 text-sm text-muted">{rtv.productName} · {rtv.vendorName} · PO {rtv.poNumber || '—'}. A Return-to-Vendor stock movement deducts the batch and a PO return document (PRN) is created.</p>}
        <Textarea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} required rows={3} />
      </Modal>
    </>
  )
}

/* ------------------------------------------------------------------ New stock (admin) */
const blankLine = () => ({ key: Math.random().toString(36).slice(2), productId: '', hubId: '', warehouseId: '', quantity: '', unitCost: '', batchNumber: '', mfgDate: '', expiryDate: '' })
export function NewStockPage() {
  const navigate = useNavigate()
  const products = useStoredValue(K.PRODUCTS, NONE)
  const hubs = useStoredValue(K.HUBS, NONE)
  const org = useStoredValue(K.ORGANIZATION, {})
  const [kind, setKind] = useState('Opening stock')
  const [lines, setLines] = useState([blankLine()])
  const [reason, setReason] = useState('')
  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'))
  const [attachments, setAttachments] = useState([])
  const [error, setError] = useState(null)
  const P = Object.fromEntries(products.map((p) => [p.id, p]))
  const setLine = (i, patch) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const onScan = (code) => { const p = findByBarcode(code); if (!p) { toast.error(`No product with barcode ${code}`); return } const empty = lines.findIndex((l) => !l.productId); if (empty >= 0) setLine(empty, { productId: p.id, unitCost: String(p.purchasePrice || '') }); else setLines([...lines, { ...blankLine(), productId: p.id, unitCost: String(p.purchasePrice || '') }]); toast.success(`${p.name} added`) }
  const importCsv = async (file) => {
    try {
      const rows = parseCsv(await file.text())
      const byCode = Object.fromEntries(products.flatMap((p) => [[String(p.sku).toLowerCase(), p], [String(p.code).toLowerCase(), p], [String(p.barcode).toLowerCase(), p]]))
      const byHub = Object.fromEntries(hubs.flatMap((h) => [[h.code.toLowerCase(), h], [h.name.toLowerCase(), h]]))
      const out = rows.map((r) => ({ ...blankLine(), productId: byCode[String(r.sku || r.product || r.barcode || '').toLowerCase()]?.id || '', hubId: byHub[String(r.hub || '').toLowerCase()]?.id || '', quantity: r.quantity || '', unitCost: r.unitcost || r.cost || '', batchNumber: r.batch || r.batchnumber || '', mfgDate: r.mfgdate || r.mfg || '', expiryDate: r.expirydate || r.expiry || '' }))
      setLines(out.length ? out : [blankLine()])
      setKind('Stock import')
      toast.success(`${out.length} line(s) loaded — review and post`)
    } catch (e) { toast.error(`CSV could not be read: ${e.message}`) }
  }
  const addFiles = async (files) => {
    const list = []
    for (const f of [...files].slice(0, 3)) list.push(await new Promise((res) => { const r = new FileReader(); r.onload = () => res({ name: f.name, type: f.type, size: f.size, dataUrl: String(r.result) }); r.readAsDataURL(f) }))
    setAttachments([...attachments, ...list.filter((a) => a.dataUrl.length < 450 * 1024)])
  }
  const post = () => {
    setError(null)
    const r = postOpeningStock(lines.filter((l) => l.productId || l.quantity).map((l) => ({ ...l, quantity: l.quantity, unitCost: l.unitCost })), { reason, receiptDate: date, attachments, kind })
    if (!r.ok) { setError(r); toast.error(r.error); return }
    toast.success(`${r.records.length} line(s) posted — opening batches created`)
    navigate('/inventory/stock-receipts')
  }
  return (
    <>
      <PageHeader title="New stock" description="Administrator only. Opening stock, opening batches and stock import go through the stock ledger as receipt movements carrying their batch, expiry and cost — the batch is created from that movement."
        actions={<><ScanButton onDetected={onScan} label="Scan product" /><label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-2"><Upload size={16} />Import CSV<input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => e.target.files[0] && importCsv(e.target.files[0])} /></label><Button icon={PackagePlus} onClick={post}>Post stock</Button></>} />
      <Card>
        <div className="grid gap-3 sm:grid-cols-4">
          <Select label="Type" value={kind} onChange={(e) => setKind(e.target.value)} options={['Opening stock', 'Opening batch', 'Stock import', 'Stock adjustment (in)'].map((x) => ({ value: x, label: x }))} />
          <Input label="Posting date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <Input label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} required className="sm:col-span-2" placeholder="e.g. Opening balance at go-live (stock count 31 Oct)" />
        </div>
        <p className="mt-2 text-xs text-muted">CSV columns: sku (or barcode / code), hub (code or name), quantity, unitCost, batch, mfgDate, expiryDate.</p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="text-left text-xs text-muted"><tr><th className="p-1.5">Product</th><th className="p-1.5">Hub</th><th className="p-1.5">Warehouse</th><th className="p-1.5">Qty</th><th className="p-1.5">Unit cost</th><th className="p-1.5">Batch no.</th><th className="p-1.5">Mfg date</th><th className="p-1.5">Expiry</th><th /></tr></thead>
            <tbody>{lines.map((l, i) => (
              <tr key={l.key} className={error?.line === i ? 'bg-danger/5' : ''}>
                <td className="p-1"><select aria-label="Product" className="h-9 w-56 rounded-lg border border-line bg-surface px-2" value={l.productId} onChange={(e) => setLine(i, { productId: e.target.value, unitCost: String(P[e.target.value]?.purchasePrice || '') })}><option value="">Select…</option>{products.filter((p) => p.trackInventory).map((p) => <option key={p.id} value={p.id}>{p.name} · {p.sku}</option>)}</select></td>
                <td className="p-1"><select aria-label="Hub" className="h-9 w-40 rounded-lg border border-line bg-surface px-2" value={l.hubId} onChange={(e) => setLine(i, { hubId: e.target.value, warehouseId: '' })}><option value="">Select…</option>{hubs.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select></td>
                <td className="p-1"><select aria-label="Warehouse" className="h-9 w-36 rounded-lg border border-line bg-surface px-2" value={l.warehouseId} onChange={(e) => setLine(i, { warehouseId: e.target.value })}><option value="">—</option>{(org?.warehouses || []).filter((w) => !l.hubId || w.hubId === l.hubId).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></td>
                <td className="p-1"><input aria-label="Quantity" type="number" min="0" step="any" className="h-9 w-24 rounded-lg border border-line bg-surface px-2" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} /><span className="ml-1 text-xs text-muted">{P[l.productId]?.unit}</span></td>
                <td className="p-1"><input aria-label="Unit cost" type="number" min="0" step="any" className="h-9 w-24 rounded-lg border border-line bg-surface px-2" value={l.unitCost} onChange={(e) => setLine(i, { unitCost: e.target.value })} /></td>
                <td className="p-1"><input aria-label="Batch number" className="h-9 w-32 rounded-lg border border-line bg-surface px-2" value={l.batchNumber} onChange={(e) => setLine(i, { batchNumber: e.target.value })} placeholder={P[l.productId]?.batchTracking ? 'required' : 'optional'} /></td>
                <td className="p-1"><input aria-label="Manufacturing date" type="date" className="h-9 rounded-lg border border-line bg-surface px-2" value={l.mfgDate} onChange={(e) => setLine(i, { mfgDate: e.target.value })} /></td>
                <td className="p-1"><input aria-label="Expiry date" type="date" className="h-9 rounded-lg border border-line bg-surface px-2" value={l.expiryDate} onChange={(e) => setLine(i, { expiryDate: e.target.value })} /></td>
                <td className="p-1"><Button size="xs" variant="ghost" icon={Trash2} aria-label="Remove line" onClick={() => setLines(lines.length > 1 ? lines.filter((_, j) => j !== i) : [blankLine()])} /></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        {error && <p className="mt-2 text-sm text-danger">{error.error}</p>}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button size="sm" variant="secondary" icon={Plus} onClick={() => setLines([...lines, blankLine()])}>Add line</Button>
          <label className="text-sm text-muted">Attachments <input type="file" multiple onChange={(e) => addFiles(e.target.files)} className="ml-2 text-xs" /></label>
          {attachments.map((a) => <Badge key={a.name}>{a.name}</Badge>)}
        </div>
      </Card>
    </>
  )
}

/* ------------------------------------------------------------------ Bulk stock receipt with filters */
export function BulkReceiptPage() {
  const navigate = useNavigate()
  const products = useStoredValue(K.PRODUCTS, NONE)
  const hubs = useStoredValue(K.HUBS, NONE)
  const vendors = useStoredValue(K.VENDORS, NONE)
  const batches = useStoredValue(K.BATCHES, NONE)
  const org = useStoredValue(K.ORGANIZATION, {})
  const [f, setF] = useState({ q: '', category: '', subcategory: '', vendorId: '', batch: '', expiryBefore: '' })
  const [hubId, setHubId] = useState('hub-che')
  const [warehouseId, setWarehouseId] = useState('')
  const [vendorId, setVendorId] = useState('')
  const [ref, setRef] = useState('')
  const [sel, setSel] = useState({}) // productId → line
  const subcats = [...new Set(products.filter((p) => !f.category || p.category === f.category).map((p) => p.subcategory).filter(Boolean))]
  const vendor = vendors.find((v) => v.id === f.vendorId)
  const list = products.filter((p) => p.trackInventory && p.status === 'Active').filter((p) => {
    const q = f.q.trim().toLowerCase()
    if (q && ![p.name, p.sku, p.code, p.barcode].some((x) => String(x || '').toLowerCase().includes(q))) return false
    if (f.category && p.category !== f.category) return false
    if (f.subcategory && p.subcategory !== f.subcategory) return false
    if (vendor && !(vendor.productsSupplied || []).includes(p.id) && !(vendor.categories || []).includes(p.category)) return false
    if (f.batch && !batches.some((b) => b.productId === p.id && String(b.batchNumber).toLowerCase().includes(f.batch.toLowerCase()))) return false
    if (f.expiryBefore && !batches.some((b) => b.productId === p.id && b.hubId === hubId && b.quantity > 0 && b.expiryDate && b.expiryDate <= f.expiryBefore)) return false
    return true
  })
  const toggle = (p) => setSel((s) => { const n = { ...s }; if (n[p.id]) delete n[p.id]; else n[p.id] = { ordered: '', received: '', rejected: '0', unitCost: String(p.purchasePrice || ''), batchNumber: '', expiryDate: p.shelfLifeDays ? dayjs().add(p.shelfLifeDays, 'day').format('YYYY-MM-DD') : '' }; return n })
  const setL = (id, patch) => setSel((s) => ({ ...s, [id]: { ...s[id], ...patch } }))
  const onScan = (code) => { const p = findByBarcode(code); if (!p) return toast.error(`No product with barcode ${code}`); if (!sel[p.id]) toggle(p); toast.success(`${p.name} selected`) }
  const post = () => {
    const ids = Object.keys(sel)
    if (!ids.length) return toast.error('Select at least one product.')
    const errs = []
    let n = 0
    ids.forEach((pid) => {
      const l = sel[pid]
      const accepted = Math.max(0, (Number(l.received) || 0) - (Number(l.rejected) || 0))
      if (!(accepted > 0)) { errs.push(`${products.find((p) => p.id === pid)?.name}: nothing accepted`); return }
      const r = createStockReceipt({ productId: pid, hubId, quantity: accepted, receiptDate: dayjs().format('YYYY-MM-DD'), referenceNumber: ref, notes: `Ordered ${l.ordered || '—'} · received ${l.received} · rejected ${l.rejected || 0}`, batchNumber: l.batchNumber, expiryDate: l.expiryDate, unitCost: l.unitCost, vendorId: vendorId || null, warehouseId: warehouseId || null, requireBatch: true, sourceType: 'Stock receipt' })
      if (!r.ok) errs.push(`${products.find((p) => p.id === pid)?.name}: ${Object.values(r.errors)[0]}`)
      else n += 1
    })
    if (errs.length) toast.error(errs.slice(0, 3).join(' · '))
    if (n) { toast.success(`${n} receipt line(s) posted`); setSel({}); if (!errs.length) navigate('/inventory/stock-receipts') }
  }
  const chosen = Object.keys(sel).map((id) => products.find((p) => p.id === id)).filter(Boolean)
  return (
    <>
      <PageHeader title="Receive stock (multi-product)" description="Filter by category, subcategory, SKU, barcode, supplier, batch or expiry, select several products and receive them in one go. Accepted = received − rejected goes into stock with its batch and expiry."
        actions={<><ScanButton onDetected={onScan} label="Scan" /><Button icon={PackagePlus} onClick={post} disabled={!chosen.length}>Post {chosen.length || ''} line(s)</Button></>} />
      <div className="grid gap-4 xl:grid-cols-5">
        <Card className="xl:col-span-2">
          <CardHeader title="Find products" icon={Filter} />
          <div className="grid gap-2 sm:grid-cols-2">
            <Input label="Search name / SKU / barcode" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} icon={ScanBarcode} className="sm:col-span-2" />
            <Select label="Category" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value, subcategory: '' })} options={PRODUCT_CATEGORIES.map((c) => ({ value: c, label: c }))} placeholder="All" />
            <Select label="Subcategory" value={f.subcategory} onChange={(e) => setF({ ...f, subcategory: e.target.value })} options={subcats.map((c) => ({ value: c, label: c }))} placeholder="All" />
            <Select label="Supplier" value={f.vendorId} onChange={(e) => { setF({ ...f, vendorId: e.target.value }); setVendorId(e.target.value) }} options={vendors.map((v) => ({ value: v.id, label: v.name }))} placeholder="Any" />
            <Input label="Existing batch" value={f.batch} onChange={(e) => setF({ ...f, batch: e.target.value })} />
            <Input label="Has stock expiring before" type="date" value={f.expiryBefore} onChange={(e) => setF({ ...f, expiryBefore: e.target.value })} />
          </div>
          <ul className="mt-3 max-h-[420px] divide-y divide-line overflow-y-auto scroll-thin text-sm">
            {list.map((p) => <li key={p.id}><label className="flex cursor-pointer items-center gap-2 py-1.5"><input type="checkbox" checked={Boolean(sel[p.id])} onChange={() => toggle(p)} /><span className="min-w-0 flex-1 truncate">{p.name}</span><span className="text-xs text-muted">{p.sku}</span></label></li>)}
            {!list.length && <li className="py-3 text-muted">No products match.</li>}
          </ul>
        </Card>
        <Card className="xl:col-span-3">
          <CardHeader title={`Receipt lines (${chosen.length})`} />
          <div className="grid gap-2 sm:grid-cols-4">
            <Select label="Hub" value={hubId} onChange={(e) => setHubId(e.target.value)} options={hubs.map((h) => ({ value: h.id, label: h.name }))} />
            <Select label="Warehouse" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} options={(org?.warehouses || []).filter((w) => w.hubId === hubId).map((w) => ({ value: w.id, label: w.name }))} placeholder="—" />
            <Select label="Supplier" value={vendorId} onChange={(e) => setVendorId(e.target.value)} options={vendors.filter((v) => v.status !== 'Blocked').map((v) => ({ value: v.id, label: v.name }))} placeholder="—" />
            <Input label="Reference" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="DN / invoice no." />
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="text-left text-xs text-muted"><tr><th className="p-1">Product</th><th className="p-1">Ordered</th><th className="p-1">Received</th><th className="p-1">Rejected</th><th className="p-1">Accepted</th><th className="p-1">Unit</th><th className="p-1">Unit cost</th><th className="p-1">Batch</th><th className="p-1">Expiry</th></tr></thead>
              <tbody>{chosen.map((p) => { const l = sel[p.id]; const acc = Math.max(0, (Number(l.received) || 0) - (Number(l.rejected) || 0)); return (
                <tr key={p.id} className="border-t border-line">
                  <td className="p-1"><span className="font-medium">{p.name}</span><span className="block text-xs text-muted">{p.sku}</span></td>
                  {['ordered', 'received', 'rejected'].map((k) => <td key={k} className="p-1"><input aria-label={k} type="number" min="0" step="any" className="h-8 w-20 rounded border border-line bg-surface px-2" value={l[k]} onChange={(e) => setL(p.id, { [k]: e.target.value })} /></td>)}
                  <td className="p-1 font-semibold tabular">{acc}</td><td className="p-1 text-xs">{p.unit}</td>
                  <td className="p-1"><input aria-label="Unit cost" type="number" min="0" className="h-8 w-20 rounded border border-line bg-surface px-2" value={l.unitCost} onChange={(e) => setL(p.id, { unitCost: e.target.value })} /></td>
                  <td className="p-1"><input aria-label="Batch" className="h-8 w-24 rounded border border-line bg-surface px-2" value={l.batchNumber} onChange={(e) => setL(p.id, { batchNumber: e.target.value })} /></td>
                  <td className="p-1"><input aria-label="Expiry" type="date" className="h-8 rounded border border-line bg-surface px-2" value={l.expiryDate} onChange={(e) => setL(p.id, { expiryDate: e.target.value })} /></td>
                </tr>) })}</tbody>
            </table>
            {!chosen.length && <p className="py-6 text-center text-sm text-muted">Tick products on the left (or scan a barcode) to add receipt lines.</p>}
          </div>
        </Card>
      </div>
    </>
  )
}
