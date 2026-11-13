/**
 * Fleet & delivery execution (data v11):
 *  • Driver availability — Available · Assigned · On Delivery · On Leave · Offline · Suspended · Inactive, offline /
 *    leave periods with dates, times, reason and remarks, an availability calendar, admin override with a reason
 *    (per driver, date and period) and an availability history. driverService.driverAssignmentIssues enforces it.
 *  • Vehicle capacity — max weight (kg), volume (m³), stops and quantity; loading is incremental per order and can
 *    never exceed any limit.
 *  • Vehicle replacement — the SAME dispatch record gets the replacement vehicle (never duplicated); deliveries and
 *    orders follow, the old vehicle gets the reason as status, everything is written to the replacement history.
 *  • Route & simulated GPS — hub (H) + numbered stops, distance, ETA, stop statuses. Positions are SIMULATED
 *    (clearly labelled) unless the driver records a manual location update.
 */
import dayjs from 'dayjs'
import storage from '../storageService'
import { STORAGE_KEYS as K } from '../../utils/constants'
import { can } from '../../config/permissions'
import { getCurrentUser } from '../authService'
import { logAudit } from '../auditService'
import { pushNotification } from '../notificationService'
import { uid } from '../../utils/helpers'
import { weightOf, volumeOf } from '../../utils/units'
import { customerLocation, driveMinutes, hubCoords, interpolate, roadKm, SERVICE_MINUTES } from '../../utils/geo'

const read = (k, f = []) => storage.getItem(k, f) ?? f
const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10
const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000
const ACTIVE = ['ASSIGNED', 'CONFIRMED', 'IN_TRANSIT']

/* ------------------------------------------------------------------ */
/* Driver availability                                                  */
/* ------------------------------------------------------------------ */
export const DRIVER_STATUSES = ['Available', 'Assigned', 'On Delivery', 'On Leave', 'Offline', 'Suspended', 'Inactive']
export const DRIVER_STATUS_TONE = { Available: 'success', Assigned: 'info', 'On Delivery': 'info', 'On Leave': 'warning', Offline: 'neutral', Suspended: 'danger', Inactive: 'neutral' }
export const OFFLINE_REASONS = ['Sick leave', 'Annual leave', 'Personal', 'Training', 'Vehicle unavailable', 'Off duty', 'Other']

const periodAt = (driver, at) => (driver.offlinePeriods || []).find((p) => dayjs(p.from).isBefore(at) && dayjs(p.to).isAfter(at))
const periodOnDay = (driver, day) => (driver.offlinePeriods || []).find((p) => dayjs(p.from).isBefore(day.endOf('day')) && dayjs(p.to).isAfter(day.startOf('day')))

/** Status of a driver at a moment (default now). */
export const driverStatusAt = (driver, at = dayjs(), dispatches = read(K.DISPATCHES)) => {
  if (!driver) return 'Inactive'
  if (driver.status !== 'Active') return 'Inactive'
  if (driver.suspended) return 'Suspended'
  const p = periodAt(driver, dayjs(at))
  const mine = dispatches.filter((d) => d.driverId === driver.id && ACTIVE.includes(d.status))
  if (mine.some((d) => d.status === 'IN_TRANSIT')) return 'On Delivery'
  if (p) return p.type === 'Leave' ? 'On Leave' : 'Offline'
  if (mine.some((d) => !d.dispatchDate || d.dispatchDate === dayjs(at).format('YYYY-MM-DD'))) return 'Assigned'
  return mine.length ? 'Assigned' : 'Available'
}

