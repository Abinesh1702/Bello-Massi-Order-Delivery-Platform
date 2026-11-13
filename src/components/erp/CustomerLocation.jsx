import { useState } from 'react'
import { MapPin, BadgeCheck, Search, Crosshair } from 'lucide-react'
import { toast } from 'sonner'
import Card, { CardHeader } from '../common/Card'
import Badge from '../common/Badge'
import Button from '../common/Button'
import Modal from '../common/Modal'
import Input from '../common/Input'
import { usePermission } from '../../hooks/usePermission'
import { customerLocation, searchPlaces } from '../../utils/geo'
import { setCustomerLocation } from '../../services/erp/salesAssignmentService'
import { ErpMap } from './ErpUi'

/** Map card for a customer (customer page, order details, delivery details) with pin editing and verification. */
export default function CustomerLocationCard({ customer, title = 'Location', height = 220, editable = true }) {
  const canEdit = usePermission('customers.location.manage') && editable
  const [open, setOpen] = useState(false)
  const [pin, setPin] = useState(null)
  const [q, setQ] = useState('')
  if (!customer) return null
  const loc = customerLocation(customer)
  const start = () => { setPin(loc ? { lat: loc.lat, lng: loc.lng } : null); setQ(''); setOpen(true) }
  const save = (verified) => { const r = setCustomerLocation(customer.id, { ...pin, verified, source: verified ? 'Verified on map' : 'Map pin' }); if (!r.ok) return toast.error(r.error); toast.success(verified ? 'Location verified' : 'Location saved'); setOpen(false) }
  const useDevice = () => navigator.geolocation ? navigator.geolocation.getCurrentPosition((p) => setPin({ lat: Math.round(p.coords.latitude * 1e6) / 1e6, lng: Math.round(p.coords.longitude * 1e6) / 1e6 }), () => toast.error('Location permission denied.')) : toast.error('No location access in this browser.')
  const address = [customer.addressLine1, customer.addressLine2, customer.city, customer.pincode].filter(Boolean).join(', ')
  return (
    <Card>
      <CardHeader title={title} icon={MapPin} action={canEdit && <Button size="xs" variant="secondary" onClick={start}>{loc ? 'Edit pin' : 'Set location'}</Button>} />
      {loc ? <ErpMap markers={[{ id: customer.id, lat: loc.lat, lng: loc.lng, label: '★', tone: customer.locationVerified ? '#16a34a' : '#232B5F', title: customer.name }]} height={height} fitKey={`${customer.id}-${loc.lat}-${loc.lng}`} />
        : <p className="rounded-lg bg-surface-2 p-3 text-sm text-muted">No coordinates — showing the address only.</p>}
      <p className="mt-2 text-sm">{address}</p>
      {loc && <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted tabular">{loc.lat.toFixed(5)}, {loc.lng.toFixed(5)}<Badge tone={customer.locationVerified ? 'success' : 'warning'}>{customer.locationVerified ? <><BadgeCheck size={11} /> Verified</> : loc.source}</Badge><a className="text-brand hover:underline" href={`https://www.google.com/maps/search/?api=1&query=${loc.lat},${loc.lng}`} target="_blank" rel="noreferrer">Open in maps</a></p>}
      <Modal open={open} onClose={() => setOpen(false)} size="lg" title={`Location of ${customer.name}`} icon={MapPin}
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button variant="secondary" disabled={!pin} onClick={() => save(false)}>Save pin</Button><Button icon={BadgeCheck} disabled={!pin} onClick={() => save(true)}>Save & verify</Button></>}>
        <div className="mb-2 flex flex-wrap items-end gap-2">
          <Input label="Search place (built-in city list)" value={q} onChange={(e) => setQ(e.target.value)} icon={Search} className="flex-1" />
          <Button variant="secondary" icon={Crosshair} onClick={useDevice}>My location</Button>
        </div>
        {q && <div className="mb-2 flex flex-wrap gap-1">{searchPlaces(q).map((p) => <Button key={p.name} size="xs" variant="secondary" onClick={() => setPin({ lat: p.lat, lng: p.lng })}>{p.name}</Button>)}{!searchPlaces(q).length && <span className="text-xs text-muted">No match — click on the map or type coordinates.</span>}</div>}
        <ErpMap markers={pin ? [{ id: 'pin', lat: pin.lat, lng: pin.lng, label: '★', tone: '#F5A623', draggable: true }] : []} onPick={(lat, lng) => setPin({ lat, lng })} height={340} fitKey={pin ? 'pin' : 'none'} />
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Input label="Latitude" type="number" step="any" value={pin?.lat ?? ''} onChange={(e) => setPin({ ...(pin || { lng: 0 }), lat: Number(e.target.value) })} />
          <Input label="Longitude" type="number" step="any" value={pin?.lng ?? ''} onChange={(e) => setPin({ ...(pin || { lat: 0 }), lng: Number(e.target.value) })} />
        </div>
        <p className="mt-1 text-xs text-muted">Click the map or drag the pin. Address search uses a built-in list of cities (no external geocoding service in the prototype).</p>
      </Modal>
    </Card>
  )
}
