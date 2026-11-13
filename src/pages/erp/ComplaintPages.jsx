import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { MessageSquareWarning, Plus, Search, CheckCircle2, XCircle, Archive, Camera, Factory, PackageSearch } from 'lucide-react'
import { toast } from 'sonner'
import PageHeader from '../../components/common/PageHeader'
import Card, { CardHeader } from '../../components/common/Card'
import Badge from '../../components/common/Badge'
import Button from '../../components/common/Button'
import Modal from '../../components/common/Modal'
import Input from '../../components/common/Input'
import Select from '../../components/common/Select'
import Textarea from '../../components/common/Textarea'
import Toggle from '../../components/common/Toggle'
import DataTable from '../../components/common/DataTable'
import FilterToolbar from '../../components/common/FilterToolbar'
import InfoList from '../../components/common/InfoList'
import NotFoundRecord from '../../components/common/NotFoundRecord'
import EmptyState from '../../components/common/EmptyState'
import StatCard, { StatGrid } from '../../components/dashboard/StatCard'
import { useStoredValue } from '../../hooks/useLocalStorage'
import { usePermission } from '../../hooks/usePermission'
import { useAuth } from '../../hooks/useAuth'
import { useTableQuery, sortRows } from '../../hooks/useTableQuery'
import { STORAGE_KEYS as K } from '../../utils/constants'
import {
  canViewComplaint, closeComplaint, COMPLAINT_STATUS, COMPLAINT_TYPES, complaintLines, complaintWindowDays, createComplaint, eligibleOrders, markRefundPaid,
  rejectComplaint, RESOLUTIONS, resolveComplaint, setVendorResponsible, startInvestigation, visibleComplaints,
} from '../../services/erp/complaintService'
import { readScrapFile } from '../../services/scrapService'
import { formatDate, formatDateTime, formatMoney } from '../../utils/formatters'
import { ToneBadge } from '../../components/erp/ErpUi'

const NONE = []

export function ComplaintList() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const list = useStoredValue(K.COMPLAINTS, NONE)
  const vendors = useStoredValue(K.VENDORS, NONE)
  const canCreate = usePermission('complaints.create')
  const t = useTableQuery({ sort: 'createdAt', dir: 'desc' })
  const [status, setStatus] = useState('')
  const [type, setType] = useState('')
  const mine = useMemo(() => visibleComplaints(user, list), [user, list])
  const V = Object.fromEntries(vendors.map((v) => [v.id, v]))
  const rows = useMemo(() => {
    const q = t.q.trim().toLowerCase()
    return sortRows(mine.filter((c) => (!status || c.status === status) && (!type || c.type === type) && (!q || [c.number, c.customerName, c.orderNumber, c.productName, ...(c.batchNumbers || [])].some((x) => String(x || '').toLowerCase().includes(q)))), t.sort, t.dir)
  }, [mine, t.q, t.sort, t.dir, status, type])
  return (
    <>
      <PageHeader title="Customer complaints" description={`Complaints against delivered orders (within ${complaintWindowDays()} days of delivery), traced to the batch, purchase order and vendor.`} actions={canCreate && <Button icon={Plus} to="/complaints/create">Raise complaint</Button>} />
      <StatGrid cols={4}>
        <StatCard label="Open" value={mine.filter((c) => c.status === 'OPEN').length} icon={MessageSquareWarning} tone="warning" />
        <StatCard label="Under investigation" value={mine.filter((c) => c.status === 'UNDER_INVESTIGATION').length} icon={Search} tone="info" />
        <StatCard label="Resolved" value={mine.filter((c) => ['RESOLVED', 'CLOSED'].includes(c.status)).length} icon={CheckCircle2} tone="success" />
        <StatCard label="Vendor responsible" value={mine.filter((c) => c.vendorResponsible).length} icon={Factory} tone="danger" />
      </StatGrid>
      <Card className="mt-4">
        <FilterToolbar query={t.q} onQuery={t.setQuery} placeholder="Search number, customer, order, batch…" total={mine.length} filteredCount={rows.length} activeCount={(t.q ? 1 : 0) + (status ? 1 : 0) + (type ? 1 : 0)} onReset={() => { t.reset(); setStatus(''); setType('') }}>
          <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} options={Object.entries(COMPLAINT_STATUS).map(([v, m]) => ({ value: v, label: m.label }))} placeholder="All statuses" />
          <Select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)} options={COMPLAINT_TYPES.map((x) => ({ value: x, label: x }))} placeholder="All types" />
        </FilterToolbar>
        <DataTable rows={rows} pageSize="default" sort={t.sort} dir={t.dir} onSort={t.setSort} onRowClick={(c) => navigate(`/complaints/${c.id}`)}
          empty={<EmptyState icon={MessageSquareWarning} title="No complaints" description="Complaints raised against delivered orders appear here." />}
          columns={[
            { key: 'number', header: 'Complaint', sortable: true, render: (c) => <Link to={`/complaints/${c.id}`} className="font-medium text-brand hover:underline">{c.number}</Link> },
            { key: 'createdAt', header: 'Date', sortable: true, render: (c) => formatDate(c.createdAt), hideBelow: 'md' },
            { key: 'customerName', header: 'Customer', sortable: true },
            { key: 'productName', header: 'Product', hideBelow: 'lg', render: (c) => <span>{c.productName}<span className="block text-xs text-muted">{c.quantity} {c.unit} · {(c.batchNumbers || []).join(', ') || 'no batch'}</span></span> },
            { key: 'vendor', header: 'Vendor', hideBelow: 'xl', render: (c) => (c.vendorIds || []).map((x) => V[x]?.name).join(', ') || '—' },
            { key: 'type', header: 'Type', sortable: true, render: (c) => <Badge tone={c.vendorResponsible ? 'danger' : 'neutral'}>{c.type}</Badge> },
            { key: 'status', header: 'Status', sortable: true, render: (c) => <ToneBadge meta={COMPLAINT_STATUS} value={c.status} /> },
          ]} />
      </Card>
    </>
  )
}

