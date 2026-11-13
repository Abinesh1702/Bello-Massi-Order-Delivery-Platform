import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Factory, Pencil, Plus, ShieldAlert, ShieldCheck, Ban, AlertTriangle, PackageSearch, FileText } from 'lucide-react'
import { toast } from 'sonner'
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
import InfoList from '../../components/common/InfoList'
import Tabs from '../../components/common/Tabs'
import NotFoundRecord from '../../components/common/NotFoundRecord'
import StatCard, { StatGrid } from '../../components/dashboard/StatCard'
import { useStoredValue } from '../../hooks/useLocalStorage'
import { usePermission } from '../../hooks/usePermission'
import { useTableQuery, sortRows } from '../../hooks/useTableQuery'
import { STORAGE_KEYS as K } from '../../utils/constants'
import { getVendorById, nextVendorCode, PAYMENT_TERMS, saveVendor, setVendorStatus, VENDOR_STATUS_TONE, VENDOR_STATUSES, vendorPurchaseSummary } from '../../services/erp/vendorService'
import { acknowledgeAlert, vendorScorecard } from '../../services/erp/complaintService'
import { downloadCsv, csvFilename } from '../../services/csvService'
import { formatDate, formatDateTime, formatMoney } from '../../utils/formatters'
import { PRODUCT_CATEGORIES } from '../../config/masterData'
import { batchLifecycle } from '../../utils/batchAllocation'

const NONE = []
const VendorStatus = ({ status }) => <Badge tone={VENDOR_STATUS_TONE[status] || 'neutral'} dot>{status}</Badge>

export function VendorList() {
  const navigate = useNavigate()
  const vendors = useStoredValue(K.VENDORS, NONE)
  const complaints = useStoredValue(K.COMPLAINTS, NONE)
  const pos = useStoredValue(K.PURCHASE_ORDERS, NONE)
  const canManage = usePermission('suppliers.manage')
  const t = useTableQuery({ sort: 'name' })
  const [status, setStatus] = useState('')
  const rows = useMemo(() => {
    const q = t.q.trim().toLowerCase()
    const list = vendors.filter((v) => (!status || v.status === status) && (!q || [v.name, v.code, v.gstNumber, v.contactPerson, v.mobile, v.email, ...(v.categories || [])].some((x) => String(x || '').toLowerCase().includes(q))))
      .map((v) => ({ ...v, complaints30: complaints.filter((c) => c.vendorResponsible && (c.vendorIds || []).includes(v.id) && Date.now() - new Date(c.createdAt) < 30 * 864e5).length, openPos: pos.filter((p) => p.supplierId === v.id && ['APPROVED', 'SENT', 'CONFIRMED', 'PARTIALLY_RECEIVED'].includes(p.status)).length }))
    return sortRows(list, t.sort, t.dir)
  }, [vendors, complaints, pos, t.q, t.sort, t.dir, status])
  const onExport = () => downloadCsv(csvFilename('vendors'), rows, [
    { header: 'Code', value: (v) => v.code }, { header: 'Vendor', value: (v) => v.name }, { header: 'GSTIN', value: (v) => v.gstNumber }, { header: 'PAN', value: (v) => v.panNumber },
    { header: 'Contact', value: (v) => v.contactPerson }, { header: 'Mobile', value: (v) => v.mobile }, { header: 'Email', value: (v) => v.email }, { header: 'Payment terms', value: (v) => v.paymentTerms }, { header: 'Status', value: (v) => v.status },
  ])
  return (
    <>
      <PageHeader title="Vendors" description="Vendor master: GSTIN, contact, products supplied, payment terms, bank details and status. Blocked vendors cannot receive purchase orders; On Watch flags quality alerts."
        actions={canManage && <Button icon={Plus} to="/vendors/create">New vendor</Button>} />
      <StatGrid cols={4}>
        <StatCard label="Vendors" value={vendors.length} icon={Factory} />
        <StatCard label="Active" value={vendors.filter((v) => v.status === 'Active').length} icon={ShieldCheck} tone="success" />
        <StatCard label="On Watch" value={vendors.filter((v) => v.status === 'On Watch').length} icon={ShieldAlert} tone="warning" />
        <StatCard label="Blocked" value={vendors.filter((v) => v.status === 'Blocked').length} icon={Ban} tone="danger" />
      </StatGrid>
      <Card className="mt-4">
        <FilterToolbar query={t.q} onQuery={t.setQuery} placeholder="Search name, code, GSTIN, contact…" total={vendors.length} filteredCount={rows.length} activeCount={(t.q ? 1 : 0) + (status ? 1 : 0)} onReset={() => { t.reset(); setStatus('') }} onExport={onExport}>
          <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} options={VENDOR_STATUSES.map((s) => ({ value: s, label: s }))} placeholder="All statuses" />
        </FilterToolbar>
        <DataTable rows={rows} pageSize="default" sort={t.sort} dir={t.dir} onSort={t.setSort} onRowClick={(v) => navigate(`/vendors/${v.id}`)}
          columns={[
            { key: 'code', header: 'Code', sortable: true, render: (v) => <Link to={`/vendors/${v.id}`} className="font-medium text-brand hover:underline">{v.code}</Link> },
            { key: 'name', header: 'Vendor', sortable: true, render: (v) => <span className="font-medium text-ink">{v.name}</span> },
            { key: 'gstNumber', header: 'GSTIN', hideBelow: 'lg', render: (v) => v.gstNumber || '—' },
            { key: 'contactPerson', header: 'Contact', hideBelow: 'md', render: (v) => <span>{v.contactPerson || '—'}<span className="block text-xs text-muted">{v.mobile}</span></span> },
            { key: 'paymentTerms', header: 'Terms', hideBelow: 'xl' },
            { key: 'openPos', header: 'Open POs', align: 'right', sortable: true, hideBelow: 'sm' },
            { key: 'complaints30', header: 'Complaints (30 d)', align: 'right', sortable: true, render: (v) => <span className={v.complaints30 ? 'font-semibold text-danger' : ''}>{v.complaints30}</span> },
            { key: 'status', header: 'Status', sortable: true, render: (v) => <VendorStatus status={v.status} /> },
          ]} />
      </Card>
    </>
  )
}

