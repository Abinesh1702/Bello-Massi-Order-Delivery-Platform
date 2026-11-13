import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Repeat, Plus, Pause, Play, XCircle, Pencil, CalendarDays, Trash2, Zap, ListOrdered } from 'lucide-react'
import { toast } from 'sonner'
import dayjs from 'dayjs'
import PageHeader from '../../components/common/PageHeader'
import Card, { CardHeader } from '../../components/common/Card'
import { StatusBadge } from '../../components/common/Badge'
import Button from '../../components/common/Button'
import Modal from '../../components/common/Modal'
import Input from '../../components/common/Input'
import Select from '../../components/common/Select'
import Textarea from '../../components/common/Textarea'
import DataTable from '../../components/common/DataTable'
import FilterToolbar from '../../components/common/FilterToolbar'
import InfoList from '../../components/common/InfoList'
import Tabs from '../../components/common/Tabs'
import EmptyState from '../../components/common/EmptyState'
import NotFoundRecord from '../../components/common/NotFoundRecord'
import { useStoredValue } from '../../hooks/useLocalStorage'
import { usePermission } from '../../hooks/usePermission'
import { useAuth } from '../../hooks/useAuth'
import { STORAGE_KEYS as K } from '../../utils/constants'
import { FREQUENCIES, generateDueOrders, generatedOrders, getRecurringById, occurrences, RECURRING_STATUS, saveRecurring, setRecurringStatus, toggleSkip, visibleRecurring, WEEKDAYS } from '../../services/erp/recurringService'
import { getSalesPeople } from '../../services/erp/salesAssignmentService'
import { formatDate, formatDateTime } from '../../utils/formatters'
import { QtyUnitInput, ToneBadge } from '../../components/erp/ErpUi'
import { uid } from '../../utils/helpers'

const NONE = []
const freqLabel = (r) => {
  if (r.frequency === 'DAILY') return 'Daily'
  if (r.frequency === 'WEEKLY') return `Weekly · ${(r.weekdays || []).map((d) => WEEKDAYS[d]).join(', ')}`
  if (r.frequency === 'FORTNIGHTLY') return `Fortnightly · ${(r.weekdays || []).map((d) => WEEKDAYS[d]).join(', ')}`
  if (r.frequency === 'MONTHLY') return `Monthly · day ${r.monthDay}`
  return `Every ${r.intervalDays} days`
}

export function RecurringList() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const list = useStoredValue(K.RECURRING_ORDERS, NONE)
  const customers = useStoredValue(K.CUSTOMERS, NONE)
  const orders = useStoredValue(K.ORDERS, NONE)
  const canManage = usePermission('recurring.manage')
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const C = Object.fromEntries(customers.map((c) => [c.id, c]))
  const mine = useMemo(() => visibleRecurring(user, list), [user, list])
  const rows = mine.filter((r) => (!status || r.status === status) && (!q || [r.number, r.name, C[r.customerId]?.name].some((x) => String(x || '').toLowerCase().includes(q.toLowerCase()))))
  const generate = () => { const r = generateDueOrders(); if (!r.ok) return toast.error(r.error); toast[r.errors.length ? 'warning' : 'success'](`${r.created.length} order(s) generated${r.errors.length ? ` · ${r.errors.length} need attention: ${r.errors[0]}` : ''}`) }
  return (
    <>
      <PageHeader title="Recurring orders" description="Standing schedules that generate ordinary orders (one per delivery slot) ahead of the delivery date. Generated orders go through approval, reservation, consolidation and dispatch like any other order."
        actions={canManage && <><Button variant="secondary" icon={Zap} onClick={generate}>Generate due orders</Button><Button icon={Plus} to="/orders/recurring/create">New schedule</Button></>} />
      <Card>
        <FilterToolbar query={q} onQuery={setQ} placeholder="Search schedule or customer…" total={mine.length} filteredCount={rows.length} activeCount={(q ? 1 : 0) + (status ? 1 : 0)} onReset={() => { setQ(''); setStatus('') }}>
          <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} options={Object.entries(RECURRING_STATUS).map(([v, m]) => ({ value: v, label: m.label }))} placeholder="All statuses" />
        </FilterToolbar>
        <DataTable rows={rows} pageSize="default" onRowClick={(r) => navigate(`/orders/recurring/${r.id}`)} empty={<EmptyState icon={Repeat} title="No recurring orders" description="Create a schedule for customers who order the same products regularly." />}
          columns={[
            { key: 'number', header: 'Schedule', render: (r) => <Link to={`/orders/recurring/${r.id}`} className="font-medium text-brand hover:underline">{r.number}<span className="block text-xs font-normal text-muted">{r.name}</span></Link> },
            { key: 'customer', header: 'Customer', render: (r) => C[r.customerId]?.name || '—' },
            { key: 'frequency', header: 'Frequency', render: freqLabel, hideBelow: 'md' },
            { key: 'slots', header: 'Slots', render: (r) => (r.slots || []).map((s) => s.time).join(', '), hideBelow: 'lg' },
            { key: 'period', header: 'Period', render: (r) => `${formatDate(r.startDate)} → ${r.endDate ? formatDate(r.endDate) : 'open'}`, hideBelow: 'xl' },
            { key: 'gen', header: 'Orders', align: 'right', render: (r) => orders.filter((o) => o.recurringOrderId === r.id).length },
            { key: 'status', header: 'Status', render: (r) => <ToneBadge meta={RECURRING_STATUS} value={r.status} /> },
          ]} />
      </Card>
    </>
  )
}