/** Day-by-day calendar: [{ date, status, note }] for `days` days from `from`. */
export const driverCalendar = (driver, { from = dayjs(), days = 14, dispatches = read(K.DISPATCHES) } = {}) => Array.from({ length: days }, (_, i) => {
  const day = dayjs(from).startOf('day').add(i, 'day')
  const date = day.format('YYYY-MM-DD')
  if (driver.status !== 'Active') return { date, status: 'Inactive', note: '' }
  if (driver.suspended) return { date, status: 'Suspended', note: driver.suspendedReason || '' }
  const p = periodOnDay(driver, day)
  const override = p && (driver.availabilityOverrides || []).find((o) => o.date === date && o.periodId === p.id)
  const d = dispatches.find((x) => x.driverId === driver.id && x.dispatchDate === date && !['CANCELLED', 'DRAFT'].includes(x.status))
  if (p && !override) return { date, status: p.type === 'Leave' ? 'On Leave' : 'Offline', note: p.reason, periodId: p.id }
  if (d) return { date, status: d.status === 'IN_TRANSIT' ? 'On Delivery' : ['COMPLETED', 'CLOSED'].includes(d.status) ? 'Available' : 'Assigned', note: d.dispatchNumber + (override ? ` · override: ${override.reason}` : ''), dispatchId: d.id }
  return { date, status: 'Available', note: override ? `Override: ${override.reason}` : '' }
})

const writeDriver = (id, fn, note) => {
  const drivers = read(K.DRIVERS)
  const d = drivers.find((x) => x.id === id)
  if (!d) return { ok: false, error: 'This driver no longer exists.' }
  const next = fn(d)
  if (next?.error) return { ok: false, error: next.error }
  const user = getCurrentUser()
  const record = { ...next, updatedAt: new Date().toISOString(), availabilityHistory: [{ id: uid('dah'), at: new Date().toISOString(), by: user?.id, byName: user?.name || 'System', note }, ...(d.availabilityHistory || [])].slice(0, 200) }
  const res = storage.setItem(K.DRIVERS, drivers.map((x) => (x.id === id ? record : x)))
  if (!res.ok) return { ok: false, error: res.error }
  logAudit({ module: 'fleet', action: 'Driver availability', entity: 'Driver', recordId: id, recordLabel: d.name, description: note })
  return { ok: true, record }
}

/** Add an offline / leave period. Refused when it overlaps another period or an assigned dispatch (reassign first). */
export const addOfflinePeriod = (driverId, { from, to, reason, remarks = '', type = 'Offline' }) => {
  if (!can(getCurrentUser(), 'drivers.availability.manage')) return { ok: false, error: 'You do not have permission to manage driver availability.' }
  const f = dayjs(from)
  const t = dayjs(to)
  if (!f.isValid() || !t.isValid()) return { ok: false, error: 'Enter the start and end date and time.' }
  if (!t.isAfter(f)) return { ok: false, error: 'The end must be after the start.' }
  if (t.isBefore(dayjs())) return { ok: false, error: 'The period has already ended.' }
  if (!reason) return { ok: false, error: 'Choose the reason.' }
  if (reason === 'Other' && String(remarks).trim().length < 5) return { ok: false, error: 'Describe the reason in the remarks.' }
  return writeDriver(driverId, (d) => {
    const clash = (d.offlinePeriods || []).find((p) => dayjs(p.from).isBefore(t) && dayjs(p.to).isAfter(f))
    if (clash) return { error: `Overlaps an existing period (${dayjs(clash.from).format('DD MMM HH:mm')} – ${dayjs(clash.to).format('DD MMM HH:mm')}).` }
    const busy = read(K.DISPATCHES).find((x) => x.driverId === d.id && ACTIVE.includes(x.status) && x.dispatchDate && !dayjs(x.dispatchDate).endOf('day').isBefore(f) && !dayjs(x.dispatchDate).startOf('day').isAfter(t))
    if (busy) return { error: `${d.name} is assigned to ${busy.dispatchNumber} on ${dayjs(busy.dispatchDate).format('DD MMM')}. Reassign the dispatch first.` }
    const period = { id: uid('off'), type: type === 'Leave' ? 'Leave' : 'Offline', from: f.toISOString(), to: t.toISOString(), reason, remarks: String(remarks).trim(), createdAt: new Date().toISOString(), createdByName: getCurrentUser()?.name || '' }
    return { ...d, offlinePeriods: [...(d.offlinePeriods || []), period].sort((a, b) => a.from.localeCompare(b.from)), availability: dayjs().isAfter(f) && dayjs().isBefore(t) ? 'Offline' : d.availability }
  }, `${type === 'Leave' ? 'Leave' : 'Offline'} ${dayjs(from).format('DD MMM HH:mm')} – ${dayjs(to).format('DD MMM HH:mm')}: ${reason}${remarks ? ` — ${remarks}` : ''}`)
}

