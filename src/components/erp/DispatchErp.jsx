/**
 * Dispatch execution panels (data v11): FEFO batch plan with override, capacity-checked incremental loading with
 * route grouping, live route map (hub H + numbered stops, simulated / manual position) and vehicle replacement.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Layers, AlertTriangle, ShieldCheck, Truck, PackageCheck, PackageX, MapPin, Navigation, RefreshCw, Crosshair, Wrench } from 'lucide-react'
import { toast } from 'sonner'
import Card, { CardHeader } from '../common/Card'
import Badge from '../common/Badge'
import Button from '../common/Button'
import Modal from '../common/Modal'
import Select from '../common/Select'
import Textarea from '../common/Textarea'
import Input from '../common/Input'
import Checkbox from '../common/Checkbox'
import { useStoredValue } from '../../hooks/useLocalStorage'
import { usePermission } from '../../hooks/usePermission'
import { STORAGE_KEYS as K } from '../../utils/constants'
import { fefoPlan, overrideCandidates, saveDispatchOverride } from '../../services/erp/stockControlService'
import { loadingState, recordManualLocation, replaceVehicle, replacementCandidates, REPLACEMENT_REASONS, routeModel, setOrderLoaded, simulateArrival, STOP_STATUS } from '../../services/erp/fleetService'
import { formatDate, formatDateTime, formatTime } from '../../utils/formatters'
import { CapacityBars, ErpMap, ScanButton, SimulatedNote, STOP_TONE } from './ErpUi'
import storage from '../../services/storageService'

const NONE = []

/* ---------------------------------------------------------------- FEFO */
export function FefoPanel({ dispatch }) {
  const orders = useStoredValue(K.ORDERS, NONE)
  useStoredValue(K.BATCHES, NONE)
  const canOverride = usePermission('fefo.override')
  const [edit, setEdit] = useState(null)
  const [reason, setReason] = useState('')
  const [ack, setAck] = useState(false)
  const os = useMemo(() => orders.filter((o) => dispatch.orderIds.includes(o.id)), [orders, dispatch.orderIds])
  const confirmed = dispatch.stockDeducted
  const plan = useMemo(() => (confirmed ? null : fefoPlan(os, dispatch.hubId, { overrides: dispatch.fefoOverride?.overrides || null })), [os, dispatch, confirmed])
  const lines = confirmed ? (dispatch.lotPlan || []) : plan.lines.filter((l) => l.tracked)
  const startEdit = () => setEdit(Object.fromEntries(plan.lines.filter((l) => l.tracked).map((l) => [l.key, Object.fromEntries(l.lots.map((x) => [x.batchId, String(x.quantity)]))])))
  const save = () => {
    const overrides = Object.fromEntries(Object.entries(edit).map(([k, m]) => [k, Object.entries(m).filter(([, q]) => Number(q) > 0).map(([batchId, q]) => ({ batchId, quantity: Number(q) }))]).filter(([, v]) => v.length))
    const r = saveDispatchOverride(dispatch.id, overrides, { reason, confirmed: ack })
    if (!r.ok) return toast.error(r.error)
    toast.success('FEFO override saved (audited)')
    setEdit(null); setReason(''); setAck(false)
  }
  const clear = () => { const r = saveDispatchOverride(dispatch.id, null); if (!r.ok) toast.error(r.error); else toast.success('Back to the automatic FEFO plan') }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">{confirmed ? 'Batches taken when the dispatch was confirmed (first-expiry-first-out).' : 'Preview of the batches the confirmation will take: earliest expiry first, then oldest receipt. Expired, QA-blocked and lots below the product’s minimum remaining shelf life are skipped.'}</p>
      {plan?.blocks.length > 0 && <div className="rounded-lg border border-danger/40 bg-danger/5 p-3 text-sm text-danger">{plan.blocks.map((b) => <p key={b} className="flex gap-1.5"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{b}</p>)}</div>}
      {dispatch.fefoOverride && <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning/10 p-2 text-sm"><span>Override by {dispatch.fefoOverride.byName} ({formatDateTime(dispatch.fefoOverride.at)}): {dispatch.fefoOverride.reason}</span>{!confirmed && canOverride && <Button size="xs" variant="secondary" onClick={clear}>Clear override</Button>}</div>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-muted"><th className="py-2 pr-2">Order</th><th className="py-2 pr-2">Product</th><th className="py-2 pr-2 text-right">Qty</th><th className="py-2">Batches (qty · expiry)</th></tr></thead>
          <tbody>{lines.map((l) => (
            <tr key={l.key} className="border-b border-line/60 align-top">
              <td className="py-2 pr-2 whitespace-nowrap">{l.orderNumber}</td><td className="py-2 pr-2">{l.productName}</td><td className="py-2 pr-2 text-right tabular">{l.quantity} {l.unit}</td>
              <td className="py-2">{l.lots.length ? l.lots.map((x) => <span key={x.batchId} className="mr-1 mb-1 inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-xs"><b>{x.batchNumber}</b> {x.quantity}{x.expiryDate && <span className="text-muted">· {formatDate(x.expiryDate)}</span>}{x.eligibility === 'NEAR_EXPIRY' && <Badge tone="warning">near expiry</Badge>}</span>) : <span className="text-xs text-danger">{l.message || 'No usable batch'}</span>}</td>
            </tr>
          ))}</tbody>
        </table>
        {!lines.length && <p className="py-4 text-center text-sm text-muted">No batch-tracked lines on this dispatch.</p>}
      </div>
      {!confirmed && canOverride && plan.lines.some((l) => l.tracked) && <Button size="sm" variant="secondary" icon={Layers} onClick={startEdit}>Override batches…</Button>}
      <Modal open={Boolean(edit)} onClose={() => setEdit(null)} size="lg" title="Override FEFO batches" icon={Layers}
        footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={save}>Save override</Button></>}>
        <p className="mb-3 text-sm text-muted">Choose the batches and quantities per line. Expired and QA-blocked lots are shown but cannot be selected. A reason and confirmation are required; the override is written to the audit log.</p>
        {edit && plan.lines.filter((l) => l.tracked).map((l) => (
          <div key={l.key} className="mb-3 rounded-lg border border-line p-2">
            <p className="text-sm font-medium">{l.orderNumber} · {l.productName} — needs {l.quantity} {l.unit}</p>
            <table className="mt-1 w-full text-xs"><tbody>{overrideCandidates(l.productId, dispatch.hubId).map((b) => (
              <tr key={b.id} className={b.eligibility.overridable ? '' : 'opacity-50'}>
                <td className="py-1 pr-2 font-medium">{b.batchNumber}</td><td className="pr-2">{b.quantity} on hand</td><td className="pr-2">{formatDate(b.expiryDate)}</td><td className="pr-2"><Badge tone={b.eligibility.usable ? 'success' : b.eligibility.overridable ? 'warning' : 'danger'}>{b.eligibility.label}</Badge></td>
                <td className="text-right"><input aria-label={`Quantity from ${b.batchNumber}`} type="number" min="0" step="any" disabled={!b.eligibility.overridable} className="h-7 w-20 rounded border border-line bg-surface px-1" value={edit[l.key]?.[b.id] || ''} onChange={(e) => setEdit({ ...edit, [l.key]: { ...edit[l.key], [b.id]: e.target.value } })} /></td>
              </tr>
            ))}</tbody></table>
          </div>
        ))}
        <Textarea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} required rows={2} />
        <Checkbox className="mt-2" label="I confirm this deviation from FEFO and accept responsibility." checked={ack} onChange={(e) => setAck(e.target.checked)} />
      </Modal>
    </div>
  )
}

