import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { TrendingUp, TrendingDown, Minus, GitCompareArrows, AlertOctagon, Zap, Star, Clock, ExternalLink } from 'lucide-react'
import { FilePlus2, PackagePlus, Truck, SlidersHorizontal, MessageSquareWarning, UserPlus, Repeat, Boxes } from 'lucide-react'
import dayjs from 'dayjs'
import PageHeader from '../../components/common/PageHeader'
import Card, { CardHeader } from '../../components/common/Card'
import Badge from '../../components/common/Badge'
import Button from '../../components/common/Button'
import Modal from '../../components/common/Modal'
import Input from '../../components/common/Input'
import Select from '../../components/common/Select'
import EmptyState from '../../components/common/EmptyState'
import { useStoredValue } from '../../hooks/useLocalStorage'
import { useAuth } from '../../hooks/useAuth'
import { can } from '../../config/permissions'
import { STORAGE_KEYS as K } from '../../utils/constants'
import { comparePeriods, defaultPeriods, formatKpi, KPI_FORMATS, OVERVIEWS, periodFrom } from '../../services/erp/compareService'
import { exceptionList, getPrefs, quickActionsFor, setKpiFormat } from '../../services/erp/workspaceService'
import { findNavItemById } from '../../config/navigation'
import { cn } from '../../utils/helpers'
import { formatDateTime } from '../../utils/formatters'

const NONE = []
const Icons = { FilePlus2, PackagePlus, Truck, SlidersHorizontal, MessageSquareWarning, UserPlus, Repeat, Boxes }

function PeriodPicker({ label, value, onChange }) {
  const now = dayjs()
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-xl border border-line p-2">
      <span className="w-full text-label">{label}</span>
      <Select aria-label={`${label} type`} value={value.type} onChange={(e) => {
        const t = e.target.value
        onChange(t === 'month' ? { type: t, value: now.format('YYYY-MM') } : t === 'quarter' ? { type: t, value: `${now.year()}-Q${Math.floor(now.month() / 3) + 1}` } : t === 'year' ? { type: t, value: String(now.year()) } : { type: 'custom', from: now.startOf('month').format('YYYY-MM-DD'), to: now.format('YYYY-MM-DD') })
      }} options={[{ value: 'month', label: 'Month' }, { value: 'quarter', label: 'Quarter' }, { value: 'year', label: 'Year' }, { value: 'custom', label: 'Custom' }]} className="w-28" />
      {value.type === 'month' && <Input aria-label={`${label} month`} type="month" value={value.value} onChange={(e) => onChange({ ...value, value: e.target.value })} className="w-40" />}
      {value.type === 'quarter' && <Select aria-label={`${label} quarter`} value={value.value} onChange={(e) => onChange({ ...value, value: e.target.value })} className="w-32" options={[0, 1, 2].flatMap((dy) => [4, 3, 2, 1].map((q) => `${now.year() - dy}-Q${q}`)).map((x) => ({ value: x, label: x.replace('-', ' ') }))} />}
      {value.type === 'year' && <Select aria-label={`${label} year`} value={value.value} onChange={(e) => onChange({ ...value, value: e.target.value })} className="w-28" options={[0, 1, 2, 3].map((dy) => String(now.year() - dy)).map((y) => ({ value: y, label: y }))} />}
      {value.type === 'custom' && <><Input aria-label={`${label} from`} type="date" value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} /><Input aria-label={`${label} to`} type="date" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} /></>}
    </div>
  )
}