export const removeOfflinePeriod = (driverId, periodId) => {
  if (!can(getCurrentUser(), 'drivers.availability.manage')) return { ok: false, error: 'You do not have permission to manage driver availability.' }
  return writeDriver(driverId, (d) => {
    const p = (d.offlinePeriods || []).find((x) => x.id === periodId)
    if (!p) return { error: 'This period no longer exists.' }
    return { ...d, offlinePeriods: d.offlinePeriods.filter((x) => x.id !== periodId), availability: d.availability === 'Offline' ? 'Available' : d.availability }
  }, 'Offline period removed')
}

export const setDriverSuspended = (driverId, suspended, reason = '') => {
  if (!can(getCurrentUser(), 'drivers.availability.manage')) return { ok: false, error: 'You do not have permission to manage driver availability.' }
  if (suspended && String(reason).trim().length < 5) return { ok: false, error: 'Enter the reason for the suspension.' }
  return writeDriver(driverId, (d) => {
    if (suspended && read(K.DISPATCHES).some((x) => x.driverId === d.id && ACTIVE.includes(x.status))) return { error: `${d.name} has an active dispatch. Reassign it before suspending.` }
    return { ...d, suspended, suspendedReason: suspended ? String(reason).trim() : '', availability: suspended ? 'Offline' : 'Available' }
  }, suspended ? `Suspended: ${reason}` : 'Suspension lifted')
}

/** Admin override: allow assignment on one date despite an offline period (reason required, audited). */
export const overrideAvailability = (driverId, date, reason) => {
  const user = getCurrentUser()
  if (!can(user, 'drivers.availability.manage') || !['ADMIN', 'SUPER_ADMIN'].includes(user?.role)) return { ok: false, error: 'Only an administrator can override driver availability.' }
  if (String(reason || '').trim().length < 10) return { ok: false, error: 'Enter the reason for the override (at least 10 characters).' }
  return writeDriver(driverId, (d) => {
    const p = periodOnDay(d, dayjs(date))
    if (!p) return { error: `${d.name} is not offline on ${dayjs(date).format('DD MMM')} — no override needed.` }
    if (d.suspended || d.status !== 'Active') return { error: 'Suspended or inactive drivers cannot be overridden.' }
    return { ...d, availabilityOverrides: [...(d.availabilityOverrides || []).filter((o) => !(o.date === date && o.periodId === p.id)), { id: uid('dov'), date, periodId: p.id, reason: String(reason).trim(), by: user.id, byName: user.name, at: new Date().toISOString() }] }
  }, `Admin override for ${dayjs(date).format('DD MMM')}: ${reason}`)
}

/* ------------------------------------------------------------------ */
/* Vehicle capacity & loading                                           */
/* ------------------------------------------------------------------ */
export const VEHICLE_STATUSES = ['Available', 'Assigned', 'In Transit', 'Maintenance', 'Inactive', 'Suspended']

/** Load of a set of orders: weight (kg), volume (m³), stops, quantity (base units). */
export const loadOf = (orders, products = read(K.PRODUCTS)) => {
  const P = Object.fromEntries(products.map((p) => [p.id, p]))
  let weight = 0
  let volume = 0
  let quantity = 0
  orders.forEach((o) => (o.items || []).forEach((it) => {
    weight += weightOf(P[it.productId], it.orderedQuantity)
    volume += volumeOf(P[it.productId], it.orderedQuantity)
    quantity += Number(it.orderedQuantity) || 0
  }))
  const stops = new Set(orders.map((o) => `${o.customerId}|${o.deliveryAddress || ''}`)).size
  return { weight: r1(weight), volume: Math.round(volume * 100) / 100, quantity: r3(quantity), stops, orders: orders.length }
}