/* ---------------------------------------------------------------- Loading */
export function LoadingPanel({ dispatch }) {
  useStoredValue(K.DISPATCHES, NONE)
  useStoredValue(K.ORDERS, NONE)
  const canLoad = usePermission('dispatch.loading')
  const s = loadingState(dispatch)
  const open = !['IN_TRANSIT', 'COMPLETED', 'CANCELLED', 'PARTIALLY_DELIVERED'].includes(dispatch.status)
  const toggle = (oid, on) => { const r = setOrderLoaded(dispatch.id, oid, on); if (!r.ok) toast.error(r.error); else toast.success(on ? 'Loaded' : 'Unloaded') }
  if (!s.vehicle) return <p className="text-sm text-muted">Assign a vehicle to see capacity and load the orders.</p>
  // Scan an order number, or a product barcode → loads the first not-yet-loaded order on this dispatch carrying it
  const onScan = (code) => {
    const c = String(code).trim().toLowerCase()
    const orders = s.stops.map((x) => x.orderId)
    const all = (storage.getItem(K.ORDERS, []) || []).filter((o) => orders.includes(o.id) && !s.loadedIds.includes(o.id))
    const prod = (storage.getItem(K.PRODUCTS, []) || []).find((p) => [p.barcode, p.sku, p.code].some((x) => String(x || '').toLowerCase() === c))
    const hit = all.find((o) => String(o.orderNumber).toLowerCase() === c) || (prod && all.find((o) => o.items.some((i) => i.productId === prod.id)))
    if (!hit) return toast.error(`Nothing left to load for ${code}`)
    toggle(hit.id, true)
  }
  return (
    <div className="space-y-4">
      {canLoad && open && <div className="flex justify-end"><ScanButton label="Scan to load" onDetected={onScan} /></div>}
      <div className="grid gap-4 md:grid-cols-2">
        <div><p className="mb-2 text-label">Loaded so far ({s.loadedIds.length}/{dispatch.orderIds.length} orders)</p><CapacityBars usage={s.loaded.usage} /></div>
        <div><p className="mb-2 text-label">Full plan on {s.vehicle.vehicleNumber}</p><CapacityBars usage={s.planned.usage} />{s.planned.blocks.map((b) => <p key={b} className="mt-1 text-xs text-danger">{b}</p>)}</div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-muted"><th className="py-2 pr-2">Stop</th><th className="py-2 pr-2">Customer · address</th><th className="py-2 pr-2 text-right">Distance</th><th className="py-2 pr-2">Slot</th><th className="py-2 pr-2 text-right">Qty</th><th className="py-2 pr-2 text-right">Weight</th><th className="py-2 text-right">Load</th></tr></thead>
          <tbody>{s.stops.map((x) => { const loaded = s.loadedIds.includes(x.orderId); return (
            <tr key={x.orderId} className="border-b border-line/60">
              <td className="py-2 pr-2"><span className="grid h-7 w-7 place-items-center rounded-full bg-navy text-xs font-semibold text-white">{x.stop}</span></td>
              <td className="py-2 pr-2"><Link to={`/orders/${x.orderId}`} className="font-medium text-brand hover:underline">{x.orderNumber}</Link> · {x.customerName}<span className="block text-xs text-muted">{x.address}, {x.city}{x.location ? ` · ${x.location.lat.toFixed(4)}, ${x.location.lng.toFixed(4)} (${x.location.source})` : ''}</span></td>
              <td className="py-2 pr-2 text-right tabular text-xs">{x.legKm} km<span className="block text-muted">Σ {x.cumulativeKm}</span></td>
              <td className="py-2 pr-2 text-xs">{x.slot || '—'}</td>
              <td className="py-2 pr-2 text-right tabular">{x.quantity}</td><td className="py-2 pr-2 text-right tabular">{x.weight} kg</td>
              <td className="py-2 text-right">{canLoad && open ? <Button size="xs" variant={loaded ? 'secondary' : 'primary'} icon={loaded ? PackageX : PackageCheck} onClick={() => toggle(x.orderId, !loaded)}>{loaded ? 'Unload' : 'Load'}</Button> : <Badge tone={loaded ? 'success' : 'neutral'}>{loaded ? 'Loaded' : 'Not loaded'}</Badge>}</td>
            </tr>) })}</tbody>
        </table>
      </div>
      {s.events.length > 0 && <details className="text-xs text-muted"><summary className="cursor-pointer">Loading log ({s.events.length})</summary><ul className="mt-1 space-y-0.5">{s.events.map((e) => <li key={e.id}>{formatDateTime(e.at)} · {e.byName} · {e.action} {e.orderNumber || ''}</li>)}</ul></details>}
    </div>
  )
}

