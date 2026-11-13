/**
 * Recurring orders (data v11, bellomassi_recurring_orders).
 *
 * A schedule holds: customer, hub, salesman, delivery address, frequency (Daily · Weekly · selected weekdays ·
 * Fortnightly · Monthly · every N days), start / end date and one or more delivery SLOTS, each with its own time and
 * product lines (quantity + unit). Workflow: setup → schedule → order generation → approval (Sales Manager) →
 * stock reservation → consolidation → dispatch → delivery — generated orders are ordinary orders (orderMode
 * "Recurring") and follow the normal order workflow from submission on.
 *
 * Generation is idempotent: each occurrence has a key `${scheduleId}|${date}|${slotId}`; an order carrying that key is
 * never created twice. Edits change future occurrences only — orders already generated are left as they are
 * (completed orders are never altered). Pause / resume / cancel keep the schedule's history.
 */
import dayjs from 'dayjs'
import storage from '../storageService'
import { STORAGE_KEYS as K } from '../../utils/constants'
import { can } from '../../config/permissions'
import { getCurrentUser } from '../authService'
import { logAudit } from '../auditService'
import { pushNotification } from '../notificationService'
import { uid } from '../../utils/helpers'
import { submitOrder, deliveryFromCustomer } from '../orderService'
import { effectiveSalesman } from './salesAssignmentService'
import { productUnits, toBase, validUnitQuantity } from '../../utils/units'

const read = (k, f = []) => storage.getItem(k, f) ?? f
export const FREQUENCIES = [
  { value: 'DAILY', label: 'Daily' }, { value: 'WEEKLY', label: 'Weekly (selected weekdays)' }, { value: 'FORTNIGHTLY', label: 'Fortnightly' },
  { value: 'MONTHLY', label: 'Monthly (day of month)' }, { value: 'CUSTOM', label: 'Every N days' },
]
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export const RECURRING_STATUS = { ACTIVE: { label: 'Active', tone: 'success' }, PAUSED: { label: 'Paused', tone: 'warning' }, CANCELLED: { label: 'Cancelled', tone: 'neutral' }, ENDED: { label: 'Ended', tone: 'neutral' } }

export const getRecurringOrders = () => read(K.RECURRING_ORDERS)
export const getRecurringById = (id, list = getRecurringOrders()) => list.find((r) => r.id === id) || null

/** Recurring schedules a user may see: own customers for salesmen (primary or secondary), all for office roles. */
export const visibleRecurring = (user = getCurrentUser(), list = getRecurringOrders()) => {
  if (!can(user, 'recurring.view')) return []
  if (['SALESMAN', 'HORECA_SALES_EXEC', 'VAN_SALES_EXEC'].includes(user.role)) {
    const mine = new Set(read(K.CUSTOMERS).filter((c) => c.salesRepId === user.id || c.secondarySalesRepId === user.id).map((c) => c.id))
    return list.filter((r) => mine.has(r.customerId) || r.salesmanId === user.id || r.createdBy === user.id)
  }
  return list
}

/** Does the schedule deliver on this date? */
export const occursOn = (r, date) => {
  const d = dayjs(date).startOf('day')
  if (r.startDate && d.isBefore(dayjs(r.startDate), 'day')) return false
  if (r.endDate && d.isAfter(dayjs(r.endDate), 'day')) return false
  const start = dayjs(r.startDate || d)
  switch (r.frequency) {
    case 'DAILY': return true
    case 'WEEKLY': return (r.weekdays || []).includes(d.day())
    case 'FORTNIGHTLY': return (r.weekdays || []).includes(d.day()) && Math.floor(d.diff(start.startOf('week'), 'day') / 7) % 2 === 0
    case 'MONTHLY': return d.date() === Math.min(Number(r.monthDay) || 1, d.daysInMonth())
    case 'CUSTOM': return d.diff(start.startOf('day'), 'day') % Math.max(1, Number(r.intervalDays) || 1) === 0
    default: return false
  }
}

export const occurrenceKey = (r, date, slot) => `${r.id}|${dayjs(date).format('YYYY-MM-DD')}|${slot.id}`

/** Upcoming occurrences [{ date, slot, key, orderId, orderNumber, status }] in a date range. */
export const occurrences = (r, from = dayjs(), days = 30, orders = read(K.ORDERS)) => {
  const out = []
  for (let i = 0; i < days; i += 1) {
    const date = dayjs(from).startOf('day').add(i, 'day')
    if (!occursOn(r, date)) continue
    ;(r.slots || []).forEach((slot) => {
      const key = occurrenceKey(r, date, slot)
      const o = orders.find((x) => x.recurringKey === key)
      out.push({ date: date.format('YYYY-MM-DD'), slot, key, orderId: o?.id || null, orderNumber: o?.orderNumber || null, status: o?.orderStatus || null, skipped: (r.skipped || []).includes(key) })
    })
  }
  return out
}