export const vehicleLimits = (v) => ({ weight: Number(v?.maxWeightKg) || 0, volume: Number(v?.maxVolumeM3) || 0, stops: Number(v?.maxStops) || 0, quantity: Number(v?.capacity) || 0 })

/** Capacity check of a vehicle against orders. { load, limits, usage[{key,label,used,max,pct,over}], blocks } */
export const capacityCheck = (vehicle, orders, products) => {
  const load = loadOf(orders, products)
  const limits = vehicleLimits(vehicle)
  const usage = [
    ['weight', 'Weight', 'kg'], ['volume', 'Volume', 'm³'], ['stops', 'Stops', ''], ['quantity', 'Quantity', vehicle?.capacityUnit || 'units'],
  ].map(([key, label, unit]) => ({ key, label, unit, used: load[key], max: limits[key], remaining: limits[key] ? Math.round((limits[key] - load[key]) * 100) / 100 : null, pct: limits[key] ? Math.round((load[key] / limits[key]) * 100) : null, over: limits[key] > 0 && load[key] > limits[key] }))
  const blocks = vehicle ? usage.filter((u) => u.over).map((u) => `${vehicle.vehicleNumber} would be overloaded: ${u.label.toLowerCase()} ${u.used}${u.unit ? ` ${u.unit}` : ''} exceeds the limit of ${u.max}${u.unit ? ` ${u.unit}` : ''}.`) : []
  return { load, limits, usage, blocks }
}

/** Route groups of a dispatch for loading: stop no., customer, address, coordinates, distance, slot, quantity, weight. */
export const routeStops = (dispatch, { orders = read(K.ORDERS), customers = read(K.CUSTOMERS), hubs = read(K.HUBS), products = read(K.PRODUCTS) } = {}) => {
  const O = Object.fromEntries(orders.map((o) => [o.id, o]))
  const C = Object.fromEntries(customers.map((c) => [c.id, c]))
  const hub = hubs.find((h) => h.id === dispatch.hubId)
  const h = hubCoords(hub)
  let prev = h ? { lat: h[0], lng: h[1] } : null
  let cum = 0
  let minutes = 0
  return (dispatch.orderIds || []).map((oid, i) => {
    const o = O[oid]
    const c = C[o?.customerId]
    const loc = customerLocation(c)
    const leg = prev && loc ? roadKm(prev, loc) : 0
    cum += leg
    minutes += driveMinutes(leg) + (i ? SERVICE_MINUTES : 0)
    if (loc) prev = loc
    const l = o ? loadOf([o], products) : { weight: 0, volume: 0, quantity: 0 }
    return { stop: i + 1, orderId: oid, orderNumber: o?.orderNumber, customerId: o?.customerId, customerName: o?.customerName || c?.name, address: o?.deliveryAddress || '', city: o?.deliveryCity || c?.city || '', location: loc, legKm: r1(leg), cumulativeKm: r1(cum), etaMinutes: minutes, slot: o?.deliverySlotLabel || o?.deliverySlot || '', quantity: l.quantity, weight: l.weight, volume: l.volume }
  })
}

/** Incremental loading state of a dispatch. */
export const loadingState = (dispatch) => {
  const vehicle = read(K.VEHICLES).find((v) => v.id === dispatch?.vehicleId) || null
  const orders = read(K.ORDERS)
  const loadedIds = dispatch?.loading?.loadedOrderIds || []
  const loaded = loadedIds.map((id) => orders.find((o) => o.id === id)).filter(Boolean)
  const planned = (dispatch?.orderIds || []).map((id) => orders.find((o) => o.id === id)).filter(Boolean)
  return { vehicle, loaded: capacityCheck(vehicle, loaded), planned: capacityCheck(vehicle, planned), loadedIds, stops: dispatch ? routeStops(dispatch) : [], events: dispatch?.loading?.events || [] }
}

