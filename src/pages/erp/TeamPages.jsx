import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarClock, UserX, ShieldBan, Plus, Trash2, Users, ArrowRightLeft, History, BadgeCheck } from 'lucide-react'
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
import Checkbox from '../../components/common/Checkbox'
import DataTable from '../../components/common/DataTable'
import FilterToolbar from '../../components/common/FilterToolbar'
import StatCard, { StatGrid } from '../../components/dashboard/StatCard'
import { useStoredValue } from '../../hooks/useLocalStorage'
import { usePermission } from '../../hooks/usePermission'
import { useAuth } from '../../hooks/useAuth'
import { STORAGE_KEYS as K } from '../../utils/constants'
import { addOfflinePeriod, driverCalendar, driverStatusAt, DRIVER_STATUS_TONE, OFFLINE_REASONS, overrideAvailability, removeOfflinePeriod, setDriverSuspended } from '../../services/erp/fleetService'
import { assignSalesmen, effectiveSalesman, getSalesPeople, handOver, personName, REP_STATUSES, salesmanAvailability, setRepStatus } from '../../services/erp/salesAssignmentService'
import { formatDateTime } from '../../utils/formatters'
import { cn } from '../../utils/helpers'

const NONE = []
const DAY_TONE = { Available: 'bg-success/15 text-success', Assigned: 'bg-info/15 text-info', 'On Delivery': 'bg-info/25 text-info', 'On Leave': 'bg-warning/20 text-warning', Offline: 'bg-surface-3 text-muted', Suspended: 'bg-danger/15 text-danger', Inactive: 'bg-surface-3 text-muted' }

