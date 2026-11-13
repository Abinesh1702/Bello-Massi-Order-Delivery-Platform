/**
 * Shared UI pieces of the advanced ERP layer (data v11): map (Leaflet + OpenStreetMap tiles, markers and lines still
 * render if tiles cannot load), barcode SVG / print, camera barcode scanner with manual fallback, quantity + unit
 * input with base-unit preview, capacity bars and small status badges.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Camera, CameraOff, Printer, ScanBarcode, X } from 'lucide-react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import Badge from '../common/Badge'
import Button from '../common/Button'
import Modal from '../common/Modal'
import Input from '../common/Input'
import { cn } from '../../utils/helpers'
import { barcodePattern } from '../../utils/barcode'
import { productUnits, toBase } from '../../utils/units'

/* ---------------------------------------------------------------- Map */
const pinIcon = (label, tone = '#232B5F', ring = '#ffffff') => L.divIcon({
  className: '',
  html: `<div style="width:28px;height:28px;border-radius:9999px;background:${tone};color:#fff;display:grid;place-items:center;font:600 12px/1 Inter,system-ui,sans-serif;border:2px solid ${ring};box-shadow:0 1px 4px rgba(0,0,0,.35)">${label}</div>`,
  iconSize: [28, 28], iconAnchor: [14, 14],
})
const truckIcon = () => L.divIcon({ className: '', html: '<div style="width:18px;height:18px;border-radius:9999px;background:#F5A623;border:3px solid #fff;box-shadow:0 0 0 4px rgba(245,166,35,.35)"></div>', iconSize: [18, 18], iconAnchor: [9, 9] })
export const STOP_TONE = { DELIVERED: '#16a34a', FAILED: '#dc2626', SKIPPED: '#6b7280', ARRIVED: '#2563eb', IN_PROGRESS: '#2563eb', PENDING: '#232B5F' }

/**
 * markers: [{ id, lat, lng, label, tone, title }] · line: [[lat, lng]…] · position: { lat, lng } (current vehicle)
 * onPick(lat, lng): click / drag to choose a location (pickable mode).
 */
export function ErpMap({ markers = [], line = [], position = null, onPick, height = 320, className, fitKey }) {
  const el = useRef(null)
  const map = useRef(null)
  const layer = useRef(null)
  const [tilesFailed, setTilesFailed] = useState(false)
  useEffect(() => {
    if (!el.current || map.current) return
    map.current = L.map(el.current, { zoomControl: true, attributionControl: true }).setView([12.9, 79.5], 6)
    const tiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' })
    let errors = 0
    tiles.on('tileerror', () => { errors += 1; if (errors > 3) setTilesFailed(true) })
    tiles.addTo(map.current)
    layer.current = L.layerGroup().addTo(map.current)
    return () => { map.current?.remove(); map.current = null }
  }, [])
  useEffect(() => {
    if (!map.current) return undefined
    const h = (e) => onPick?.(Math.round(e.latlng.lat * 1e6) / 1e6, Math.round(e.latlng.lng * 1e6) / 1e6)
    if (onPick) map.current.on('click', h)
    return () => { map.current?.off('click', h) }
  }, [onPick])
  const key = fitKey ?? JSON.stringify([markers.map((m) => [m.lat, m.lng]), line.length])
  useEffect(() => {
    if (!map.current || !layer.current) return
    layer.current.clearLayers()
    if (line.length > 1) L.polyline(line, { color: '#232B5F', weight: 3, opacity: 0.75, dashArray: '6 6' }).addTo(layer.current)
    markers.filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lng)).forEach((m) => {
      const mk = L.marker([m.lat, m.lng], { icon: pinIcon(m.label ?? '•', m.tone), draggable: Boolean(onPick && m.draggable), title: m.title || '' }).addTo(layer.current)
      if (m.title) mk.bindTooltip(m.title)
      if (onPick && m.draggable) mk.on('dragend', (e) => { const p = e.target.getLatLng(); onPick(Math.round(p.lat * 1e6) / 1e6, Math.round(p.lng * 1e6) / 1e6) })
    })
    if (position) L.marker([position.lat, position.lng], { icon: truckIcon(), zIndexOffset: 1000 }).bindTooltip('Vehicle position').addTo(layer.current)
    const pts = [...markers.filter((m) => Number.isFinite(m.lat)).map((m) => [m.lat, m.lng]), ...(position ? [[position.lat, position.lng]] : [])]
    if (pts.length === 1) map.current.setView(pts[0], 13)
    else if (pts.length > 1) map.current.fitBounds(pts, { padding: [28, 28], maxZoom: 14 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, position?.lat, position?.lng])
  return (
    <div className={cn('relative overflow-hidden rounded-xl border border-line', className)}>
      <div ref={el} style={{ height }} className="z-0 bg-surface-2" role="application" aria-label="Map" />
      {tilesFailed && <p className="absolute bottom-2 left-2 z-[400] rounded bg-surface/90 px-2 py-1 text-[11px] text-muted">Map tiles unavailable offline — markers and route still shown.</p>}
    </div>
  )
}