const writeDispatch = (id, fn) => {
  const list = read(K.DISPATCHES)
  const d = list.find((x) => x.id === id)
  if (!d) return { ok: false, error: 'This dispatch no longer exists.' }
  const next = fn(d)
  if (next?.error) return { ok: false, error: next.error }
  const res = storage.setItem(K.DISPATCHES, list.map((x) => (x.id === id ? next : x)))
  return res.ok ? { ok: true, record: next } : { ok: false, error: res.error }
}

/** Load (or unload) one order onto the vehicle. Loading is refused when any capacity limit would be exceeded. */
export const setOrderLoaded = (dispatchId, orderId, loaded = true) => {
  const user = getCurrentUser()
  if (!can(user, 'dispatch.loading') && !can(user, 'dispatch.manage')) return { ok: false, error: 'You do not have permission to load vehicles.' }
  return writeDispatch(dispatchId, (d) => {
    if (!d.orderIds.includes(orderId)) return { error: 'This order is not on the dispatch.' }
    if (!d.vehicleId) return { error: 'Assign a vehicle before loading.' }
    if (['IN_TRANSIT', 'COMPLETED', 'CANCELLED'].includes(d.status)) return { error: `${d.dispatchNumber} has left the hub — loading is closed.` }
    const ids = new Set(d.loading?.loadedOrderIds || [])
    if (loaded) {
      if (ids.has(orderId)) return { error: 'Already loaded.' }
      ids.add(orderId)
      const vehicle = read(K.VEHICLES).find((v) => v.id === d.vehicleId)
      const orders = read(K.ORDERS).filter((o) => ids.has(o.id))
      const cap = capacityCheck(vehicle, orders)
      if (cap.blocks.length) return { error: cap.blocks[0] }
    } else if (!ids.delete(orderId)) return { error: 'This order is not loaded.' }
    const o = read(K.ORDERS).find((x) => x.id === orderId)
    const event = { id: uid('lde'), at: new Date().toISOString(), byName: user.name, action: loaded ? 'Loaded' : 'Unloaded', orderNumber: o?.orderNumber }
    return { ...d, loading: { loadedOrderIds: d.orderIds.filter((x) => ids.has(x)), events: [event, ...(d.loading?.events || [])].slice(0, 100), completedAt: ids.size === d.orderIds.length ? new Date().toISOString() : null }, updatedAt: new Date().toISOString() }
  })
}

/* ------------------------------------------------------------------ */
/* Vehicle replacement                                                   */
/* ------------------------------------------------------------------ */
export const REPLACEMENT_REASONS = ['Breakdown', 'Accident', 'Maintenance due', 'Capacity change', 'Temperature failure', 'Other']

/** Vehicles that could replace the dispatch's vehicle: same hub, available, big enough for the load. */
export const replacementCandidates = (dispatch) => {
  const orders = read(K.ORDERS).filter((o) => dispatch.orderIds.includes(o.id))
  return read(K.VEHICLES).filter((v) => v.id !== dispatch.vehicleId && v.hubId === dispatch.hubId).map((v) => {
    const busy = read(K.DISPATCHES).find((d) => d.vehicleId === v.id && d.id !== dispatch.id && ACTIVE.includes(d.status))
    const cap = capacityCheck(v, orders)
    const issues = [
      ...(['Maintenance', 'Inactive', 'Suspended'].includes(v.status) ? [`${v.status}`] : []),
      ...(busy ? [`On ${busy.dispatchNumber}`] : []),
      ...cap.blocks.map(() => 'Too small for the load'),
    ]
    return { vehicle: v, capacity: cap, issues: [...new Set(issues)], eligible: !issues.length }
  }).sort((a, b) => Number(b.eligible) - Number(a.eligible))
}