export const generatedOrders = (r, orders = read(K.ORDERS)) => orders.filter((o) => o.recurringOrderId === r.id).sort((a, b) => String(b.requestedDeliveryDate).localeCompare(String(a.requestedDeliveryDate)))

export const validateRecurring = (v) => {
  const e = {}
  const customer = read(K.CUSTOMERS).find((c) => c.id === v.customerId)
  const P = Object.fromEntries(read(K.PRODUCTS).map((p) => [p.id, p]))
  if (!customer) e.customerId = 'Select a customer.'
  else if (customer.status !== 'Active') e.customerId = `${customer.name} is ${String(customer.status).toLowerCase()} and cannot receive recurring orders.`
  if (!read(K.HUBS).some((h) => h.id === v.hubId && h.status === 'Active')) e.hubId = 'Select an active fulfilment hub.'
  if (!FREQUENCIES.some((f) => f.value === v.frequency)) e.frequency = 'Choose the frequency.'
  if (['WEEKLY', 'FORTNIGHTLY'].includes(v.frequency) && !(v.weekdays || []).length) e.weekdays = 'Pick at least one weekday.'
  if (v.frequency === 'MONTHLY' && !(Number(v.monthDay) >= 1 && Number(v.monthDay) <= 31)) e.monthDay = 'Day of month 1–31.'
  if (v.frequency === 'CUSTOM' && !(Number(v.intervalDays) >= 1 && Number(v.intervalDays) <= 90)) e.intervalDays = 'Every 1–90 days.'
  if (!v.startDate || !dayjs(v.startDate).isValid()) e.startDate = 'Enter the start date.'
  if (v.endDate && dayjs(v.endDate).isBefore(dayjs(v.startDate), 'day')) e.endDate = 'The end date must be after the start date.'
  if (!String(v.deliveryAddress || '').trim()) e.deliveryAddress = 'Enter the delivery address.'
  const slots = v.slots || []
  if (!slots.length) e.slots = 'Add at least one delivery slot.'
  const times = new Set()
  slots.forEach((s, i) => {
    if (!/^\d{2}:\d{2}$/.test(String(s.time || ''))) e[`slots.${i}.time`] = 'Enter the delivery time (HH:MM).'
    else if (times.has(s.time)) e[`slots.${i}.time`] = 'Two slots have the same time.'
    times.add(s.time)
    if (!(s.lines || []).length) e[`slots.${i}.lines`] = 'Add at least one product to this slot.'
    const seen = new Set()
    ;(s.lines || []).forEach((l, j) => {
      const p = P[l.productId]
      if (!p) { e[`slots.${i}.lines.${j}`] = 'Select a product.'; return }
      if (p.status !== 'Active') e[`slots.${i}.lines.${j}`] = `${p.name} is not active.`
      if (seen.has(p.id)) e[`slots.${i}.lines.${j}`] = `${p.name} appears twice in this slot.`
      seen.add(p.id)
      if (!productUnits(p).some((u) => u.code === (l.unit || p.unit))) e[`slots.${i}.lines.${j}`] = `${l.unit} is not a unit of ${p.name}.`
      else if (!validUnitQuantity(l.unit || p.unit, l.quantity)) e[`slots.${i}.lines.${j}`] = `Enter a valid quantity in ${l.unit || p.unit}.`
    })
  })
  return e
}

const hist = (user, action, note = '') => ({ id: uid('rh'), at: new Date().toISOString(), by: user?.id || 'system', byName: user?.name || 'System', action, note })

const nextNumber = (list) => {
  const y = dayjs().format('YYYY')
  const n = list.map((r) => String(r.number || '')).filter((x) => x.startsWith(`REC-${y}-`)).map((x) => Number(x.split('-').pop()) || 0).reduce((a, b) => Math.max(a, b), 0) + 1
  return `REC-${y}-${String(n).padStart(4, '0')}`
}