/* ---------------------------------------------------------------- Live route */
export function LiveRoute({ dispatchId, height = 360, driverMode = false }) {
  useStoredValue(K.DISPATCHES, NONE)
  useStoredValue(K.DELIVERIES, NONE)
  const [tick, setTick] = useState(0)
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 15000); return () => clearInterval(t) }, [])
  const m = useMemo(() => routeModel(dispatchId), [dispatchId, tick]) // eslint-disable-line react-hooks/exhaustive-deps
  const canManage = usePermission('dispatch.manage')
  const [loc, setLoc] = useState(null)
  if (!m) return null
  const markers = [
    ...(m.origin ? [{ id: 'hub', lat: m.origin.lat, lng: m.origin.lng, label: 'H', tone: '#0f172a', title: m.hub?.name }] : []),
    ...m.stops.filter((s) => s.location).map((s) => ({ id: s.orderId, lat: s.location.lat, lng: s.location.lng, label: String(s.stop), tone: STOP_TONE[s.status], title: `${s.stop}. ${s.customerName} — ${s.statusLabel}` })),
  ]
  const useBrowserLocation = () => {
    if (!navigator.geolocation) return toast.error('This browser has no location access — type the coordinates.')
    navigator.geolocation.getCurrentPosition((p) => { const r = recordManualLocation(dispatchId, { lat: p.coords.latitude, lng: p.coords.longitude, note: 'Device location' }); if (r.ok) toast.success('Location updated'); else toast.error(r.error) }, () => toast.error('Location permission denied — type the coordinates instead.'))
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        {m.positionSource === 'simulated' && <SimulatedNote>Simulated GPS</SimulatedNote>}
        {m.positionSource === 'manual' && <SimulatedNote>Manual location</SimulatedNote>}
        <span>Status <b className="text-ink">{m.status}</b></span><span>· {m.completed}/{m.stops.length} stops done</span><span>· {m.totalKm} km planned</span>
        {m.etaFinishAt && <span>· route ETA {formatTime(m.etaFinishAt)}</span>}{m.lastUpdate && <span>· updated {formatTime(m.lastUpdate)}</span>}
        <Button size="xs" variant="ghost" icon={RefreshCw} onClick={() => setTick((x) => x + 1)}>Refresh</Button>
      </div>
      <ErpMap markers={markers} line={m.polyline.map((p) => [p.lat, p.lng])} position={m.position} height={height} fitKey={`${dispatchId}-${markers.length}`} />
      <ol className="divide-y divide-line rounded-xl border border-line text-sm">
        {m.stops.map((s) => (
          <li key={s.orderId} className="flex items-center gap-3 px-3 py-2">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-semibold text-white" style={{ background: STOP_TONE[s.status] }}>{s.stop}</span>
            <div className="min-w-0 flex-1"><p className="truncate font-medium">{s.customerName}</p><p className="truncate text-xs text-muted">{s.address} · {s.legKm} km{s.etaAt && !['DELIVERED', 'FAILED', 'SKIPPED'].includes(s.status) ? ` · ETA ${formatTime(s.etaAt)}` : ''}</p></div>
            <Badge tone={{ DELIVERED: 'success', FAILED: 'danger', SKIPPED: 'neutral', ARRIVED: 'info', IN_PROGRESS: 'info', PENDING: 'neutral' }[s.status]}>{STOP_STATUS[s.status]}</Badge>
            {(driverMode || canManage) && s.deliveryId && s.status === 'PENDING' && ['CONFIRMED', 'IN_TRANSIT'].includes(m.status) && <Button size="xs" variant="ghost" icon={MapPin} title="Simulated arrival (demo)" onClick={() => { const r = simulateArrival(dispatchId, s.deliveryId); if (!r.ok) toast.error(r.error) }}>Arrive (sim.)</Button>}
            {s.location && <Button size="xs" variant="ghost" icon={Navigation} href={`https://www.google.com/maps/dir/?api=1&destination=${s.location.lat},${s.location.lng}`} target="_blank" rel="noreferrer" aria-label="Navigate" />}
          </li>
        ))}
      </ol>
      {(driverMode || canManage) && ['CONFIRMED', 'IN_TRANSIT'].includes(m.status) && (
        <div className="flex flex-wrap items-end gap-2">
          <Button size="sm" variant="secondary" icon={Crosshair} onClick={useBrowserLocation}>Use my location</Button>
          {loc ? <>
            <Input label="Latitude" value={loc.lat} onChange={(e) => setLoc({ ...loc, lat: e.target.value })} className="w-32" />
            <Input label="Longitude" value={loc.lng} onChange={(e) => setLoc({ ...loc, lng: e.target.value })} className="w-32" />
            <Button size="sm" onClick={() => { const r = recordManualLocation(dispatchId, { lat: loc.lat, lng: loc.lng, note: 'Manual entry' }); if (!r.ok) return toast.error(r.error); toast.success('Location updated'); setLoc(null) }}>Save</Button>
          </> : <Button size="sm" variant="ghost" onClick={() => setLoc({ lat: m.position?.lat ?? m.origin?.lat ?? '', lng: m.position?.lng ?? m.origin?.lng ?? '' })}>Enter coordinates</Button>}
        </div>
      )}
      <p className="text-[11px] text-muted">No live GPS device is connected in this prototype: the vehicle position is simulated along the route between stops, or the last manual / device location the driver recorded. Stop status follows the real delivery records.</p>
    </div>
  )
}

