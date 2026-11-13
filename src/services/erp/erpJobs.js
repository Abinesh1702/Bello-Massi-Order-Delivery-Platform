/**
 * Background jobs of the advanced ERP layer (browser-only, data v11). They run on sign-in (auth change) and on a
 * timer while the app is open; each one is idempotent, so running in several tabs or repeatedly is safe:
 *   • expiry detection → expired lots blocked, one scrap request per lot, Admin notified
 *   • recurring orders → due occurrences generated for users allowed to manage them
 *   • vendor quality → thresholds re-checked
 *   • salesman coverage → Sales Manager notified about customers with no available salesman
 */
import storage from '../storageService'
import { STORAGE_KEYS as K } from '../../utils/constants'
import { getCurrentUser } from '../authService'
import { can } from '../../config/permissions'
import { detectExpiry } from './stockControlService'
import { generateDueOrders } from './recurringService'
import { checkVendorQuality } from './complaintService'
import { notifyUncovered } from './salesAssignmentService'
import { syncBatches } from '../enterprise/batchService'

let timer = null
let lastUser = null
const settings = () => storage.getItem(K.ERP_SETTINGS, {}) || {}

export const runErpJobs = ({ reason = 'timer' } = {}) => {
  const user = getCurrentUser()
  if (!user) return { ran: false }
  const out = { ran: true, reason }
  try {
    syncBatches()
    out.expiry = detectExpiry()
    if (settings().recurring?.autoGenerate !== false && can(user, 'recurring.manage') && can(user, 'orders.create')) out.recurring = generateDueOrders()
    out.vendorAlerts = checkVendorQuality().length
    if (can(user, 'customers.assignment.manage')) out.uncovered = notifyUncovered()
  } catch (e) {
    console.warn('[Bellomassi] ERP job failed', e)
    out.error = String(e?.message || e)
  }
  return out
}

export const installErpJobs = () => {
  if (typeof window === 'undefined' || timer) return
  const minutes = Math.max(5, Number(settings().expiry?.scanIntervalMinutes) || 30)
  timer = window.setInterval(() => runErpJobs({ reason: 'timer' }), minutes * 60 * 1000)
  // On sign-in (session key written) — and once shortly after start for an existing session
  storage.subscribe?.(() => {
    const u = getCurrentUser()
    if (u && u.id !== lastUser) { lastUser = u.id; window.setTimeout(() => runErpJobs({ reason: 'login' }), 800) }
    if (!u) lastUser = null
  })
  window.setTimeout(() => { const u = getCurrentUser(); if (u) { lastUser = u.id; runErpJobs({ reason: 'start' }) } }, 1500)
}