/* ------------------------------------------------------------------ Driver availability */
export function DriverAvailabilityPage() {
  const { user } = useAuth()
  const drivers = useStoredValue(K.DRIVERS, NONE)
  const dispatches = useStoredValue(K.DISPATCHES, NONE)
  const hubs = useStoredValue(K.HUBS, NONE)
  const canManage = usePermission('drivers.availability.manage')
  const isAdmin = ['ADMIN', 'SUPER_ADMIN'].includes(user.role)
  const [hubId, setHubId] = useState('')
  const [from, setFrom] = useState(dayjs().format('YYYY-MM-DD'))
  const [modal, setModal] = useState(null)
  const [form, setForm] = useState({})
  const list = drivers.filter((d) => !hubId || d.hubId === hubId)
  const days = Array.from({ length: 14 }, (_, i) => dayjs(from).add(i, 'day'))
  const status = Object.fromEntries(drivers.map((d) => [d.id, driverStatusAt(d, dayjs(), dispatches)]))
  const count = (s) => drivers.filter((d) => status[d.id] === s).length
  const open = (type, d, extra = {}) => { setModal({ type, driver: d }); setForm({ from: dayjs().hour(8).minute(0).format('YYYY-MM-DDTHH:mm'), to: dayjs().add(1, 'day').hour(20).minute(0).format('YYYY-MM-DDTHH:mm'), reason: 'Sick leave', type: 'Leave', remarks: '', date: from, ...extra }) }
  const run = (fn, ok) => { const r = fn(); if (!r.ok) return toast.error(r.error); toast.success(ok); setModal(null) }
  return (
    <>
      <PageHeader title="Driver availability" description="Offline and leave periods with dates and times, suspensions and a 14-day calendar. Unavailable drivers cannot be assigned; overlapping assignments are refused. Admins may override one day with a reason." />
      <StatGrid cols={5}>
        {['Available', 'Assigned', 'On Delivery', 'On Leave', 'Offline'].map((s) => <StatCard key={s} label={s} value={count(s)} icon={s === 'Available' ? BadgeCheck : s === 'Offline' || s === 'On Leave' ? UserX : CalendarClock} tone={{ Available: 'success', Assigned: 'info', 'On Delivery': 'info', 'On Leave': 'warning', Offline: 'neutral' }[s]} />)}
      </StatGrid>
      <Card className="mt-4">
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <Select label="Hub" value={hubId} onChange={(e) => setHubId(e.target.value)} options={hubs.map((h) => ({ value: h.id, label: h.name }))} placeholder="All hubs" className="w-56" />
          <Input label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <div className="ml-auto flex flex-wrap gap-2 text-[11px]">{Object.keys(DAY_TONE).map((s) => <span key={s} className={cn('rounded px-1.5 py-0.5', DAY_TONE[s])}>{s}</span>)}</div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1000px] text-xs">
            <thead><tr><th className="sticky left-0 bg-surface p-1 text-left">Driver</th><th className="p-1 text-left">Now</th>{days.map((d) => <th key={d.format()} className={cn('p-1 text-center font-medium', d.isSame(dayjs(), 'day') && 'text-brand')}>{d.format('dd D')}</th>)}<th /></tr></thead>
            <tbody>{list.map((d) => {
              const cal = driverCalendar(d, { from, days: 14, dispatches })
              return (
                <tr key={d.id} className="border-t border-line">
                  <td className="sticky left-0 bg-surface p-1"><Link to={`/dispatch/drivers/${d.id}`} className="font-medium text-ink hover:text-brand">{d.name}</Link><span className="block text-[10px] text-muted">{hubs.find((h) => h.id === d.hubId)?.code}</span></td>
                  <td className="p-1"><Badge tone={DRIVER_STATUS_TONE[status[d.id]]}>{status[d.id]}</Badge></td>
                  {cal.map((c) => <td key={c.date} className="p-0.5"><button type="button" title={`${c.status}${c.note ? ` — ${c.note}` : ''}`} disabled={!(isAdmin && c.periodId)} onClick={() => open('override', d, { date: c.date })} className={cn('h-7 w-full rounded text-[10px]', DAY_TONE[c.status], isAdmin && c.periodId && 'ring-1 ring-warning hover:brightness-95')}>{c.status === 'Available' ? '' : c.status.split(' ').map((x) => x[0]).join('')}</button></td>)}
                  <td className="p-1 text-right whitespace-nowrap">{canManage && <><Button size="xs" variant="secondary" icon={Plus} onClick={() => open('offline', d)}>Offline</Button>{' '}<Button size="xs" variant="ghost" icon={History} onClick={() => setModal({ type: 'history', driver: d })}>Periods</Button>{' '}<Button size="xs" variant={d.suspended ? 'secondary' : 'danger-outline'} icon={ShieldBan} onClick={() => (d.suspended ? run(() => setDriverSuspended(d.id, false), 'Suspension lifted') : open('suspend', d))}>{d.suspended ? 'Unsuspend' : 'Suspend'}</Button></>}</td>
                </tr>
              )
            })}</tbody>
          </table>
        </div>
        {isAdmin && <p className="mt-2 text-xs text-muted">Admin: click an outlined Offline / Leave day to override it for one day (reason required, audited).</p>}
      </Card>
      <Modal open={modal?.type === 'offline'} onClose={() => setModal(null)} title={`Offline / leave — ${modal?.driver?.name}`} icon={CalendarClock}
        footer={<><Button variant="secondary" onClick={() => setModal(null)}>Cancel</Button><Button onClick={() => run(() => addOfflinePeriod(modal.driver.id, { ...form, from: new Date(form.from).toISOString(), to: new Date(form.to).toISOString() }), 'Period recorded')}>Save</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Type" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} options={[{ value: 'Leave', label: 'On leave' }, { value: 'Offline', label: 'Offline' }]} />
          <Select label="Reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} options={OFFLINE_REASONS.map((x) => ({ value: x, label: x }))} />
          <Input label="From" type="datetime-local" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />
          <Input label="To" type="datetime-local" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />
          <Textarea label="Remarks" value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} rows={2} className="sm:col-span-2" />
        </div>
      </Modal>
      <Modal open={modal?.type === 'suspend'} onClose={() => setModal(null)} title={`Suspend ${modal?.driver?.name}`} icon={ShieldBan}
        footer={<><Button variant="secondary" onClick={() => setModal(null)}>Cancel</Button><Button variant="danger" onClick={() => run(() => setDriverSuspended(modal.driver.id, true, form.remarks), 'Driver suspended')}>Suspend</Button></>}>
        <Textarea label="Reason" value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} required rows={3} />
      </Modal>
      <Modal open={modal?.type === 'override'} onClose={() => setModal(null)} title={`Override availability — ${modal?.driver?.name}, ${form.date}`}
        footer={<><Button variant="secondary" onClick={() => setModal(null)}>Cancel</Button><Button onClick={() => run(() => overrideAvailability(modal.driver.id, form.date, form.remarks), 'Override recorded')}>Allow assignment</Button></>}>
        <p className="mb-3 text-sm text-muted">The driver can be assigned on this date despite the offline / leave period. Suspended and inactive drivers cannot be overridden.</p>
        <Textarea label="Reason" value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} required rows={3} />
      </Modal>
      <Modal open={modal?.type === 'history'} onClose={() => setModal(null)} title={`${modal?.driver?.name} — periods & history`} size="lg">
        {modal?.driver && (() => { const d = drivers.find((x) => x.id === modal.driver.id) || modal.driver; return (
          <div className="space-y-4">
            <ul className="divide-y divide-line text-sm">{(d.offlinePeriods || []).map((p) => <li key={p.id} className="flex items-center justify-between gap-2 py-2"><span><b>{p.type}</b> {formatDateTime(p.from)} → {formatDateTime(p.to)} · {p.reason}{p.remarks && ` — ${p.remarks}`}</span>{canManage && <Button size="xs" variant="ghost" icon={Trash2} onClick={() => { const r = removeOfflinePeriod(d.id, p.id); if (!r.ok) toast.error(r.error) }}>Remove</Button>}</li>)}{!(d.offlinePeriods || []).length && <li className="py-2 text-muted">No periods.</li>}</ul>
            <div><p className="text-label">History</p><ul className="mt-1 space-y-1 text-xs text-muted">{(d.availabilityHistory || []).map((h) => <li key={h.id}>{formatDateTime(h.at)} · {h.byName} · {h.note}</li>)}</ul></div>
          </div>) })()}
      </Modal>
    </>
  )
}