/* ---------------------------------------------------------------- Vehicle replacement */
export function ReplaceVehicleDialog({ dispatch, open, onClose }) {
  const [vehicleId, setVehicleId] = useState('')
  const [reason, setReason] = useState('Breakdown')
  const [remarks, setRemarks] = useState('')
  const [oldStatus, setOldStatus] = useState('Maintenance')
  const cands = useMemo(() => (open ? replacementCandidates(dispatch) : []), [open, dispatch])
  const pick = cands.find((c) => c.vehicle.id === vehicleId)
  const save = () => { const r = replaceVehicle(dispatch.id, vehicleId, { reason, remarks, oldVehicleStatus: oldStatus }); if (!r.ok) return toast.error(r.error); toast.success(`${r.entry.fromVehicleNumber} → ${r.entry.toVehicleNumber}`); onClose() }
  return (
    <Modal open={open} onClose={onClose} size="lg" title={`Replace vehicle on ${dispatch.dispatchNumber}`} icon={Wrench}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save} disabled={!pick?.eligible}>Replace vehicle</Button></>}>
      <p className="mb-3 text-sm text-muted">The same dispatch keeps its orders, deliveries and stock; only the vehicle changes. Capacity and availability are checked, the driver and dispatcher are notified and the replacement is kept in the history.</p>
      <ul className="max-h-64 space-y-1 overflow-y-auto scroll-thin">
        {cands.map((c) => (
          <li key={c.vehicle.id}><label className={`flex items-center gap-3 rounded-lg border p-2 text-sm ${vehicleId === c.vehicle.id ? 'border-brand bg-brand/5' : 'border-line'} ${c.eligible ? 'cursor-pointer' : 'opacity-60'}`}>
            <input type="radio" name="veh" disabled={!c.eligible} checked={vehicleId === c.vehicle.id} onChange={() => setVehicleId(c.vehicle.id)} />
            <Truck size={16} className="text-muted" /><span className="font-medium">{c.vehicle.vehicleNumber}</span><span className="text-xs text-muted">{c.vehicle.type} · {c.vehicle.maxWeightKg} kg · {c.vehicle.status}</span>
            <span className="ml-auto text-xs">{c.eligible ? <Badge tone="success">Fits ({c.capacity.usage.find((u) => u.key === 'weight').pct}% weight)</Badge> : <span className="text-danger">{c.issues.join(' · ')}</span>}</span>
          </label></li>
        ))}
        {!cands.length && <li className="text-sm text-muted">No other vehicle at this hub.</li>}
      </ul>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Select label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} options={REPLACEMENT_REASONS.map((x) => ({ value: x, label: x }))} />
        <Select label="Original vehicle becomes" value={oldStatus} onChange={(e) => setOldStatus(e.target.value)} options={['Maintenance', 'Suspended', 'Inactive', 'Available'].map((x) => ({ value: x, label: x }))} hint="Applied for breakdown / accident / maintenance / temperature failure." />
        <Textarea label="Remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={2} className="sm:col-span-2" />
      </div>
      {pick && <div className="mt-3"><CapacityBars usage={pick.capacity.usage} /></div>}
    </Modal>
  )
}

export function ReplacementHistory({ dispatch }) {
  if (!(dispatch.vehicleReplacements || []).length) return null
  return (
    <Card className="mt-6"><CardHeader title="Vehicle replacements" icon={ShieldCheck} />
      <ul className="divide-y divide-line text-sm">{dispatch.vehicleReplacements.map((r) => <li key={r.id} className="py-2"><b>{r.fromVehicleNumber} → {r.toVehicleNumber}</b> · {r.reason}{r.remarks && ` — ${r.remarks}`}<span className="block text-xs text-muted">{formatDateTime(r.at)} · driver {r.driverName || '—'} · by {r.byName}</span></li>)}</ul>
    </Card>
  )
}