const blankVendor = (list) => ({ code: nextVendorCode(list), name: '', gstNumber: '', panNumber: '', contactPerson: '', mobile: '', email: '', address: '', city: '', country: 'India', categories: [], productsSupplied: [], paymentTerms: 'Net 30', leadTimeDays: '7', minOrderValue: '0', bank: { accountName: '', accountNumber: '', bankName: '', ifsc: '' }, status: 'Active' })

export function VendorForm() {
  const { id } = useParams()
  const navigate = useNavigate()
  const vendors = useStoredValue(K.VENDORS, NONE)
  const products = useStoredValue(K.PRODUCTS, NONE)
  const existing = id ? vendors.find((v) => v.id === id) : null
  const [v, setV] = useState(() => (existing ? { ...existing, leadTimeDays: String(existing.leadTimeDays), minOrderValue: String(existing.minOrderValue), bank: { accountName: '', accountNumber: '', bankName: '', ifsc: '', ...(existing.bank || {}) } } : blankVendor(vendors)))
  const [errors, setErrors] = useState({})
  if (id && !existing) return <NotFoundRecord entity="vendor" backTo="/vendors" backLabel="Back to vendors" />
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value })
  const setBank = (k) => (e) => setV({ ...v, bank: { ...v.bank, [k]: e.target.value } })
  const toggle = (k, x) => setV({ ...v, [k]: v[k].includes(x) ? v[k].filter((y) => y !== x) : [...v[k], x] })
  const save = (e) => {
    e.preventDefault()
    const r = saveVendor(v, id || null)
    if (!r.ok) { setErrors(r.errors || {}); toast.error(r.error); return }
    toast.success(`${r.record.name} saved`)
    navigate(`/vendors/${r.record.id}`)
  }
  return (
    <form onSubmit={save}>
      <PageHeader title={existing ? `Edit ${existing.name}` : 'New vendor'} description="Vendor master data. GSTIN and PAN are validated; bank details are used for supplier payments." actions={<><Button variant="secondary" to={existing ? `/vendors/${id}` : '/vendors'}>Cancel</Button><Button type="submit">Save vendor</Button></>} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Identity" icon={Factory} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Vendor code" value={v.code} onChange={set('code')} error={errors.code} required />
            <Input label="Vendor name" value={v.name} onChange={set('name')} error={errors.name} required />
            <Input label="GSTIN" value={v.gstNumber} onChange={set('gstNumber')} error={errors.gstNumber} placeholder="33AABCB1234C1Z5" />
            <Input label="PAN" value={v.panNumber} onChange={set('panNumber')} error={errors.panNumber} placeholder="AABCB1234C" />
            <Input label="Contact person" value={v.contactPerson} onChange={set('contactPerson')} />
            <Input label="Mobile" value={v.mobile} onChange={set('mobile')} error={errors.mobile} />
            <Input label="Email" type="email" value={v.email} onChange={set('email')} error={errors.email} />
            <Input label="City" value={v.city} onChange={set('city')} />
            <Textarea label="Address" value={v.address} onChange={set('address')} className="sm:col-span-2" rows={2} />
          </div>
        </Card>
        <Card>
          <CardHeader title="Commercial" icon={FileText} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Select label="Payment terms" value={v.paymentTerms} onChange={set('paymentTerms')} options={PAYMENT_TERMS.map((x) => ({ value: x, label: x }))} />
            <Input label="Lead time (days)" type="number" min="1" value={v.leadTimeDays} onChange={set('leadTimeDays')} error={errors.leadTimeDays} required />
            <Input label="Minimum order value" type="number" min="0" value={v.minOrderValue} onChange={set('minOrderValue')} error={errors.minOrderValue} />
            {existing && <Input label="Status" value={v.status} readOnly hint="Change the status from the vendor page (Admin)." />}
            <Input label="Bank account name" value={v.bank.accountName} onChange={setBank('accountName')} />
            <Input label="Account number" value={v.bank.accountNumber} onChange={setBank('accountNumber')} />
            <Input label="Bank" value={v.bank.bankName} onChange={setBank('bankName')} />
            <Input label="IFSC" value={v.bank.ifsc} onChange={setBank('ifsc')} error={errors['bank.ifsc']} />
          </div>
          <p className="mt-4 text-label">Categories</p>
          <div className="mt-1 flex flex-wrap gap-1.5">{PRODUCT_CATEGORIES.map((c) => <button type="button" key={c} onClick={() => toggle('categories', c)} className={`rounded-full border px-2.5 py-1 text-xs ${v.categories.includes(c) ? 'border-brand bg-brand/10 text-brand' : 'border-line text-ink-2'}`}>{c}</button>)}</div>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title={`Products supplied (${v.productsSupplied.length})`} icon={PackageSearch} subtitle="Used for purchase suggestions and vendor scorecards." />
          <div className="grid max-h-72 gap-1 overflow-y-auto scroll-thin sm:grid-cols-2 lg:grid-cols-3">
            {products.filter((p) => p.status === 'Active').map((p) => (
              <label key={p.id} className="flex items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-surface-2">
                <input type="checkbox" checked={v.productsSupplied.includes(p.id)} onChange={() => toggle('productsSupplied', p.id)} />
                <span className="truncate">{p.name}</span><span className="ml-auto text-xs text-muted">{p.sku}</span>
              </label>
            ))}
          </div>
        </Card>
      </div>
    </form>
  )
}