/** Period A vs Period B comparison across every business area, with drill-down to the records. */
export function BusinessOverview() {
  const { user } = useAuth()
  // Re-render on data changes
  useStoredValue(K.ORDERS, NONE); useStoredValue(K.DELIVERIES, NONE); useStoredValue(K.INVOICES, NONE); useStoredValue(K.CUSTOMER_PAYMENTS, NONE); useStoredValue(K.COMPLAINTS, NONE)
  useStoredValue(K.USER_PREFS, {})
  const [p, setP] = useState(defaultPeriods)
  const [drill, setDrill] = useState(null)
  const fmt = getPrefs(user).kpiFormat || 'compact'
  const A = periodFrom(p.a)
  const B = periodFrom(p.b)
  const allowed = OVERVIEWS.filter((o) => o.permission.some((k) => can(user, k))).map((o) => o.id)
  const [only, setOnly] = useState('')
  const data = useMemo(() => (A && B ? comparePeriods(A, B, only ? [only] : allowed) : []), [A?.key, B?.key, only, allowed.join()]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <PageHeader title="Business overview — Period A vs Period B" description="Choose any two months, quarters, years or custom ranges. Every figure is calculated from the records of that period; click a KPI to see the records behind it." />
      <Card>
        <div className="grid gap-3 lg:grid-cols-[1fr_1fr_auto]">
          <PeriodPicker label="Period A" value={p.a} onChange={(a) => setP({ ...p, a })} />
          <PeriodPicker label="Period B (compare with)" value={p.b} onChange={(b) => setP({ ...p, b })} />
          <div className="flex flex-wrap items-end gap-2">
            <Select label="KPI format" value={fmt} onChange={(e) => setKpiFormat(e.target.value)} options={KPI_FORMATS} className="w-48" />
            <Select label="Area" value={only} onChange={(e) => setOnly(e.target.value)} options={OVERVIEWS.filter((o) => allowed.includes(o.id)).map((o) => ({ value: o.id, label: o.label }))} placeholder="All areas" className="w-40" />
          </div>
        </div>
        {(!A || !B) && <p className="mt-2 text-sm text-danger">Choose a valid period A and period B.</p>}
        {A && B && <p className="mt-2 text-xs text-muted"><b>A</b> {A.label} ({A.start.format('DD MMM YYYY')} – {A.end.format('DD MMM YYYY')}) · <b>B</b> {B.label} ({B.start.format('DD MMM YYYY')} – {B.end.format('DD MMM YYYY')})</p>}
      </Card>
      <div className="mt-4 space-y-4">
        {data.map((o) => (
          <Card key={o.id}>
            <CardHeader title={`${o.label} overview`} icon={GitCompareArrows} />
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {o.kpis.map((k) => {
                const good = k.cmp ? (k.invert ? k.cmp.dir === 'down' : k.cmp.dir === 'up') : null
                const Icon = k.cmp?.dir === 'up' ? TrendingUp : k.cmp?.dir === 'down' ? TrendingDown : Minus
                return (
                  <button key={k.id} type="button" onClick={() => setDrill(k)} className="rounded-xl border border-line bg-surface p-3 text-left transition hover:border-line-strong hover:shadow-pop focus-visible:border-brand" data-testid={`kpi-${k.id}`}>
                    <p className="text-[13px] font-medium text-muted">{k.label}{k.current && <span className="ml-1.5 rounded-full border border-line px-1.5 text-[9px] font-semibold uppercase">Current</span>}</p>
                    <p className="mt-1 truncate text-xl font-semibold text-ink tabular" title={String(k.a.value)}>{formatKpi(k.a.value, k.type, fmt === 'percentage' ? 'compact' : fmt)}</p>
                    {k.cmp ? (
                      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted tabular">
                        <span className={cn('inline-flex items-center gap-0.5 rounded px-1 py-px font-semibold', k.cmp.dir === 'flat' ? 'bg-surface-3 text-ink-2' : good ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger')}><Icon size={11} />{formatKpi(k.a.value, k.type, 'percentage', { cmp: k.cmp })}</span>
                        <span>{k.cmp.diff > 0 ? '+' : k.cmp.diff < 0 ? '−' : '±'}{formatKpi(Math.abs(k.cmp.diff), k.type, fmt === 'percentage' ? 'compact' : fmt)} vs B {formatKpi(k.b.value, k.type, fmt === 'percentage' ? 'compact' : fmt)}</span>
                      </p>
                    ) : <p className="mt-1 text-[11px] text-muted">Point-in-time value</p>}
                    <p className="mt-1 text-[11px] text-brand">{k.a.records.length} record(s) →</p>
                  </button>
                )
              })}
            </div>
          </Card>
        ))}
        {!data.length && A && B && <Card><EmptyState title="No overview available" description="Your role has no access to the business areas compared here." /></Card>}
      </div>
      <Modal open={Boolean(drill)} onClose={() => setDrill(null)} title={drill ? `${drill.label} — records` : ''} size="lg">
        {drill && <div className="grid gap-4 md:grid-cols-2">{[['A', A, drill.a], ...(drill.current ? [] : [['B', B, drill.b]])].map(([k, range, res]) => (
          <div key={k}><p className="mb-1 text-label">Period {k}: {range?.label} · {formatKpi(res.value, drill.type, fmt === 'percentage' ? 'full' : fmt)}</p>
            <ul className="max-h-80 divide-y divide-line overflow-y-auto scroll-thin text-sm">{res.records.slice(0, 200).map((r) => <li key={r.id} className="flex items-center justify-between gap-2 py-1.5"><span className="min-w-0"><Link to={r.link} className="font-medium text-brand hover:underline">{r.label}</Link><span className="block truncate text-xs text-muted">{r.sub}</span></span>{r.value !== undefined && r.value !== null && <span className="tabular text-xs">{Number(r.value).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>}</li>)}{!res.records.length && <li className="py-2 text-muted">No records.</li>}</ul>
          </div>))}</div>}
      </Modal>
    </>
  )
}

/** Exceptions that need someone's attention, from live data, filtered by permission. */
export function ExceptionsPage() {
  const { user } = useAuth()
  useStoredValue(K.ORDERS, NONE); useStoredValue(K.DELIVERIES, NONE); useStoredValue(K.COMPLAINTS, NONE); useStoredValue(K.BATCHES, NONE); useStoredValue(K.DRIVERS, NONE)
  const [kind, setKind] = useState('')
  const list = exceptionList(user)
  const kinds = [...new Set(list.map((x) => x.kind))]
  const rows = list.filter((x) => !kind || x.kind === kind)
  return (
    <>
      <PageHeader title="Exception dashboard" description="Failed and late deliveries, stock shortages, expired stock, unassigned orders, unavailable drivers and vehicles, complaints, overdue POs and payments, and customers without an available salesman." />
      <div className="mb-4 flex flex-wrap gap-2">
        <button type="button" onClick={() => setKind('')} className={cn('rounded-full border px-3 py-1 text-xs', !kind ? 'border-brand bg-brand/10 text-brand' : 'border-line')}>All ({list.length})</button>
        {kinds.map((k) => <button key={k} type="button" onClick={() => setKind(k)} className={cn('rounded-full border px-3 py-1 text-xs', kind === k ? 'border-brand bg-brand/10 text-brand' : 'border-line')}>{k} ({list.filter((x) => x.kind === k).length})</button>)}
      </div>
      <Card>
        {rows.length ? <ul className="divide-y divide-line">{rows.map((x) => (
          <li key={x.id} className="flex items-center gap-3 py-2.5">
            <AlertOctagon size={18} className={x.severity === 'high' ? 'text-danger' : x.severity === 'medium' ? 'text-warning' : 'text-muted'} aria-hidden />
            <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{x.title}</p><p className="truncate text-xs text-muted">{x.kind} · {x.detail}</p></div>
            <Badge tone={x.severity === 'high' ? 'danger' : x.severity === 'medium' ? 'warning' : 'neutral'}>{x.severity}</Badge>
            <Button size="xs" variant="secondary" iconRight={ExternalLink} to={x.path}>Open</Button>
          </li>
        ))}</ul> : <EmptyState title="No exceptions" description="Nothing needs attention right now." />}
      </Card>
    </>
  )
}

/** Quick actions, favourite pages and recent records of the signed-in user. */
export function WorkspaceHome() {
  const { user } = useAuth()
  useStoredValue(K.USER_PREFS, {})
  const prefs = getPrefs(user)
  const actions = quickActionsFor(user)
  const exc = exceptionList(user)
  return (
    <>
      <PageHeader title="My workspace" description="Quick actions, your favourite pages and the records you opened recently." />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2"><CardHeader title="Quick actions" icon={Zap} />
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{actions.map((a) => { const I = Icons[a.icon] || Zap; return <Link key={a.id} to={a.path} className="flex items-center gap-2 rounded-xl border border-line p-3 text-sm font-medium hover:border-brand hover:bg-brand/5"><I size={18} className="text-brand" />{a.label}</Link> })}</div>
        </Card>
        <Card><CardHeader title={`Exceptions (${exc.length})`} icon={AlertOctagon} action={<Button size="xs" variant="secondary" to="/exceptions">Open</Button>} />
          <ul className="space-y-1 text-sm">{exc.slice(0, 6).map((x) => <li key={x.id}><Link to={x.path} className="block truncate hover:text-brand"><span className={x.severity === 'high' ? 'text-danger' : 'text-warning'}>●</span> {x.title}</Link></li>)}{!exc.length && <li className="text-muted">All clear.</li>}</ul>
        </Card>
        <Card><CardHeader title="Favourite pages" icon={Star} />
          <ul className="space-y-1 text-sm">{prefs.favourites.map((id) => findNavItemById(id)).filter(Boolean).map((i) => <li key={i.id}><Link to={i.path} className="hover:text-brand">{i.label}</Link></li>)}{!prefs.favourites.length && <li className="text-muted">Use the ☆ next to a page title to pin it here.</li>}</ul>
        </Card>
        <Card className="lg:col-span-2"><CardHeader title="Recent activity" icon={Clock} />
          <ul className="divide-y divide-line text-sm">{prefs.recent.map((r) => <li key={r.path} className="flex justify-between py-1.5"><Link to={r.path} className="truncate hover:text-brand">{r.label}</Link><span className="shrink-0 text-xs text-muted">{formatDateTime(r.at)}</span></li>)}{!prefs.recent.length && <li className="py-2 text-muted">Pages you open appear here.</li>}</ul>
        </Card>
      </div>
    </>
  )
}