export function ComplaintCreate() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  useStoredValue(K.ORDERS, NONE)
  useStoredValue(K.BATCH_ALLOCATIONS, NONE)
  const orders = useMemo(() => eligibleOrders(user), [user])
  const [v, setV] = useState({ orderId: params.get('orderId') || '', orderItemId: '', type: 'Quality', description: '', quantity: '', contactName: '', contactPhone: '', complaintDate: new Date().toISOString().slice(0, 10), photos: [], batches: {} })
  const [errors, setErrors] = useState({})
  const lines = useMemo(() => (v.orderId ? complaintLines(v.orderId) : []), [v.orderId])
  const line = lines.find((l) => l.id === v.orderItemId)
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value })
  const addPhotos = async (files) => {
    const out = []
    for (const f of [...files].slice(0, 4)) { try { out.push(await readScrapFile(f)) } catch (e) { toast.error(String(e.message || e)) } }
    setV((s) => ({ ...s, photos: [...s.photos, ...out].slice(0, 6) }))
  }
  const submit = (e) => {
    e.preventDefault()
    const r = createComplaint({ ...v, batches: Object.entries(v.batches).map(([batchId, quantity]) => ({ batchId, quantity: Number(quantity) })) })
    if (!r.ok) { setErrors(r.errors || {}); toast.error(r.error); return }
    toast.success(`${r.record.number} raised`)
    navigate(`/complaints/${r.record.id}`)
  }
  return (
    <form onSubmit={submit}>
      <PageHeader title="Raise a complaint" description={`Only delivered or partially delivered orders, within ${complaintWindowDays()} days of delivery. Batch, PO and vendor are filled from the order's batch allocations.`} actions={<><Button variant="secondary" to="/complaints">Cancel</Button><Button type="submit">Submit complaint</Button></>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Order and line" icon={PackageSearch} />
          {!orders.length && <p className="mb-3 rounded-lg bg-surface-2 p-3 text-sm text-muted">No delivered orders inside the complaint window are visible to you.</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Select label="Order" value={v.orderId} onChange={(e) => setV({ ...v, orderId: e.target.value, orderItemId: '', batches: {} })} error={errors.orderId} required placeholder="Choose a delivered order"
              options={orders.map((o) => ({ value: o.id, label: `${o.orderNumber} · ${o.customerName}` }))} />
            <Select label="Order line" value={v.orderItemId} onChange={(e) => setV({ ...v, orderItemId: e.target.value, batches: {} })} error={errors.orderItemId} required placeholder="Choose the product"
              options={lines.map((l) => ({ value: l.id, label: `${l.productName} · delivered ${l.delivered} ${l.unit}${l.complained ? ` (${l.complained} already complained)` : ''}` }))} />
            <Select label="Complaint type" value={v.type} onChange={set('type')} options={COMPLAINT_TYPES.map((x) => ({ value: x, label: x }))} error={errors.type} required />
            <Input label={`Affected quantity${line ? ` (${line.unit}, max ${line.open})` : ''}`} type="number" min="0" step="any" value={v.quantity} onChange={set('quantity')} error={errors.quantity} required />
            <Textarea label="Description" value={v.description} onChange={set('description')} error={errors.description} required rows={3} className="sm:col-span-2" />
          </div>
          {line && (
            <div className="mt-4">
              <p className="text-label">Batches that served this line</p>
              {line.batches.length === 0 && <p className="mt-1 text-sm text-muted">No batch allocation recorded for this line (delivered before batch tracking) — the complaint is recorded without a batch.</p>}
              {line.batches.length === 1 && <p className="mt-1 text-sm">Batch <b>{line.batches[0].batchNumber}</b> · PO {line.batches[0].poNumber || '—'} · {line.batches[0].vendorName || 'no vendor'}</p>}
              {line.batches.length > 1 && (
                <div className="mt-1 overflow-x-auto rounded-lg border border-line">
                  <table className="w-full text-sm"><thead className="bg-surface-2 text-left text-xs text-muted"><tr><th className="p-2">Batch</th><th className="p-2">Supplied</th><th className="p-2">PO</th><th className="p-2">Vendor</th><th className="p-2">Affected qty</th></tr></thead>
                    <tbody>{line.batches.map((b) => <tr key={b.batchId} className="border-t border-line"><td className="p-2 font-medium">{b.batchNumber}</td><td className="p-2 tabular">{b.quantity}</td><td className="p-2">{b.poNumber || '—'}</td><td className="p-2">{b.vendorName || '—'}</td><td className="p-2"><input type="number" min="0" step="any" aria-label={`Quantity from ${b.batchNumber}`} className="h-8 w-24 rounded border border-line bg-surface px-2" value={v.batches[b.batchId] || ''} onChange={(e) => setV({ ...v, batches: { ...v.batches, [b.batchId]: e.target.value } })} /></td></tr>)}</tbody>
                  </table>
                </div>
              )}
              {errors.batches && <p className="mt-1 text-xs text-danger">{errors.batches}</p>}
            </div>
          )}
        </Card>
        <Card>
          <CardHeader title="Contact & evidence" icon={Camera} />
          <div className="space-y-3">
            <Input label="Contact name" value={v.contactName} onChange={set('contactName')} />
            <Input label="Contact phone" value={v.contactPhone} onChange={set('contactPhone')} />
            <Input label="Complaint date" type="date" value={v.complaintDate} onChange={set('complaintDate')} />
            <div>
              <span className="text-label">Photos</span>
              <input type="file" accept="image/*" multiple onChange={(e) => addPhotos(e.target.files)} className="mt-1 block w-full text-sm" aria-label="Add photos" />
              {errors.photos && <p className="mt-1 text-xs text-danger">{errors.photos}</p>}
              <div className="mt-2 grid grid-cols-3 gap-2">{v.photos.map((p, i) => <img key={i} src={p.dataUrl} alt={p.name} className="aspect-square rounded-lg object-cover" />)}</div>
            </div>
          </div>
        </Card>
      </div>
    </form>
  )
}

export function ComplaintDetail() {
  const { id } = useParams()
  const { user } = useAuth()
  const list = useStoredValue(K.COMPLAINTS, NONE)
  const vendors = useStoredValue(K.VENDORS, NONE)
  const canManage = usePermission('complaints.manage')
  const canFinance = usePermission('finance.ar.manage')
  const [modal, setModal] = useState(null)
  const [form, setForm] = useState({ resolution: 'REPLACEMENT', remarks: '', refundAmount: '', refundMode: 'Bank transfer', reference: '' })
  const c = list.find((x) => x.id === id)
  if (!c || !canViewComplaint(user, c)) return <NotFoundRecord entity="complaint" backTo="/complaints" backLabel="Back to complaints" />
  const V = Object.fromEntries(vendors.map((v) => [v.id, v]))
  const run = (fn, ok) => { const r = fn(); if (!r.ok) { toast.error(r.error); return } toast.success(ok); setModal(null) }
  const open = ['OPEN', 'UNDER_INVESTIGATION'].includes(c.status)
  return (
    <>
      <PageHeader title={`${c.number} · ${c.type}`} description={`${c.customerName} · ${c.orderNumber} · raised by ${c.raisedByName} on ${formatDateTime(c.createdAt)}`}
        actions={canManage && <>
          {c.status === 'OPEN' && <Button variant="secondary" icon={Search} onClick={() => run(() => startInvestigation(c.id, { note: 'Investigation started' }), 'Investigation started')}>Start investigation</Button>}
          {open && <Button variant="danger-outline" icon={XCircle} onClick={() => setModal('reject')}>Reject</Button>}
          {open && <Button icon={CheckCircle2} onClick={() => setModal('resolve')}>Resolve</Button>}
          {['RESOLVED', 'REJECTED'].includes(c.status) && <Button variant="secondary" icon={Archive} onClick={() => run(() => closeComplaint(c.id, 'Closed'), 'Complaint closed')}>Close</Button>}
        </>}>
        <ToneBadge meta={COMPLAINT_STATUS} value={c.status} />
      </PageHeader>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Complaint" />
          <InfoList items={[
            { label: 'Order', value: <Link className="text-brand hover:underline" to={`/orders/${c.orderId}`}>{c.orderNumber}</Link> },
            { label: 'Invoice', value: c.invoiceId ? <Link className="text-brand hover:underline" to={`/invoices/${c.invoiceId}`}>{c.invoiceNumber}</Link> : 'Not invoiced yet' },
            { label: 'Product', value: c.productName }, { label: 'Quantity', value: `${c.quantity} ${c.unit}` },
            { label: 'Delivered', value: formatDateTime(c.deliveredAt) }, { label: 'Complaint date', value: formatDate(c.complaintDate) },
            { label: 'Contact', value: [c.contactName, c.contactPhone].filter(Boolean).join(' · ') || '—' }, { label: 'Assigned to', value: c.assignedToName || '—' },
            { label: 'Description', value: c.description, span: 2 },
          ]} />
          {(c.photos || []).length > 0 && <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-6">{c.photos.map((p, i) => <a key={i} href={p.dataUrl} download={p.name}><img src={p.dataUrl} alt={p.name} className="aspect-square rounded-lg object-cover" /></a>)}</div>}
        </Card>
        <Card>
          <CardHeader title="Traceability" icon={Factory} />
          {c.batches?.length ? <ul className="space-y-2 text-sm">{c.batches.map((b) => <li key={b.batchId} className="rounded-lg border border-line p-2"><b>{b.batchNumber}</b> · {b.quantity} {c.unit}<span className="block text-xs text-muted">PO {b.poId ? <Link className="text-brand hover:underline" to={`/procurement/purchase-orders/${b.poId}`}>{b.poNumber}</Link> : '— (opening / internal)'} · GRN {b.grnNumber || '—'}</span><span className="block text-xs text-muted">Vendor {b.vendorId ? <Link className="text-brand hover:underline" to={`/vendors/${b.vendorId}`}>{V[b.vendorId]?.name}</Link> : '—'} · exp {formatDate(b.expiryDate)}</span></li>)}</ul> : <p className="text-sm text-muted">No batch recorded.</p>}
          <div className="mt-3 border-t border-line pt-3">
            <Toggle checked={Boolean(c.vendorResponsible)} disabled={!canManage || !open} onChange={(val) => run(() => setVendorResponsible(c.id, val), val ? 'Counted against the vendor' : 'Not counted against the vendor')} label="Vendor responsible" description="Counts toward the vendor quality threshold." />
          </div>
        </Card>
        {c.resolution && (
          <Card className="lg:col-span-3">
            <CardHeader title={`Resolution: ${RESOLUTIONS.find((r) => r.value === c.resolution)?.label}`} />
            <InfoList columns={3} items={[
              { label: 'Remarks', value: c.resolutionRemarks, span: 2 }, { label: 'Resolved by', value: `${c.resolvedByName || '—'} · ${formatDateTime(c.resolvedAt)}` },
              { label: 'Replacement order', value: c.linkedOrderId ? <Link className="text-brand hover:underline" to={`/orders/${c.linkedOrderId}`}>{c.linkedOrderNumber}</Link> : '—', hidden: c.resolution !== 'REPLACEMENT' },
              { label: 'Credit note', value: c.creditNoteId ? <Link className="text-brand hover:underline" to={`/finance/credit-notes/${c.creditNoteId}`}>{c.creditNoteNumber}</Link> : '—', hidden: c.resolution !== 'CREDIT_NOTE' },
              { label: 'Refund', value: c.refund ? `${formatMoney(c.refund.amount)} · ${c.refund.mode} · ${c.refund.status}${c.refund.reference ? ` (${c.refund.reference})` : ''}` : '—', hidden: c.resolution !== 'REFUND' },
            ]} />
            {c.refund?.status === 'REQUESTED' && canFinance && <Button className="mt-3" size="sm" onClick={() => setModal('refund')}>Record refund payment</Button>}
          </Card>
        )}
        <Card className="lg:col-span-3"><CardHeader title="History" />
          <ul className="divide-y divide-line text-sm">{[...c.history].reverse().map((h) => <li key={h.id} className="py-2"><span className="font-medium">{h.action}</span>{h.note && <span className="text-muted"> — {h.note}</span>}<span className="block text-xs text-muted">{formatDateTime(h.at)} · {h.byName}</span></li>)}</ul>
        </Card>
      </div>
      <Modal open={modal === 'resolve'} onClose={() => setModal(null)} title={`Resolve ${c.number}`} icon={CheckCircle2}
        footer={<><Button variant="secondary" onClick={() => setModal(null)}>Cancel</Button><Button onClick={() => run(() => resolveComplaint(c.id, { ...form, refundAmount: form.refundAmount === '' ? undefined : Number(form.refundAmount) }), 'Complaint resolved')}>Resolve</Button></>}>
        <div className="space-y-3">
          <Select label="Resolution" value={form.resolution} onChange={(e) => setForm({ ...form, resolution: e.target.value })} options={RESOLUTIONS} />
          {form.resolution === 'REPLACEMENT' && <p className="text-xs text-muted">Creates a no-charge replacement order for {c.quantity} {c.unit} {c.productName}; it follows the normal approval, reservation and dispatch flow.</p>}
          {form.resolution === 'CREDIT_NOTE' && <p className="text-xs text-muted">Creates a draft credit note against {c.invoiceNumber || 'the invoice'} for the line value ({formatMoney(c.quantity * (c.unitPrice || 0))} incl. VAT). Finance approves it.</p>}
          {form.resolution === 'REFUND' && <div className="grid gap-3 sm:grid-cols-2"><Input label="Refund amount" type="number" value={form.refundAmount} onChange={(e) => setForm({ ...form, refundAmount: e.target.value })} placeholder={String(Math.round(c.quantity * (c.unitPrice || 0)))} /><Select label="Mode" value={form.refundMode} onChange={(e) => setForm({ ...form, refundMode: e.target.value })} options={['Bank transfer', 'Cash', 'Cheque', 'UPI'].map((x) => ({ value: x, label: x }))} /></div>}
          <Textarea label="Remarks" value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} required rows={3} />
        </div>
      </Modal>
      <Modal open={modal === 'reject'} onClose={() => setModal(null)} title={`Reject ${c.number}`} icon={XCircle}
        footer={<><Button variant="secondary" onClick={() => setModal(null)}>Cancel</Button><Button variant="danger" onClick={() => run(() => rejectComplaint(c.id, form.remarks), 'Complaint rejected')}>Reject</Button></>}>
        <Textarea label="Reason" value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} required rows={3} />
      </Modal>
      <Modal open={modal === 'refund'} onClose={() => setModal(null)} title="Record refund payment"
        footer={<><Button variant="secondary" onClick={() => setModal(null)}>Cancel</Button><Button onClick={() => run(() => markRefundPaid(c.id, form.reference), 'Refund recorded')}>Save</Button></>}>
        <Input label="Payment reference" value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} required />
      </Modal>
    </>
  )
}