export function VendorDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const vendors = useStoredValue(K.VENDORS, NONE)
  useStoredValue(K.COMPLAINTS, NONE)
  useStoredValue(K.VENDOR_QUALITY_ALERTS, NONE)
  const products = useStoredValue(K.PRODUCTS, NONE)
  const hubs = useStoredValue(K.HUBS, NONE)
  const canManage = usePermission('suppliers.manage')
  const canBlock = usePermission('vendors.block')
  const canQuality = usePermission('vendorquality.view')
  const [tab, setTab] = useState('overview')
  const [statusModal, setStatusModal] = useState(null)
  const [reason, setReason] = useState('')
  const v = getVendorById(id, vendors)
  const sum = useMemo(() => (v ? vendorPurchaseSummary(v.id) : null), [v])
  const sc = useMemo(() => (v ? vendorScorecard(v.id) : null), [v, vendors]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!v) return <NotFoundRecord entity="vendor" backTo="/vendors" backLabel="Back to vendors" />
  const P = Object.fromEntries(products.map((p) => [p.id, p]))
  const H = Object.fromEntries(hubs.map((h) => [h.id, h]))
  const change = () => {
    const r = setVendorStatus(v.id, statusModal, reason)
    if (!r.ok) { toast.error(r.error); return }
    toast.success(`${v.name} is now ${statusModal}`)
    setStatusModal(null)
    setReason('')
  }
  return (
    <>
      <PageHeader title={v.name} description={`${v.code} · ${v.city || v.country} · ${v.paymentTerms}`}
        actions={<>
          {canBlock && v.status !== 'Blocked' && <Button variant="danger-outline" icon={Ban} onClick={() => setStatusModal('Blocked')}>Block</Button>}
          {canBlock && v.status !== 'Active' && <Button variant="secondary" icon={ShieldCheck} onClick={() => setStatusModal('Active')}>Set Active</Button>}
          {canBlock && v.status === 'Active' && <Button variant="secondary" icon={ShieldAlert} onClick={() => setStatusModal('On Watch')}>Put On Watch</Button>}
          {canManage && <Button variant="secondary" icon={Pencil} to={`/vendors/${v.id}/edit`}>Edit</Button>}
          {v.status !== 'Blocked' && <Button icon={Plus} to={`/procurement/purchase-orders/new?supplierId=${v.id}`}>New PO</Button>}
        </>}>
        <VendorStatus status={v.status} />
      </PageHeader>
      {v.status !== 'Active' && v.statusReason && <div className="mb-4 flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-ink"><AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />{v.status}: {v.statusReason}</div>}
      <StatGrid cols={5}>
        <StatCard label="PO value" value={formatMoney(sum.poValue)} icon={FileText} hint={`${sum.pos.length} POs · ${sum.openPos} open`} />
        <StatCard label="Received (net)" value={sum.receivedQty} icon={PackageSearch} hint={`${sum.grns.length} GRNs`} />
        <StatCard label="Batches supplied" value={sum.batches.length} icon={Factory} />
        <StatCard label="Complaints (30 d)" value={sc.last30} icon={AlertTriangle} tone={sc.last30 >= sc.threshold ? 'danger' : sc.last30 ? 'warning' : 'success'} hint={`Alert threshold ${sc.threshold} in ${sc.windowDays} d`} />
        <StatCard label="Complaint rate" value={`${sc.rate}%`} icon={ShieldAlert} tone={sc.rate > 2 ? 'danger' : 'neutral'} hint="Complained ÷ supplied qty" />
      </StatGrid>
      <Tabs className="mt-5" value={tab} onChange={setTab} tabs={[{ id: 'overview', label: 'Overview' }, { id: 'pos', label: `Purchase orders (${sum.pos.length})` }, { id: 'batches', label: `Batches (${sum.batches.length})` }, ...(canQuality ? [{ id: 'quality', label: `Quality (${sc.total})` }] : []), { id: 'history', label: 'History' }]} />
      <div className="mt-4">
        {tab === 'overview' && (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card><CardHeader title="Vendor details" /><InfoList items={[
              { label: 'GSTIN', value: v.gstNumber || '—' }, { label: 'PAN', value: v.panNumber || '—' }, { label: 'Contact', value: v.contactPerson || '—' }, { label: 'Mobile', value: v.mobile || '—' },
              { label: 'Email', value: v.email || '—' }, { label: 'Address', value: [v.address, v.city, v.country].filter(Boolean).join(', ') || '—', span: 2 },
              { label: 'Lead time', value: `${v.leadTimeDays} days` }, { label: 'Minimum order', value: formatMoney(v.minOrderValue) },
              { label: 'Bank', value: v.bank?.bankName ? `${v.bank.bankName} · ${v.bank.accountNumber} · ${v.bank.ifsc}` : '—', span: 2 },
            ]} /></Card>
            <Card><CardHeader title={`Products supplied (${(v.productsSupplied || []).length})`} />
              <ul className="divide-y divide-line text-sm">{(v.productsSupplied || []).map((pid) => <li key={pid} className="flex justify-between py-1.5"><Link className="text-brand hover:underline" to={`/products/${pid}`}>{P[pid]?.name || pid}</Link><span className="text-xs text-muted">{P[pid]?.sku}</span></li>)}</ul>
              {!(v.productsSupplied || []).length && <p className="text-sm text-muted">No products linked yet.</p>}
            </Card>
          </div>
        )}
        {tab === 'pos' && <Card><DataTable rows={sum.pos} pageSize={10} onRowClick={(p) => navigate(`/procurement/purchase-orders/${p.id}`)} columns={[
          { key: 'number', header: 'PO', render: (p) => <Link to={`/procurement/purchase-orders/${p.id}`} className="font-medium text-brand hover:underline">{p.number}</Link> }, { key: 'orderDate', header: 'Date', render: (p) => formatDate(p.orderDate) },
          { key: 'hubId', header: 'Hub', render: (p) => H[p.hubId]?.name, hideBelow: 'md' }, { key: 'total', header: 'Total', align: 'right', render: (p) => formatMoney(p.total) }, { key: 'status', header: 'Status', render: (p) => <Badge>{p.status}</Badge> },
        ]} /></Card>}
        {tab === 'batches' && <Card><DataTable rows={sum.batches} pageSize={10} columns={[
          { key: 'batchNumber', header: 'Batch', render: (b) => <Link to={`/inventory/batches?q=${encodeURIComponent(b.batchNumber)}`} className="font-medium text-brand hover:underline">{b.batchNumber}</Link> },
          { key: 'productId', header: 'Product', render: (b) => P[b.productId]?.name }, { key: 'poNumber', header: 'PO', render: (b) => b.poNumber || '—', hideBelow: 'md' }, { key: 'expiryDate', header: 'Expiry', render: (b) => formatDate(b.expiryDate) },
          { key: 'receivedQuantity', header: 'Received', align: 'right' }, { key: 'quantity', header: 'On hand', align: 'right' }, { key: 'st', header: 'Status', render: (b) => { const l = batchLifecycle(b); return <Badge tone={l.tone}>{l.label}</Badge> } },
        ]} /></Card>}
        {tab === 'quality' && (
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2"><CardHeader title="Vendor-responsible complaints" subtitle={`${sc.total} in total · rate ${sc.rate}% of ${sc.suppliedQty} supplied`} />
              <DataTable rows={sc.complaints} pageSize={8} columns={[
                { key: 'number', header: 'Complaint', render: (c) => <Link to={`/complaints/${c.id}`} className="font-medium text-brand hover:underline">{c.number}</Link> }, { key: 'createdAt', header: 'Date', render: (c) => formatDate(c.createdAt) },
                { key: 'type', header: 'Type' }, { key: 'productName', header: 'Product', hideBelow: 'md' }, { key: 'batchNumbers', header: 'Batch', render: (c) => (c.batchNumbers || []).join(', ') }, { key: 'quantity', header: 'Qty', align: 'right' },
              ]} />
            </Card>
            <div className="space-y-4">
              <Card><CardHeader title="Trend (6 months)" />
                <div className="flex h-28 items-end gap-2">{sc.trend.map((t) => <div key={t.month} className="flex flex-1 flex-col items-center gap-1"><div className="w-full rounded-t bg-danger/70" style={{ height: `${Math.max(4, t.count * 22)}px` }} title={`${t.count}`} /><span className="text-[10px] text-muted">{t.month}</span></div>)}</div>
                <ul className="mt-3 space-y-1 text-sm">{sc.types.map((t) => <li key={t.type} className="flex justify-between"><span>{t.type}</span><span className="tabular">{t.count}</span></li>)}</ul>
              </Card>
              <Card><CardHeader title="Alerts" />
                {sc.alerts.length ? <ul className="space-y-2 text-sm">{sc.alerts.map((a) => <li key={a.id} className="rounded-lg border border-line p-2"><div className="flex items-center justify-between"><span className="font-medium">{a.count} complaints / {a.windowDays} d</span><Badge tone={a.status === 'OPEN' ? 'danger' : 'neutral'}>{a.status}</Badge></div><p className="text-xs text-muted">{formatDateTime(a.createdAt)} · {a.complaintNumbers.join(', ')}</p><p className="text-xs text-muted">Batches {a.batchNumbers.join(', ')} · {a.products.join(', ')}</p>{canBlock && a.status === 'OPEN' && <Button size="xs" variant="secondary" className="mt-1" onClick={() => { acknowledgeAlert(a.id, 'Reviewed'); toast.success('Alert acknowledged') }}>Acknowledge</Button>}</li>)}</ul> : <p className="text-sm text-muted">No alerts.</p>}
              </Card>
            </div>
          </div>
        )}
        {tab === 'history' && <Card><ul className="divide-y divide-line text-sm">{[...(v.history || [])].reverse().map((h) => <li key={h.id} className="py-2"><span className="font-medium">{h.action}</span>{h.note && <span className="text-muted"> — {h.note}</span>}<span className="block text-xs text-muted">{formatDateTime(h.at)} · {h.byName}</span></li>)}</ul>{!(v.history || []).length && <p className="text-sm text-muted">No changes recorded.</p>}</Card>}
      </div>
      <Modal open={Boolean(statusModal)} onClose={() => setStatusModal(null)} title={`Set ${v.name} to ${statusModal}`} icon={statusModal === 'Blocked' ? Ban : ShieldAlert}
        footer={<><Button variant="secondary" onClick={() => setStatusModal(null)}>Cancel</Button><Button variant={statusModal === 'Blocked' ? 'danger' : 'primary'} onClick={change}>Confirm</Button></>}>
        <p className="mb-3 text-sm text-muted">{statusModal === 'Blocked' ? 'Blocked vendors cannot receive new purchase orders; open POs cannot be approved or sent.' : statusModal === 'On Watch' ? 'On Watch keeps purchasing open but flags the vendor everywhere it is chosen.' : 'The vendor becomes available for purchasing again.'}</p>
        <Textarea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} required={statusModal !== 'Active'} rows={3} />
      </Modal>
    </>
  )
}
