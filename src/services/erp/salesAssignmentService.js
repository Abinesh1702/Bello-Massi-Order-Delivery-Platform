/**
 * Customer ↔ salesman assignment (data v11).
 *
 * Every customer has a primary salesman (customer.salesRepId), an optional secondary salesman, a sales team and a
 * sales manager. The EFFECTIVE salesman (used for new orders, recurring orders, complaints and notifications) is:
 *   primary when available → secondary when the primary is on leave / resigned / terminated / inactive →
 *   when both are unavailable the Sales Manager is notified (once per customer and day) and stays responsible until
 *   someone reassigns — a customer is never left without an owner.
 * Availability comes from HR: approved leave covering the date, employee status (Resigned / Terminated), the user
 * account status and the sales-rep record status (salesReps[].status, editable on the Sales Team page).
 */
import dayjs from 'dayjs'
import storage from '../storageService'
import { STORAGE_KEYS as K } from '../../utils/constants'
import { can } from '../../config/permissions'
import { getCurrentUser } from '../authService'
import { logAudit } from '../auditService'
import { pushNotification } from '../notificationService'
import { uid } from '../../utils/helpers'

const read = (k, f = []) => storage.getItem(k, f) ?? f
export const REP_STATUSES = ['Active', 'On Leave', 'Resigned', 'Terminated', 'Inactive']

/** Everyone who can own customers: sales-rep records + users with a sales role (deduplicated by id). */
export const getSalesPeople = () => {
  const reps = read(K.DEMO_DATA, {})?.salesReps || []
  const users = read(K.DEMO_USERS).filter((u) => ['SALESMAN', 'HORECA_SALES_EXEC', 'VAN_SALES_EXEC', 'SALES_MANAGER'].includes(u.role))
  const out = reps.map((r) => ({ ...r, userId: r.userId || null, role: users.find((u) => u.id === r.userId)?.role || 'SALESMAN' }))
  users.forEach((u) => { if (!out.some((x) => x.id === u.id || x.userId === u.id)) out.push({ id: u.id, name: u.name, userId: u.id, hubId: u.hubId, status: u.status === 'active' ? 'Active' : 'Inactive', role: u.role }) })
  return out
}
export const personName = (id) => getSalesPeople().find((p) => p.id === id)?.name || read(K.DEMO_USERS).find((u) => u.id === id)?.name || '—'

/** { available, status, reason } of a salesman on a date. */
export const salesmanAvailability = (id, date = dayjs()) => {
  if (!id) return { available: false, status: 'Unassigned', reason: 'No salesman' }
  const day = dayjs(date).format('YYYY-MM-DD')
  const person = getSalesPeople().find((p) => p.id === id)
  const userId = person?.userId || id
  const user = read(K.DEMO_USERS).find((u) => u.id === userId)
  const emp = read(K.EMPLOYEES).find((e) => e.userId === userId)
  if (person?.status === 'Resigned' || /RESIGN/i.test(emp?.status || '')) return { available: false, status: 'Resigned', reason: 'Resigned' }
  if (person?.status === 'Terminated' || /TERMINAT/i.test(emp?.status || '')) return { available: false, status: 'Terminated', reason: 'Terminated' }
  if (person?.status === 'Inactive' || (user && user.status !== 'active') || /INACTIVE/i.test(emp?.status || '')) return { available: false, status: 'Inactive', reason: 'Inactive' }
  const leave = read(K.LEAVE_REQUESTS).find((l) => (l.userId === userId || (emp && l.employeeId === emp.id)) && l.status === 'APPROVED' && l.fromDate <= day && l.toDate >= day)
  if (leave || person?.status === 'On Leave') return { available: false, status: 'On Leave', reason: leave ? `${leave.leaveType} ${dayjs(leave.fromDate).format('DD MMM')}–${dayjs(leave.toDate).format('DD MMM')}` : 'On leave' }
  if (!person && !user) return { available: false, status: 'Unknown', reason: 'Salesman not found' }
  return { available: true, status: 'Active', reason: '' }
}