/* ---------------------------------------------------------------- Barcode */
export function BarcodeSvg({ code, type, height = 56, showText = true, className }) {
  const { pattern, symbology } = useMemo(() => barcodePattern(code, type), [code, type])
  if (!code || !pattern) return <span className="text-xs text-muted">No barcode</span>
  const w = pattern.length + 20
  return (
    <svg viewBox={`0 0 ${w} ${height + (showText ? 14 : 0)}`} className={cn('h-auto w-full max-w-[260px] bg-white', className)} role="img" aria-label={`${symbology} barcode ${code}`}>
      {pattern.split('').map((b, i) => (b === '1' ? <rect key={i} x={10 + i} y={2} width={1} height={height - 4} fill="#000" /> : null))}
      {showText && <text x={w / 2} y={height + 10} textAnchor="middle" fontSize="10" fontFamily="monospace" fill="#000">{code}</text>}
    </svg>
  )
}

export const printBarcodeLabels = (items) => {
  // items: [{ code, type, name, sku, copies }]
  const w = window.open('', '_blank', 'width=720,height=640')
  if (!w) return false
  const svg = (code, type) => {
    const { pattern } = barcodePattern(code, type)
    if (!pattern) return ''
    const width = pattern.length + 20
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 70" width="220">${pattern.split('').map((b, i) => (b === '1' ? `<rect x="${10 + i}" y="2" width="1" height="52"/>` : '')).join('')}<text x="${width / 2}" y="66" text-anchor="middle" font-size="10" font-family="monospace">${code}</text></svg>`
  }
  const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const labels = items.flatMap((it) => Array.from({ length: Math.max(1, Number(it.copies) || 1) }, () => `<div class="l"><b>${esc(it.name)}</b><span>${esc(it.sku)}</span>${svg(it.code, it.type)}</div>`)).join('')
  w.document.write(`<!doctype html><title>Barcode labels</title><style>body{font-family:system-ui;margin:12px}.g{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.l{border:1px dashed #999;padding:8px;text-align:center;display:flex;flex-direction:column;gap:2px;font-size:11px}</style><div class="g">${labels}</div><script>setTimeout(()=>print(),300)</scr`+`ipt>`)
  w.document.close()
  return true
}

/**
 * Camera barcode scanner (BarcodeDetector API where the browser supports it) with manual entry as the fallback.
 * onDetected(code) is called once per scan.
 */
export function BarcodeScanner({ open, onClose, onDetected, title = 'Scan barcode' }) {
  const video = useRef(null)
  const [mode, setMode] = useState('manual')
  const [manual, setManual] = useState('')
  const [error, setError] = useState('')
  const supported = typeof window !== 'undefined' && 'BarcodeDetector' in window && Boolean(navigator.mediaDevices?.getUserMedia)
  useEffect(() => {
    if (!open || mode !== 'camera') return undefined
    let stream = null
    let stop = false
    let detector
    ;(async () => {
      try {
        detector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'code_128', 'qr_code'] })
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        if (stop) return
        video.current.srcObject = stream
        await video.current.play()
        const tick = async () => {
          if (stop) return
          try {
            const codes = await detector.detect(video.current)
            if (codes[0]?.rawValue) { onDetected(codes[0].rawValue); onClose(); return }
          } catch { /* keep scanning */ }
          requestAnimationFrame(tick)
        }
        tick()
      } catch (e) {
        setError(e?.name === 'NotAllowedError' ? 'Camera permission was denied — type the barcode instead.' : 'The camera could not be started — type the barcode instead.')
        setMode('manual')
      }
    })()
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()) }
  }, [open, mode, onDetected, onClose])
  useEffect(() => { if (open) { setManual(''); setError(''); setMode('manual') } }, [open])
  const submit = (e) => { e.preventDefault(); if (manual.trim()) { onDetected(manual.trim()); onClose() } }
  return (
    <Modal open={open} onClose={onClose} title={title} icon={ScanBarcode} size="sm">
      <div className="space-y-3">
        <div className="flex gap-2">
          <Button size="sm" variant={mode === 'manual' ? 'primary' : 'secondary'} onClick={() => setMode('manual')}>Type / handheld scanner</Button>
          <Button size="sm" variant={mode === 'camera' ? 'primary' : 'secondary'} icon={supported ? Camera : CameraOff} disabled={!supported} onClick={() => setMode('camera')}>Camera</Button>
        </div>
        {!supported && <p className="text-xs text-muted">Camera scanning needs a browser with the BarcodeDetector API (Chrome / Edge on Android, ChromeOS, macOS). Handheld USB / Bluetooth scanners work in the field below.</p>}
        {error && <p className="text-xs text-danger">{error}</p>}
        {mode === 'camera' ? (
          <video ref={video} className="aspect-video w-full rounded-lg bg-black" muted playsInline aria-label="Camera preview" />
        ) : (
          <form onSubmit={submit} className="flex items-end gap-2">
            <Input label="Barcode, SKU or code" value={manual} onChange={(e) => setManual(e.target.value)} autoFocus className="flex-1" placeholder="Scan or type, then Enter" />
            <Button type="submit">Find</Button>
          </form>
        )}
      </div>
    </Modal>
  )
}