const blankSlot = (products) => ({ id: uid('sl'), slotId: 'slot-am', time: '08:00', lines: [{ id: uid('rl'), productId: products[0]?.id || '', quantity: '1', unit: products[0]?.unit || 'CTN' }] })

export function RecurringForm() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const customers = useStoredValue(K.CUSTOMERS, NONE)
  const products = useStoredValue(K.PRODUCTS, NONE)
  const hubs = useStoredValue(K.HUBS, NONE)
  const settings = useStoredValue(K.ERP_SETTINGS, {})
  const existing = id ? getRecurringById(id) : null
  const active = products.filter((p) => p.status === 'Active')
  const people = getSalesPeople()
  const [v, setV] = useState(() => existing ? { ...existing, slots: existing.slots.map((s) => ({ ...s, lines: s.lines.map((l) => ({ ...l, quantity: String(l.quantity) })) })) } : {
    name: '', customerId: '', hubId: '', salesmanId: ['SALESMAN', 'HORECA_SALES_EXEC'].includes(user.role) ? user.id : '', deliveryAddress: '', frequency: 'WEEKLY', weekdays: [1, 4], monthDay: 1, intervalDays: 3,
    startDate: dayjs().format('YYYY-MM-DD'), endDate: dayjs().add(3, 'month').format('YYYY-MM-DD'), notes: '', slots: [blankSlot(active)],
  })
  const [errors, setErrors] = useState({})
  if (id && !existing) return <NotFoundRecord entity="recurring order" backTo="/orders/recurring" backLabel="Back to recurring orders" />
  const P = Object.fromEntries(products.map((p) => [p.id, p]))
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value })
  const pickCustomer = (cid) => { const c = customers.find((x) => x.id === cid); setV({ ...v, customerId: cid, hubId: c?.hubId || v.hubId, salesmanId: v.salesmanId || c?.salesRepId || '', deliveryAddress: c ? [c.addressLine1, c.addressLine2, c.city].filter(Boolean).join(', ') : '', name: v.name || (c ? `${c.name} standing order` : '') }) }
  const setSlot = (i, patch) => setV({ ...v, slots: v.slots.map((s, j) => (j === i ? { ...s, ...patch } : s)) })
  const setLine = (i, j, patch) => setSlot(i, { lines: v.slots[i].lines.map((l, k) => (k === j ? { ...l, ...patch } : l)) })
  const save = (e) => {
    e.preventDefault()
    const r = saveRecurring({ ...v, slots: v.slots.map((s) => ({ ...s, lines: s.lines.map((l) => ({ ...l, quantity: Number(l.quantity) })) })) }, id || null)
    if (!r.ok) { setErrors(r.errors || {}); toast.error(r.error); return }
    toast.success(`${r.record.number} saved`)
    navigate(`/orders/recurring/${r.record.id}`)
  }
  return (
    <form onSubmit={save}>
      <PageHeader title={existing ? `Edit ${existing.number}` : 'New recurring order'} description={existing ? 'Changes apply to occurrences that are not generated yet — orders already generated (and completed ones) are not altered.' : 'Customer, schedule and one or more delivery slots, each with its own time and products.'}
        actions={<><Button variant="secondary" to={existing ? `/orders/recurring/${id}` : '/orders/recurring'}>Cancel</Button><Button type="submit">Save schedule</Button></>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader title="Customer & schedule" icon={CalendarDays} />
          <div className="space-y-3">
            <Select label="Customer" value={v.customerId} onChange={(e) => pickCustomer(e.target.value)} options={customers.filter((c) => c.status === 'Active').map((c) => ({ value: c.id, label: `${c.name} (${c.code})` }))} placeholder="Choose…" error={errors.customerId} required />
            <Input label="Schedule name" value={v.name} onChange={set('name')} />
            <Select label="Fulfilment hub" value={v.hubId} onChange={set('hubId')} options={hubs.map((h) => ({ value: h.id, label: h.name }))} error={errors.hubId} required />
            <Select label="Salesman" value={v.salesmanId} onChange={set('salesmanId')} options={people.map((p) => ({ value: p.id, label: p.name }))} placeholder="Customer's salesman" hint="If unavailable on the day, the customer's secondary salesman is used." />
            <Textarea label="Delivery address" value={v.deliveryAddress} onChange={set('deliveryAddress')} error={errors.deliveryAddress} rows={2} required />
            <Select label="Frequency" value={v.frequency} onChange={set('frequency')} options={FREQUENCIES} error={errors.frequency} />
            {['WEEKLY', 'FORTNIGHTLY'].includes(v.frequency) && <div><span className="text-label">Weekdays</span><div className="mt-1 flex flex-wrap gap-1">{WEEKDAYS.map((d, i) => <button key={d} type="button" onClick={() => setV({ ...v, weekdays: v.weekdays.includes(i) ? v.weekdays.filter((x) => x !== i) : [...v.weekdays, i] })} className={`h-8 w-11 rounded-lg border text-xs ${v.weekdays.includes(i) ? 'border-brand bg-brand/10 text-brand' : 'border-line'}`}>{d}</button>)}</div>{errors.weekdays && <p className="text-xs text-danger">{errors.weekdays}</p>}</div>}
            {v.frequency === 'MONTHLY' && <Input label="Day of month" type="number" min="1" max="31" value={v.monthDay} onChange={set('monthDay')} error={errors.monthDay} />}
            {v.frequency === 'CUSTOM' && <Input label="Every N days" type="number" min="1" value={v.intervalDays} onChange={set('intervalDays')} error={errors.intervalDays} />}
            <div className="grid grid-cols-2 gap-2"><Input label="Start" type="date" value={v.startDate} onChange={set('startDate')} error={errors.startDate} /><Input label="End" type="date" value={v.endDate} onChange={set('endDate')} error={errors.endDate} /></div>
            <Textarea label="Notes" value={v.notes} onChange={set('notes')} rows={2} />
          </div>
        </Card>
        <div className="space-y-4 lg:col-span-2">
          {v.slots.map((s, i) => (
            <Card key={s.id}>
              <CardHeader title={`Delivery slot ${i + 1}`} action={v.slots.length > 1 && <Button size="xs" variant="ghost" icon={Trash2} onClick={() => setV({ ...v, slots: v.slots.filter((_, j) => j !== i) })}>Remove slot</Button>} />
              <div className="grid gap-3 sm:grid-cols-3">
                <Select label="Slot" value={s.slotId} onChange={(e) => { const sl = (settings.deliverySlots || []).find((x) => x.id === e.target.value); setSlot(i, { slotId: e.target.value, time: sl?.from || s.time }) }} options={(settings.deliverySlots || []).map((x) => ({ value: x.id, label: `${x.label} ${x.from}–${x.to}` }))} />
                <Input label="Delivery time" type="time" value={s.time} onChange={(e) => setSlot(i, { time: e.target.value })} error={errors[`slots.${i}.time`]} />
              </div>
              <div className="mt-3 space-y-2">
                {s.lines.map((l, j) => (
                  <div key={l.id} className="grid items-end gap-2 sm:grid-cols-[1fr_200px_auto]">
                    <Select label={j === 0 ? 'Product' : undefined} aria-label="Product" value={l.productId} onChange={(e) => setLine(i, j, { productId: e.target.value, unit: P[e.target.value]?.salesUnit || P[e.target.value]?.unit })} options={active.map((p) => ({ value: p.id, label: `${p.name} · ${p.sku}` }))} error={errors[`slots.${i}.lines.${j}`]} />
                    <QtyUnitInput product={P[l.productId]} value={{ quantity: l.quantity, unit: l.unit }} onChange={(x) => setLine(i, j, { quantity: x.quantity, unit: x.unit })} compact={j > 0} />
                    <Button size="sm" variant="ghost" icon={Trash2} aria-label="Remove product" onClick={() => setSlot(i, { lines: s.lines.length > 1 ? s.lines.filter((_, k) => k !== j) : s.lines })} />
                  </div>
                ))}
                {errors[`slots.${i}.lines`] && <p className="text-xs text-danger">{errors[`slots.${i}.lines`]}</p>}
                <Button size="sm" variant="secondary" icon={Plus} onClick={() => setSlot(i, { lines: [...s.lines, { id: uid('rl'), productId: '', quantity: '1', unit: 'CTN' }] })}>Add product</Button>
              </div>
            </Card>
          ))}
          {errors.slots && <p className="text-sm text-danger">{errors.slots}</p>}
          <Button variant="secondary" icon={Plus} onClick={() => setV({ ...v, slots: [...v.slots, { ...blankSlot(active), slotId: 'slot-pm', time: '15:00' }] })}>Add delivery slot</Button>
        </div>
      </div>
    </form>
  )
}