export const replaceVehicle = (dispatchId, newVehicleId, { reason, remarks = '', oldVehicleStatus = 'Maintenance' } = {}) => {
  const user = getCurrentUser()
  if (!can(user, 'vehicles.replace')) return { ok: false, error: 'You do not have permission to replace vehicles.' }
  if (!REPLACEMENT_REASONS.includes(reason)) return { ok: false, error: 'Choose the reason for the replacement.' }
  if (reason === 'Other' && String(remarks).trim().length < 5) return { ok: false, error: 'Describe the reason in the remarks.' }
  const dispatches = read(K.DISPATCHES)
  const d = dispatches.find((x) => x.id === dispatchId)
  if (!d) return { ok: false, error: 'This dispatch no longer exists.' }
  if (!['PLANNED', 'ASSIGNED', 'CONFIRMED', 'IN_TRANSIT'].includes(d.status)) return { ok: false, error: `${d.dispatchNumber} is ${String(d.status).toLowerCase()} — its vehicle cannot be replaced.` }
  const cand = replacementCandidates(d).find((c) => c.vehicle.id === newVehicleId)
  if (!cand) return { ok: false, error: 'Choose a vehicle from the same hub.' }
  if (!cand.eligible) return { ok: false, error: `${cand.vehicle.vehicleNumber} cannot take this dispatch: ${cand.issues.join(', ')}.` }
  const vehicles = read(K.VEHICLES)
  const old = vehicles.find((v) => v.id === d.vehicleId)
  const now = new Date().toISOString()
  const entry = { id: uid('vrp'), at: now, dispatchId: d.id, dispatchNumber: d.dispatchNumber, fromVehicleId: old?.id || null, fromVehicleNumber: old?.vehicleNumber || d.vehicleNumber, toVehicleId: cand.vehicle.id, toVehicleNumber: cand.vehicle.vehicleNumber, reason, remarks: String(remarks).trim(), driverId: d.driverId, driverName: d.driverName, by: user.id, byName: user.name }
  const record = { ...d, vehicleId: cand.vehicle.id, vehicleNumber: cand.vehicle.vehicleNumber, vehicleReplacements: [...(d.vehicleReplacements || []), entry], loading: d.loading ? { ...d.loading, events: [{ id: uid('lde'), at: now, byName: user.name, action: `Vehicle replaced → ${cand.vehicle.vehicleNumber}` }, ...(d.loading.events || [])] } : d.loading, updatedAt: now }
  const inTransit = d.status === 'IN_TRANSIT'
  const nextVehicles = vehicles.map((v) => {
    if (v.id === cand.vehicle.id) return { ...v, status: inTransit ? 'In Transit' : 'Assigned', replacementHistory: [...(v.replacementHistory || []), entry], updatedAt: now }
    if (old && v.id === old.id) return { ...v, status: ['Breakdown', 'Accident', 'Maintenance due', 'Temperature failure'].includes(reason) ? oldVehicleStatus : 'Available', replacementHistory: [...(v.replacementHistory || []), entry], updatedAt: now }
    return v
  })
  const writes = [
    [K.DISPATCHES, dispatches.map((x) => (x.id === d.id ? record : x))],
    [K.VEHICLES, nextVehicles],
    [K.DELIVERIES, read(K.DELIVERIES).map((x) => (x.dispatchId === d.id ? { ...x, vehicleId: cand.vehicle.id, updatedAt: now } : x))],
    [K.ORDERS, read(K.ORDERS).map((o) => (d.orderIds.includes(o.id) && o.vehicleId ? { ...o, vehicleId: cand.vehicle.id, updatedAt: now } : o))],
  ]
  const res = storage.transaction(writes)
  if (!res.ok) return { ok: false, error: res.error }
  logAudit({ module: 'dispatch', action: 'Vehicle replaced', entity: 'Dispatch', recordId: d.id, recordLabel: d.dispatchNumber, description: `${entry.fromVehicleNumber} → ${entry.toVehicleNumber}: ${reason}${remarks ? ` — ${remarks}` : ''}` })
  const driverUser = read(K.DRIVERS).find((x) => x.id === d.driverId)?.userId
  pushNotification({ title: `Vehicle changed: ${d.dispatchNumber}`, message: `${entry.fromVehicleNumber} → ${entry.toVehicleNumber} (${reason}).`, type: 'warning', userIds: driverUser ? [driverUser] : null, roles: driverUser ? null : ['DISPATCHER'], link: driverUser ? '/driver/route' : `/dispatch/${d.id}`, category: 'dispatch' })
  pushNotification({ title: `Vehicle replaced on ${d.dispatchNumber}`, message: `${user.name}: ${entry.fromVehicleNumber} → ${entry.toVehicleNumber} (${reason}).`, type: 'warning', roles: ['ADMIN', 'DISPATCHER', 'FLEET_MANAGER'], link: `/dispatch/${d.id}`, category: 'dispatch' })
  return { ok: true, record, entry }
}