/** Effective owner of a customer on a date: { salesmanId, role: 'primary'|'secondary'|'manager', reason, needsReassignment }. */
export const effectiveSalesman = (customer, date = dayjs()) => {
  if (!customer) return { salesmanId: null, role: null, reason: 'No customer' }
  const p = salesmanAvailability(customer.salesRepId, date)
  if (p.available) return { salesmanId: customer.salesRepId, role: 'primary', reason: '', needsReassignment: false }
  const s = customer.secondarySalesRepId ? salesmanAvailability(customer.secondarySalesRepId, date) : { available: false, reason: 'No secondary salesman' }
  if (s.available) return { salesmanId: customer.secondarySalesRepId, role: 'secondary', reason: `Primary ${personName(customer.salesRepId)} is ${p.status.toLowerCase()} — secondary salesman covers.`, needsReassignment: ['Resigned', 'Terminated', 'Inactive'].includes(p.status) }
  const manager = customer.salesManagerId || read(K.DEMO_USERS).find((u) => u.role === 'SALES_MANAGER')?.id || null
  return { salesmanId: manager, role: 'manager', reason: `Primary (${p.status}) and secondary (${s.status || s.reason}) are both unavailable — the Sales Manager is responsible until the customer is reassigned.`, needsReassignment: true }
}

/** Customers whose primary is unavailable today (dashboard + Sales Manager queue). */
export const assignmentExceptions = (date = dayjs()) => read(K.CUSTOMERS).filter((c) => c.status !== 'Inactive').map((c) => ({ customer: c, eff: effectiveSalesman(c, date) })).filter((x) => x.eff.role !== 'primary')

/** Notify the Sales Manager once per customer and day when both salesmen are unavailable (called by erpJobs). */
export const notifyUncovered = (date = dayjs()) => {
  const day = dayjs(date).format('YYYY-MM-DD')
  const notified = read(K.ERP_SETTINGS, {})?.uncoveredNotified || {}
  const fresh = assignmentExceptions(date).filter((x) => x.eff.role === 'manager' && notified[x.customer.id] !== day)
  if (!fresh.length) return 0
  pushNotification({ title: `${fresh.length} customer${fresh.length === 1 ? ' has' : 's have'} no available salesman`, message: `${fresh.slice(0, 3).map((x) => x.customer.name).join(', ')}${fresh.length > 3 ? '…' : ''}: primary and secondary are unavailable. Reassign them.`, type: 'warning', roles: ['SALES_MANAGER', 'ADMIN'], link: '/sales/assignments', category: 'sales' })
  const s = read(K.ERP_SETTINGS, {}) || {}
  storage.withoutWriteHooks(() => storage.setItem(K.ERP_SETTINGS, { ...s, uncoveredNotified: { ...notified, ...Object.fromEntries(fresh.map((x) => [x.customer.id, day])) } }))
  return fresh.length
}

/** Assign primary / secondary salesman (Admin / Sales Manager). Reason required; history kept on the customer. */
export const assignSalesmen = (customerId, { primaryId, secondaryId = null, salesTeam, salesManagerId, reason = '', manualOverride = false }) => {
  const user = getCurrentUser()
  if (!can(user, 'customers.assignment.manage')) return { ok: false, error: 'Only a Sales Manager or Administrator can reassign customers.' }
  const people = getSalesPeople()
  if (!people.some((p) => p.id === primaryId)) return { ok: false, error: 'Choose the primary salesman.' }
  if (secondaryId && !people.some((p) => p.id === secondaryId)) return { ok: false, error: 'Choose a valid secondary salesman.' }
  if (secondaryId && secondaryId === primaryId) return { ok: false, error: 'Primary and secondary salesman must be different people.' }
  if (String(reason).trim().length < 5) return { ok: false, error: 'Enter the reason for the change (at least 5 characters).' }
  const pa = salesmanAvailability(primaryId)
  if (!pa.available && !manualOverride) return { ok: false, error: `${personName(primaryId)} is ${pa.status.toLowerCase()} (${pa.reason}). Tick "manual override" to assign anyway.` }
  const customers = read(K.CUSTOMERS)
  const c = customers.find((x) => x.id === customerId)
  if (!c) return { ok: false, error: 'This customer no longer exists.' }
  const now = new Date().toISOString()
  const entry = { id: uid('cah'), at: now, by: user.id, byName: user.name, fromPrimary: c.salesRepId, fromSecondary: c.secondarySalesRepId || null, toPrimary: primaryId, toSecondary: secondaryId || null, reason: String(reason).trim(), manualOverride: Boolean(manualOverride) }
  const record = { ...c, salesRepId: primaryId, secondarySalesRepId: secondaryId || null, salesTeam: salesTeam ?? c.salesTeam, salesManagerId: salesManagerId ?? c.salesManagerId, assignmentHistory: [entry, ...(c.assignmentHistory || [])], updatedAt: now }
  const res = storage.setItem(K.CUSTOMERS, customers.map((x) => (x.id === customerId ? record : x)))
  if (!res.ok) return { ok: false, error: res.error }
  logAudit({ module: 'customers', action: 'Salesman assignment', entity: 'Customer', recordId: c.id, recordLabel: c.name, description: `${personName(c.salesRepId)} → ${personName(primaryId)}; secondary ${personName(secondaryId)}: ${reason}` })
  const target = people.find((p) => p.id === primaryId)?.userId
  if (target) pushNotification({ title: `Customer assigned: ${c.name}`, message: `${user.name} made you the primary salesman. ${reason}`, type: 'info', userIds: [target], link: `/customers/${c.id}`, category: 'sales' })
  return { ok: true, record }
}