export function RecurringDetail() {
  const { id } = useParams()
  const list = useStoredValue(K.RECURRING_ORDERS, NONE)
  const customers = useStoredValue(K.CUSTOMERS, NONE)
  const orders = useStoredValue(K.ORDERS, NONE)
  const products = useStoredValue(K.PRODUCTS, NONE)
  const hubs = useStoredValue(K.HUBS, NONE)
  const canManage = usePermission('recurring.manage')
  const [tab, setTab] = useState('calendar')
  const [cancel, setCancel] = useState(false)
  const [reason, setReason] = useState('')
  const [month, setMonth] = useState(dayjs().startOf('month'))
  const r = list.find((x) => x.id === id)
  const occ = useMemo(() => (r ? occurrences(r, month, month.daysInMonth(), orders) : []), [r, month, orders])
  if (!r) return <NotFoundRecord entity="recurring order" backTo="/orders/recurring" backLabel="Back to recurring orders" />
  const C = customers.find((c) => c.id === r.customerId)
  const P = Object.fromEntries(products.map((p) => [p.id, p]))
  const gen = generatedOrders(r, orders)
  const act = (a, why) => { const res = setRecurringStatus(r.id, a, why); if (!res.ok) return toast.error(res.error); toast.success(`${r.number} ${res.record.status.toLowerCase()}`); setCancel(false) }
  const generate = () => { const res = generateDueOrders({ ids: [r.id] }); if (!res.ok) return toast.error(res.error); toast[res.errors.length ? 'warning' : 'success'](`${res.created.length} order(s) generated${res.errors.length ? ` · ${res.errors[0]}` : ''}`) }
  const first = month.startOf('month')
  const cells = Array.from({ length: first.day() + month.daysInMonth() }, (_, i) => (i < first.day() ? null : first.add(i - first.day(), 'day')))
  return (
    <>
      <PageHeader title={`${r.number} · ${r.name}`} description={`${C?.name || '—'} · ${freqLabel(r)} · ${formatDate(r.startDate)} → ${r.endDate ? formatDate(r.endDate) : 'open'}`}
        actions={canManage && <>
          {r.status === 'ACTIVE' && <Button variant="secondary" icon={Zap} onClick={generate}>Generate due</Button>}
          {r.status === 'ACTIVE' && <Button variant="secondary" icon={Pause} onClick={() => act('pause')}>Pause</Button>}
          {r.status === 'PAUSED' && <Button variant="secondary" icon={Play} onClick={() => act('resume')}>Resume</Button>}
          {r.status !== 'CANCELLED' && <Button variant="secondary" icon={Pencil} to={`/orders/recurring/${r.id}/edit`}>Edit schedule</Button>}
          {r.status !== 'CANCELLED' && <Button variant="danger-outline" icon={XCircle} onClick={() => setCancel(true)}>Cancel</Button>}
        </>}>
        <ToneBadge meta={RECURRING_STATUS} value={r.status} />
      </PageHeader>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card><CardHeader title="Schedule" />
          <InfoList columns={1} items={[{ label: 'Customer', value: C ? <Link className="text-brand hover:underline" to={`/customers/${C.id}`}>{C.name}</Link> : '—' }, { label: 'Hub', value: hubs.find((h) => h.id === r.hubId)?.name }, { label: 'Delivery address', value: r.deliveryAddress }, { label: 'Last generated', value: r.lastGeneratedAt ? formatDateTime(r.lastGeneratedAt) : 'Not yet' }]} />
        </Card>
        <Card className="lg:col-span-2"><CardHeader title="Delivery slots" />
          <div className="grid gap-3 sm:grid-cols-2">{r.slots.map((s) => <div key={s.id} className="rounded-xl border border-line p-3"><p className="font-semibold">{s.time}</p><ul className="mt-1 text-sm">{s.lines.map((l) => <li key={l.id} className="flex justify-between"><span>{P[l.productId]?.name}</span><span className="tabular text-muted">{l.quantity} {l.unit}</span></li>)}</ul></div>)}</div>
        </Card>
      </div>
      <Tabs className="mt-5" value={tab} onChange={setTab} tabs={[{ id: 'calendar', label: 'Calendar', icon: CalendarDays }, { id: 'orders', label: `Generated orders (${gen.length})`, icon: ListOrdered }, { id: 'history', label: 'History' }]} />
      <div className="mt-4">
        {tab === 'calendar' && (
          <Card>
            <div className="mb-3 flex items-center justify-between"><Button size="sm" variant="secondary" onClick={() => setMonth(month.subtract(1, 'month'))}>‹</Button><span className="font-semibold">{month.format('MMMM YYYY')}</span><Button size="sm" variant="secondary" onClick={() => setMonth(month.add(1, 'month'))}>›</Button></div>
            <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-muted">{WEEKDAYS.map((d) => <span key={d}>{d}</span>)}</div>
            <div className="mt-1 grid grid-cols-7 gap-1">
              {cells.map((d, i) => {
                if (!d) return <span key={i} />
                const items = occ.filter((o) => o.date === d.format('YYYY-MM-DD'))
                return (
                  <div key={i} className={`min-h-[72px] rounded-lg border p-1 text-left ${d.isSame(dayjs(), 'day') ? 'border-brand' : 'border-line'}`}>
                    <span className="text-[11px] text-muted">{d.date()}</span>
                    {items.map((o) => (
                      <button key={o.key} type="button" disabled={!canManage || Boolean(o.orderId)} onClick={() => { const res = toggleSkip(r.id, o.key); if (!res.ok) toast.error(res.error) }} title={o.orderId ? o.orderNumber : o.skipped ? 'Skipped — click to restore' : 'Click to skip this delivery'}
                        className={`mt-0.5 block w-full truncate rounded px-1 text-[10.5px] ${o.orderId ? 'bg-success/15 text-success' : o.skipped ? 'bg-surface-3 text-muted line-through' : 'bg-brand/10 text-brand'}`}>
                        {o.slot.time} {o.orderNumber ? `· ${o.orderNumber.slice(-5)}` : ''}
                      </button>
                    ))}
                  </div>
                )
              })}
            </div>
            <p className="mt-2 text-xs text-muted">Blue = scheduled · green = order generated · struck through = skipped. Click a scheduled delivery to skip it.</p>
          </Card>
        )}
        {tab === 'orders' && <Card><DataTable rows={gen} pageSize={10} columns={[
          { key: 'orderNumber', header: 'Order', render: (o) => <Link to={`/orders/${o.id}`} className="font-medium text-brand hover:underline">{o.orderNumber}</Link> },
          { key: 'requestedDeliveryDate', header: 'Delivery', render: (o) => `${formatDate(o.requestedDeliveryDate)} ${o.requestedDeliveryTime || ''}` },
          { key: 'salesmanName', header: 'Salesman', hideBelow: 'md' }, { key: 'totalAmount', header: 'Value', align: 'right', render: (o) => Math.round(o.totalAmount).toLocaleString('en-IN') },
          { key: 'orderStatus', header: 'Status', render: (o) => <StatusBadge status={o.orderStatus} /> },
        ]} /></Card>}
        {tab === 'history' && <Card><ul className="divide-y divide-line text-sm">{[...(r.history || [])].reverse().map((h) => <li key={h.id || h.at} className="py-2"><span className="font-medium">{h.action}</span>{h.note && <span className="text-muted"> — {h.note}</span>}<span className="block text-xs text-muted">{formatDateTime(h.at)} · {h.byName}</span></li>)}</ul></Card>}
      </div>
      <Modal open={cancel} onClose={() => setCancel(false)} title={`Cancel ${r.number}`} footer={<><Button variant="secondary" onClick={() => setCancel(false)}>Keep</Button><Button variant="danger" onClick={() => act('cancel', reason)}>Cancel schedule</Button></>}>
        <p className="mb-3 text-sm text-muted">No further orders are generated. Orders already generated stay as they are — cancel them individually if needed.</p>
        <Textarea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} required rows={3} />
      </Modal>
    </>
  )
}