/* ------------------------------------------------------------------ */
/* Route & simulated GPS                                                 */
/* ------------------------------------------------------------------ */
export const STOP_STATUS = { PENDING: 'Pending', ARRIVED: 'Arrived', IN_PROGRESS: 'In Progress', DELIVERED: 'Delivered', FAILED: 'Failed', SKIPPED: 'Skipped' }
const deliveryStopStatus = (dl, arrivals = {}) => {
  if (!dl) return 'PENDING'
  if (['DELIVERED', 'PARTIALLY_DELIVERED'].includes(dl.status)) return 'DELIVERED'
  if (['FAILED', 'RETURNED'].includes(dl.status)) return 'FAILED'
  if (dl.status === 'CANCELLED') return 'SKIPPED'
  if (dl.skippedAt) return 'SKIPPED'
  if (dl.status === 'OUT_FOR_DELIVERY' && (dl.arrivedAt || arrivals[dl.id])) return 'IN_PROGRESS'
  if (dl.arrivedAt || arrivals[dl.id]) return 'ARRIVED'
  return 'PENDING'
}

/**
 * Route model of a dispatch for the live map: hub, numbered stops with status / distance / ETA, current position and
 * the polyline. Position: last manual update of the driver if any, otherwise SIMULATED along the route between the
 * last completed stop and the next one (never presented as live GPS).
 */