export const saveRecurring = (values, id = null) => {
  const user = getCurrentUser()
  if (!can(user, 'recurring.manage')) return { ok: false, error: 'You do not have permission to manage recurring orders.' }
  const errors = validateRecurring(values)
  if (Object.keys(errors).length) return { ok: false, errors, error: Object.values(errors)[0] }
  const list = getRecurringOrders()
  const existing = id ? getRecurringById(id, list) : null
  if (id && !existing) return { ok: false, error: 'This schedule no longer exists.' }
  if (existing?.status === 'CANCELLED') return { ok: false, error: 'A cancelled schedule cannot be edited.' }
  const now = new Date().toISOString()
  const clean = {
    name: String(values.name || '').trim() || 'Recurring order', customerId: values.customerId, hubId: values.hubId, salesmanId: values.salesmanId || null,
    deliveryAddress: String(values.deliveryAddress).trim(), frequency: values.frequency, weekdays: (values.weekdays || []).map(Number).sort(), monthDay: Number(values.monthDay) || 1,
    intervalDays: Number(values.intervalDays) || 7, startDate: values.startDate, endDate: values.endDate || '', notes: String(values.notes || '').trim(),
    slots: values.slots.map((s) => ({ id: s.id || uid('sl'), slotId: s.slotId || '', time: s.time, lines: s.lines.map((l) => ({ id: l.id || uid('rl'), productId: l.productId, quantity: Number(l.quantity), unit: l.unit })) })),
  }
  const record = existing
    ? { ...existing, ...clean, updatedAt: now, history: [...(existing.history || []), hist(user, 'Schedule edited', 'Applies to occurrences not generated yet; generated orders are unchanged.')] }
    : { id: uid('rec'), number: nextNumber(list), ...clean, status: 'ACTIVE', skipped: [], history: [hist(user, 'Created')], createdAt: now, createdBy: user.id, createdByName: user.name, updatedAt: now }
  const res = storage.setItem(K.RECURRING_ORDERS, existing ? list.map((r) => (r.id === id ? record : r)) : [record, ...list])
  if (!res.ok) return { ok: false, error: res.error }
  logAudit({ module: 'orders', action: existing ? 'Recurring order edited' : 'Recurring order created', entity: 'Recurring order', recordId: record.id, recordLabel: record.number })
  return { ok: true, record }
}

const ACTIONS = {
  pause: { from: ['ACTIVE'], to: 'PAUSED', label: 'Paused' },
  resume: { from: ['PAUSED'], to: 'ACTIVE', label: 'Resumed' },
  cancel: { from: ['ACTIVE', 'PAUSED'], to: 'CANCELLED', label: 'Cancelled', reason: true },
}
export const setRecurringStatus = (id, action, reason = '') => {
  const user = getCurrentUser()
  if (!can(user, 'recurring.manage')) return { ok: false, error: 'You do not have permission to manage recurring orders.' }
  const a = ACTIONS[action]
  const list = getRecurringOrders()
  const r = getRecurringById(id, list)
  if (!r || !a) return { ok: false, error: 'This schedule no longer exists.' }
  if (!a.from.includes(r.status)) return { ok: false, error: `${r.number} is ${RECURRING_STATUS[r.status]?.label.toLowerCase()} — it cannot be ${a.label.toLowerCase()}.` }
  if (a.reason && String(reason).trim().length < 5) return { ok: false, error: 'Enter the reason (at least 5 characters).' }
  const record = { ...r, status: a.to, updatedAt: new Date().toISOString(), history: [...(r.history || []), hist(user, a.label, reason)] }
  const res = storage.setItem(K.RECURRING_ORDERS, list.map((x) => (x.id === id ? record : x)))
  if (!res.ok) return { ok: false, error: res.error }
  logAudit({ module: 'orders', action: `Recurring order ${a.label.toLowerCase()}`, entity: 'Recurring order', recordId: id, recordLabel: r.number, description: reason })
  return { ok: true, record }
}

/** Skip / unskip one occurrence (e.g. customer holiday). */
export const toggleSkip = (id, key) => {
  const user = getCurrentUser()
  if (!can(user, 'recurring.manage')) return { ok: false, error: 'You do not have permission to manage recurring orders.' }
  const list = getRecurringOrders()
  const r = getRecurringById(id, list)
  if (!r) return { ok: false, error: 'This schedule no longer exists.' }
  if (read(K.ORDERS).some((o) => o.recurringKey === key)) return { ok: false, error: 'An order was already generated for this occurrence — cancel that order instead.' }
  const skipped = new Set(r.skipped || [])
  const on = !skipped.has(key)
  if (on) skipped.add(key)
  else skipped.delete(key)
  const record = { ...r, skipped: [...skipped], history: [...(r.history || []), hist(user, on ? 'Occurrence skipped' : 'Occurrence restored', key.split('|')[1])] }
  storage.setItem(K.RECURRING_ORDERS, list.map((x) => (x.id === id ? record : x)))
  return { ok: true, record }
}

/**
 * Generate the orders due within the horizon (today … today + horizonDays) for every ACTIVE schedule the user may
 * manage. Each occurrence → one submitted order (approval follows). Never generates the same occurrence twice.
 * Returns { created: [...], skipped: n, errors: [...] }.
 */