/* ------------------------------------------------------------------ Salesman assignments */
export function SalesAssignmentPage() {
  const customers = useStoredValue(K.CUSTOMERS, NONE)
  useStoredValue(K.DEMO_DATA, {})
  useStoredValue(K.LEAVE_REQUESTS, NONE)
  const users = useStoredValue(K.DEMO_USERS, NONE)
  const canManage = usePermission('customers.assignment.manage')
  const [q, setQ] = useState('')
  const [only, setOnly] = useState('')
  const [edit, setEdit] = useState(null)
  const [hand, setHand] = useState(null)
  const people = getSalesPeople()
  const managers = users.filter((u) => ['SALES_MANAGER', 'ADMIN'].includes(u.role))
  const rows = useMemo(() => customers.filter((c) => c.status !== 'Inactive').map((c) => ({ ...c, eff: effectiveSalesman(c) })).filter((c) => (!only || c.eff.role !== 'primary') && (!q || [c.name, c.code, personName(c.salesRepId)].some((x) => String(x || '').toLowerCase().includes(q.toLowerCase())))), [customers, q, only]) // eslint-disable-line react-hooks/exhaustive-deps
  const save = () => { const r = assignSalesmen(edit.id, edit.form); if (!r.ok) return toast.error(r.error); toast.success(`${edit.name} reassigned`); setEdit(null) }
  return (
    <>
      <PageHeader title="Salesman assignments" description="Primary and secondary salesman per customer. When the primary is on leave, resigned, terminated or inactive the secondary covers automatically; when both are unavailable the Sales Manager is notified and responsible until the customer is reassigned." />
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <FilterToolbar query={q} onQuery={setQ} placeholder="Search customer or salesman…" total={customers.length} filteredCount={rows.length} activeCount={only ? 1 : 0} onReset={() => { setQ(''); setOnly('') }}>
            <Select aria-label="Coverage" value={only} onChange={(e) => setOnly(e.target.value)} options={[{ value: 'x', label: 'Needs attention' }]} placeholder="All customers" />
          </FilterToolbar>
          <DataTable rows={rows} pageSize="default" columns={[
            { key: 'name', header: 'Customer', render: (c) => <Link to={`/customers/${c.id}`} className="font-medium text-brand hover:underline">{c.name}<span className="block text-xs font-normal text-muted">{c.code} · {c.salesTeam}</span></Link> },
            { key: 'p', header: 'Primary', render: (c) => { const a = salesmanAvailability(c.salesRepId); return <span>{personName(c.salesRepId)}{!a.available && <Badge tone="warning" className="ml-1">{a.status}</Badge>}</span> } },
            { key: 's', header: 'Secondary', hideBelow: 'md', render: (c) => (c.secondarySalesRepId ? personName(c.secondarySalesRepId) : <span className="text-muted">—</span>) },
            { key: 'e', header: 'Covering today', render: (c) => <span title={c.eff.reason}><Badge tone={{ primary: 'success', secondary: 'warning', manager: 'danger' }[c.eff.role]}>{personName(c.eff.salesmanId)}</Badge></span> },
            ...(canManage ? [{ key: 'act', header: '', align: 'right', render: (c) => <Button size="xs" variant="secondary" icon={ArrowRightLeft} onClick={() => setEdit({ id: c.id, name: c.name, history: c.assignmentHistory || [], form: { primaryId: c.salesRepId, secondaryId: c.secondarySalesRepId || '', salesTeam: c.salesTeam || '', salesManagerId: c.salesManagerId || '', reason: '', manualOverride: false } })}>Reassign</Button> }] : []),
          ]} />
        </Card>
        <Card>
          <CardHeader title="Sales team" icon={Users} />
          <ul className="divide-y divide-line text-sm">{people.map((p) => { const a = salesmanAvailability(p.id); const n = customers.filter((c) => c.salesRepId === p.id).length; return (
            <li key={p.id} className="py-2">
              <div className="flex items-center justify-between gap-2"><span className="font-medium">{p.name}</span><Badge tone={a.available ? 'success' : 'warning'}>{a.status}</Badge></div>
              <p className="text-xs text-muted">{n} customer(s) as primary{a.reason && a.reason !== a.status ? ` · ${a.reason}` : ''}</p>
              {canManage && <div className="mt-1 flex flex-wrap gap-1">
                {!p.userId || p.id !== p.userId ? <select aria-label={`Status of ${p.name}`} className="h-7 rounded border border-line bg-surface px-1 text-xs" value={p.status || 'Active'} onChange={(e) => { const r = setRepStatus(p.id, e.target.value, 'Updated on the Sales Team page'); if (!r.ok) toast.error(r.error); else toast.success(`${p.name}: ${e.target.value}`) }}>{REP_STATUSES.map((s) => <option key={s}>{s}</option>)}</select> : <span className="text-[11px] text-muted">Status follows the user account & HR leave</span>}
                {n > 0 && <Button size="xs" variant="ghost" onClick={() => setHand({ fromId: p.id, toId: '', secondaryId: '', reason: '' })}>Hand over customers</Button>}
              </div>}
            </li>) })}</ul>
        </Card>
      </div>
      <Modal open={Boolean(edit)} onClose={() => setEdit(null)} title={`Reassign ${edit?.name}`} icon={ArrowRightLeft} size="lg"
        footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={save}>Save assignment</Button></>}>
        {edit && <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Primary salesman" value={edit.form.primaryId} onChange={(e) => setEdit({ ...edit, form: { ...edit.form, primaryId: e.target.value } })} options={people.map((p) => ({ value: p.id, label: `${p.name}${salesmanAvailability(p.id).available ? '' : ` (${salesmanAvailability(p.id).status})`}` }))} />
          <Select label="Secondary salesman" value={edit.form.secondaryId} onChange={(e) => setEdit({ ...edit, form: { ...edit.form, secondaryId: e.target.value } })} options={people.map((p) => ({ value: p.id, label: p.name }))} placeholder="None" />
          <Input label="Sales team" value={edit.form.salesTeam} onChange={(e) => setEdit({ ...edit, form: { ...edit.form, salesTeam: e.target.value } })} />
          <Select label="Sales manager" value={edit.form.salesManagerId} onChange={(e) => setEdit({ ...edit, form: { ...edit.form, salesManagerId: e.target.value } })} options={managers.map((u) => ({ value: u.id, label: u.name }))} />
          <Textarea label="Reason" value={edit.form.reason} onChange={(e) => setEdit({ ...edit, form: { ...edit.form, reason: e.target.value } })} rows={2} required className="sm:col-span-2" />
          <Checkbox label="Manual override (assign even if the primary is unavailable)" checked={edit.form.manualOverride} onChange={(e) => setEdit({ ...edit, form: { ...edit.form, manualOverride: e.target.checked } })} className="sm:col-span-2" />
          <div className="sm:col-span-2"><p className="text-label">Assignment history</p><ul className="mt-1 max-h-40 space-y-1 overflow-y-auto text-xs text-muted">{edit.history.map((h) => <li key={h.id}>{formatDateTime(h.at)} · {h.byName}: {personName(h.fromPrimary)} → {personName(h.toPrimary)} (sec. {personName(h.toSecondary)}) — {h.reason}{h.manualOverride ? ' · override' : ''}</li>)}{!edit.history.length && <li>No changes yet.</li>}</ul></div>
        </div>}
      </Modal>
      <Modal open={Boolean(hand)} onClose={() => setHand(null)} title={`Hand over customers of ${personName(hand?.fromId)}`}
        footer={<><Button variant="secondary" onClick={() => setHand(null)}>Cancel</Button><Button onClick={() => { const r = handOver(hand.fromId, hand.toId, { secondaryId: hand.secondaryId || null, reason: hand.reason }); if (!r.ok) return toast.error(r.error); toast.success(`${r.count} customer(s) moved`); setHand(null) }}>Move customers</Button></>}>
        {hand && <div className="grid gap-3">
          <Select label="New primary" value={hand.toId} onChange={(e) => setHand({ ...hand, toId: e.target.value })} options={people.filter((p) => p.id !== hand.fromId).map((p) => ({ value: p.id, label: p.name }))} placeholder="Choose…" />
          <Select label="Secondary (optional)" value={hand.secondaryId} onChange={(e) => setHand({ ...hand, secondaryId: e.target.value })} options={people.filter((p) => p.id !== hand.toId).map((p) => ({ value: p.id, label: p.name }))} placeholder="Keep current" />
          <Textarea label="Reason" value={hand.reason} onChange={(e) => setHand({ ...hand, reason: e.target.value })} rows={2} />
        </div>}
      </Modal>
    </>
  )
}