/** Inline scan button that opens the scanner. */
export function ScanButton({ onDetected, label = 'Scan', size = 'sm', variant = 'secondary' }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size={size} variant={variant} icon={ScanBarcode} onClick={() => setOpen(true)}>{label}</Button>
      <BarcodeScanner open={open} onClose={() => setOpen(false)} onDetected={onDetected} />
    </>
  )
}

/* ---------------------------------------------------------------- Units */
/** Quantity + unit picker with the base-unit equivalent. value: { quantity, unit } */
export function QtyUnitInput({ product, value, onChange, label = 'Quantity', error, className, compact }) {
  const units = productUnits(product)
  const base = product?.baseUnit || product?.unit
  const q = Number(value?.quantity)
  const inBase = product && value?.unit && Number.isFinite(q) ? toBase(product, q, value.unit) : null
  return (
    <div className={cn('min-w-0', className)}>
      {!compact && <span className="text-label">{label}</span>}
      <div className="mt-1 flex">
        <input type="number" min="0" step="any" inputMode="decimal" aria-label={label} value={value?.quantity ?? ''} onChange={(e) => onChange({ ...value, quantity: e.target.value })}
          className={cn('h-9 w-full min-w-0 rounded-l-lg border border-line bg-surface px-2.5 text-sm tabular focus:border-brand focus:outline-none', error && 'border-danger')} />
        <select aria-label="Unit" value={value?.unit || base || ''} onChange={(e) => onChange({ ...value, unit: e.target.value })} className="h-9 rounded-r-lg border border-l-0 border-line bg-surface-2 px-2 text-sm">
          {units.map((u) => <option key={u.code} value={u.code}>{u.code}</option>)}
        </select>
      </div>
      {inBase !== null && value?.unit && value.unit !== base && <p className="mt-0.5 text-[11px] text-muted tabular">= {inBase} {base}</p>}
      {error && <p className="mt-0.5 text-[11px] text-danger">{error}</p>}
    </div>
  )
}

/* ---------------------------------------------------------------- Capacity */
export function CapacityBars({ usage }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {usage.map((u) => (
        <div key={u.key}>
          <div className="flex items-baseline justify-between text-xs">
            <span className="font-medium text-ink-2">{u.label}</span>
            <span className={cn('tabular', u.over ? 'text-danger font-semibold' : 'text-muted')}>{u.used}{u.unit ? ` ${u.unit}` : ''} / {u.max || '—'} {u.pct !== null && `(${u.pct}%)`}</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-label={u.label} aria-valuenow={u.pct || 0} aria-valuemin={0} aria-valuemax={100}>
            <div className={cn('h-full rounded-full', u.over ? 'bg-danger' : u.pct > 85 ? 'bg-warning' : 'bg-success')} style={{ width: `${Math.min(100, u.pct || 0)}%` }} />
          </div>
          {u.remaining !== null && <p className="mt-0.5 text-[11px] text-muted tabular">{u.over ? 'Over by' : 'Remaining'} {Math.abs(u.remaining)}{u.unit ? ` ${u.unit}` : ''}</p>}
        </div>
      ))}
    </div>
  )
}

export function ToneBadge({ meta, value }) {
  const m = meta?.[value] || { label: value, tone: 'neutral' }
  return <Badge tone={m.tone} dot>{m.label}</Badge>
}

export function SimulatedNote({ children = 'Simulated', className }) {
  return <span className={cn('inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-warning', className)}>{children}</span>
}

export function CloseX({ onClick, label = 'Remove' }) {
  return <button type="button" onClick={onClick} aria-label={label} className="rounded p-1 text-muted hover:bg-surface-3 hover:text-ink"><X size={14} /></button>
}

export function PrintBarcodeButton({ product, copies = 1 }) {
  return <Button size="sm" variant="secondary" icon={Printer} disabled={!product?.barcode} onClick={() => printBarcodeLabels([{ code: product.barcode, type: product.barcodeType, name: product.name, sku: product.sku, copies }])}>Print label</Button>
}