/** Bulk move every customer of one salesman to another (resignation hand-over). */
export const handOver = (fromId, toId, { secondaryId = null, reason = '' } = {}) => {
  const list = read(K.CUSTOMERS).filter((c) => c.salesRepId === fromId)
  if (!list.length) return { ok: false, error: 'This salesman has no customers as primary.' }
  const results = list.map((c) => assignSalesmen(c.id, { primaryId: toId, secondaryId: secondaryId ?? (c.secondarySalesRepId === toId ? null : c.secondarySalesRepId), reason: reason || `Hand-over from ${personName(fromId)}`, manualOverride: false }))
  const failed = results.find((r) => !r.ok)
  return failed ? { ok: false, error: failed.error, done: results.filter((r) => r.ok).length } : { ok: true, count: results.length }
}

/** Change a sales rep's employment status (Sales Team page). */
export const setRepStatus = (repId, status, reason = '') => {
  const user = getCurrentUser()
  if (!can(user, 'customers.assignment.manage')) return { ok: false, error: 'Only a Sales Manager or Administrator can change this.' }
  if (!REP_STATUSES.includes(status)) return { ok: false, error: 'Choose a status.' }
  const demo = read(K.DEMO_DATA, {}) || {}
  const reps = demo.salesReps || []
  const rep = reps.find((r) => r.id === repId)
  if (!rep) return { ok: false, error: 'Only sales-rep records can be changed here; user accounts follow User Management and HR.' }
  const res = storage.setItem(K.DEMO_DATA, { ...demo, salesReps: reps.map((r) => (r.id === repId ? { ...r, status, statusReason: reason, statusChangedAt: new Date().toISOString() } : r)) })
  if (!res.ok) return { ok: false, error: res.error }
  logAudit({ module: 'customers', action: `Salesman ${status}`, entity: 'Sales rep', recordId: repId, recordLabel: rep.name, description: reason })
  if (status !== 'Active') notifyUncovered()
  return { ok: true }
}

/** Save / verify the map location of a customer (pin, coordinates or gazetteer search result). */
export const setCustomerLocation = (customerId, { lat, lng, verified = false, source = 'Map pin' }) => {
  const user = getCurrentUser()
  if (!can(user, 'customers.location.manage')) return { ok: false, error: 'You do not have permission to change customer locations.' }
  const la = Number(lat)
  const ln = Number(lng)
  if (!(Math.abs(la) <= 90 && Math.abs(ln) <= 180) || (la === 0 && ln === 0) || Number.isNaN(la) || Number.isNaN(ln)) return { ok: false, error: 'Enter a valid latitude (−90…90) and longitude (−180…180).' }
  const customers = read(K.CUSTOMERS)
  const c = customers.find((x) => x.id === customerId)
  if (!c) return { ok: false, error: 'This customer no longer exists.' }
  const record = { ...c, latitude: Math.round(la * 1e6) / 1e6, longitude: Math.round(ln * 1e6) / 1e6, locationVerified: Boolean(verified), locationSource: source, locationVerifiedAt: verified ? new Date().toISOString() : c.locationVerifiedAt || null, locationVerifiedBy: verified ? user.name : c.locationVerifiedBy || null, updatedAt: new Date().toISOString() }
  const res = storage.setItem(K.CUSTOMERS, customers.map((x) => (x.id === customerId ? record : x)))
  if (!res.ok) return { ok: false, error: res.error }
  logAudit({ module: 'customers', action: verified ? 'Location verified' : 'Location updated', entity: 'Customer', recordId: c.id, recordLabel: c.name, description: `${record.latitude}, ${record.longitude} (${source})` })
  return { ok: true, record }
}