export const generateDueOrders = ({ ids = null, horizonDays = null, now = dayjs() } = {}) => {
  const user = getCurrentUser()
  if (!can(user, 'recurring.manage') || !can(user, 'orders.create')) return { ok: false, error: 'You do not have permission to generate recurring orders.', created: [], errors: [] }
  const settings = read(K.ERP_SETTINGS, {}) || {}
  const horizon = horizonDays ?? settings.recurring?.horizonDays ?? 2
  const customers = Object.fromEntries(read(K.CUSTOMERS).map((c) => [c.id, c]))
  const P = Object.fromEntries(read(K.PRODUCTS).map((p) => [p.id, p]))
  const created = []
  const errors = []
  let list = getRecurringOrders()
  visibleRecurring(user, list).filter((r) => r.status === 'ACTIVE' && (!ids || ids.includes(r.id))).forEach((r) => {
    if (r.endDate && dayjs(r.endDate).isBefore(now, 'day')) return
    occurrences(r, now, horizon + 1).forEach((occ) => {
      if (occ.orderId || occ.skipped) return
      if (read(K.ORDERS).some((o) => o.recurringKey === occ.key)) return // idempotency guard (another tab may have generated it)
      const c = customers[r.customerId]
      if (!c) { errors.push(`${r.number}: customer no longer exists.`); return }
      const eff = effectiveSalesman(c, occ.date)
      const input = {
        orderDate: now.format('YYYY-MM-DD'), orderType: 'Standard', orderPriority: 'Normal', orderSource: 'recurring',
        customerId: c.id, salesmanId: r.salesmanId && eff.role === 'primary' ? r.salesmanId : eff.salesmanId || c.salesRepId, hubId: r.hubId,
        ...deliveryFromCustomer(c), deliveryAddress: r.deliveryAddress || deliveryFromCustomer(c).deliveryAddress,
        requestedDeliveryDate: occ.date, requestedDeliveryTime: occ.slot.time, deliverySlotId: occ.slot.slotId || '',
        deliveryInstructions: `Recurring ${r.number} · slot ${occ.slot.time}`, paymentTerms: c.creditEnabled ? 'Credit' : 'Cash on Delivery',
        customerReference: r.number, notes: r.notes || '', recurringOrderId: r.id, recurringKey: occ.key,
        items: occ.slot.lines.map((l) => {
          const p = P[l.productId]
          const unit = l.unit || p?.unit
          const isBase = unit === (p?.baseUnit || p?.unit)
          return { key: uid('ln'), productId: l.productId, orderedQuantity: isBase ? String(l.quantity) : String(toBase(p, l.quantity, unit)), entryUnit: unit, entryQuantity: String(l.quantity), discountPercentage: '0', itemNotes: '' }
        }),
      }
      const res = submitOrder(null, input)
      if (!res.ok) { errors.push(`${r.number} ${occ.date} ${occ.slot.time}: ${res.error || Object.values(res.errors || {})[0]}`); return }
      created.push({ scheduleId: r.id, number: r.number, orderId: res.record.id, orderNumber: res.record.orderNumber, date: occ.date, key: occ.key })
    })
  })
  if (created.length) {
    list = getRecurringOrders()
    const by = Object.groupBy ? Object.groupBy(created, (c) => c.scheduleId) : created.reduce((m, c) => ({ ...m, [c.scheduleId]: [...(m[c.scheduleId] || []), c] }), {})
    storage.setItem(K.RECURRING_ORDERS, list.map((r) => (by[r.id] ? { ...r, lastGeneratedAt: new Date().toISOString(), generated: [...(r.generated || []), ...by[r.id].map((c) => ({ key: c.key, orderId: c.orderId, orderNumber: c.orderNumber, at: new Date().toISOString() }))].slice(-500), history: [...(r.history || []), hist(user, 'Orders generated', by[r.id].map((c) => c.orderNumber).join(', '))] } : r)))
    pushNotification({ title: `${created.length} recurring order${created.length === 1 ? '' : 's'} generated`, message: `${created.slice(0, 4).map((c) => c.orderNumber).join(', ')}${created.length > 4 ? '…' : ''} submitted for approval.`, type: 'info', roles: ['SALES_MANAGER', 'ADMIN'], link: '/orders/recurring', category: 'orders' })
  }
  if (errors.length) pushNotification({ title: 'Recurring order generation needs attention', message: errors.slice(0, 2).join(' · '), type: 'warning', userIds: [user.id], link: '/orders/recurring', category: 'orders' })
  return { ok: true, created, errors }
}