export const routeModel = (dispatchId, { now = dayjs() } = {}) => {
  const d = read(K.DISPATCHES).find((x) => x.id === dispatchId)
  if (!d) return null
  const hub = read(K.HUBS).find((h) => h.id === d.hubId)
  const hc = hubCoords(hub)
  const deliveries = read(K.DELIVERIES).filter((x) => x.dispatchId === d.id && x.status !== 'CANCELLED')
  const gps = d.gps || {}
  const stops = routeStops(d).map((s) => {
    const dl = deliveries.find((x) => x.orderId === s.orderId)
    const code = deliveryStopStatus(dl, gps.arrivals || {})
    return { ...s, deliveryId: dl?.id || null, status: code, statusLabel: STOP_STATUS[code], completedAt: dl?.completedAt || dl?.failedAt || null }
  })
  const origin = hc ? { lat: hc[0], lng: hc[1] } : null
  const done = stops.filter((s) => ['DELIVERED', 'FAILED', 'SKIPPED'].includes(s.status))
  const current = stops.find((s) => ['ARRIVED', 'IN_PROGRESS'].includes(s.status)) || stops.find((s) => s.status === 'PENDING') || null
  const started = ['IN_TRANSIT', 'COMPLETED'].includes(d.status) || deliveries.some((x) => x.startedAt)
  let position = null
  let source = 'none'
  if (gps.manual && dayjs(gps.manual.at).isAfter(now.subtract(6, 'hour'))) { position = { lat: gps.manual.lat, lng: gps.manual.lng }; source = 'manual' }
  else if (started && origin) {
    const last = [...done].reverse().find((s) => s.location)
    const from = last?.location || origin
    if (current?.location && ['ARRIVED', 'IN_PROGRESS'].includes(current.status)) position = current.location
    else if (current?.location) {
      const since = dayjs(last?.completedAt || d.startedAt || d.confirmedAt || now.subtract(10, 'minute'))
      const legMin = Math.max(5, driveMinutes(roadKm(from, current.location)))
      position = interpolate(from, current.location, Math.min(0.95, Math.max(0.05, now.diff(since, 'minute') / legMin)))
    } else position = from
    source = 'simulated'
  }
  const remaining = stops.filter((s) => !['DELIVERED', 'FAILED', 'SKIPPED'].includes(s.status))
  let etaMin = 0
  let p = position || origin
  remaining.forEach((s, i) => { if (p && s.location) { etaMin += driveMinutes(roadKm(p, s.location)) + (i ? SERVICE_MINUTES : 0); p = s.location } s.etaAt = started ? now.add(etaMin, 'minute').toISOString() : null })
  const total = stops.length ? stops[stops.length - 1].cumulativeKm : 0
  return {
    dispatch: d, hub, origin, stops, position, positionSource: source, lastUpdate: source === 'manual' ? gps.manual.at : source === 'simulated' ? now.toISOString() : null,
    polyline: [origin, ...stops.map((s) => s.location)].filter(Boolean), totalKm: total, completed: done.length, pending: remaining.length,
    currentStop: current, etaFinishAt: started && remaining.length ? now.add(etaMin, 'minute').toISOString() : null,
    status: d.status,
  }
}

/** Driver / dispatcher manual location update (labelled "manual" — not live GPS). */
export const recordManualLocation = (dispatchId, { lat, lng, note = '' }) => {
  const user = getCurrentUser()
  const d = read(K.DISPATCHES).find((x) => x.id === dispatchId)
  const isDriver = d && read(K.DRIVERS).find((x) => x.id === d.driverId)?.userId === user?.id
  if (!isDriver && !can(user, 'dispatch.manage')) return { ok: false, error: 'Only the assigned driver or a dispatcher can update the location.' }
  if (!(Math.abs(Number(lat)) <= 90 && Math.abs(Number(lng)) <= 180)) return { ok: false, error: 'Enter a valid latitude and longitude.' }
  return writeDispatch(dispatchId, (x) => ({ ...x, gps: { ...(x.gps || {}), manual: { lat: Number(lat), lng: Number(lng), note, at: new Date().toISOString(), byName: user.name }, trail: [...(x.gps?.trail || []), { lat: Number(lat), lng: Number(lng), at: new Date().toISOString() }].slice(-200) } }))
}

/** Simulated arrival at a stop (demo control, labelled). */
export const simulateArrival = (dispatchId, deliveryId) => {
  const user = getCurrentUser()
  const d = read(K.DISPATCHES).find((x) => x.id === dispatchId)
  const isDriver = d && read(K.DRIVERS).find((x) => x.id === d.driverId)?.userId === user?.id
  if (!isDriver && !can(user, 'dispatch.manage')) return { ok: false, error: 'Only the assigned driver or a dispatcher can record arrivals.' }
  const stop = routeModel(dispatchId)?.stops.find((s) => s.deliveryId === deliveryId)
  return writeDispatch(dispatchId, (x) => ({ ...x, gps: { ...(x.gps || {}), arrivals: { ...(x.gps?.arrivals || {}), [deliveryId]: new Date().toISOString() }, manual: stop?.location ? { ...stop.location, note: `Simulated arrival at stop ${stop.stop}`, at: new Date().toISOString(), byName: user.name } : x.gps?.manual } }))
}
