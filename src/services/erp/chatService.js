/**
 * Application chat (data v11): bellomassi_chat_channels + bellomassi_chat_messages.
 *
 * Channel types: personal (1:1), department, group, project, announcement, support, sales, operations, warehouse,
 * dispatch. Messages: text, attachments (images / files kept as data URLs in this browser, ≤ 300 KB each), reply,
 * edit / delete own, pin, read receipts, search, share of business records (order, customer, invoice, dispatch,
 * delivery, product, batch, complaint) as a link card.
 *
 * Real-time is SIMULATED: everything is LocalStorage; other tabs of this browser receive changes through the
 * browser "storage" event (useStorage subscribers re-render) — there is no server and nothing leaves the device.
 * Access: only members see a channel; shared records open with the viewer's own permissions (a shared link never
 * grants access to a record the viewer cannot open).
 */
import storage from '../storageService'
import { STORAGE_KEYS as K } from '../../utils/constants'
import { can } from '../../config/permissions'
import { getCurrentUser } from '../authService'
import { pushNotification } from '../notificationService'
import { uid } from '../../utils/helpers'

const read = (k, f = []) => storage.getItem(k, f) ?? f
export const CHANNEL_TYPES = {
  personal: 'Personal', department: 'Department', group: 'Group', project: 'Project', announcement: 'Announcement', support: 'Support',
  sales: 'Sales team', operations: 'Operations', warehouse: 'Warehouse', dispatch: 'Dispatch',
}
export const SHARE_TYPES = {
  order: { label: 'Order', key: K.ORDERS, path: (id) => `/orders/${id}`, title: (r) => r.orderNumber || 'Draft order', sub: (r) => `${r.customerName} · ${r.orderStatus}`, permission: 'orders.view' },
  customer: { label: 'Customer', key: K.CUSTOMERS, path: (id) => `/customers/${id}`, title: (r) => r.name, sub: (r) => `${r.code} · ${r.city}`, permission: 'customers.view' },
  invoice: { label: 'Invoice', key: K.INVOICES, path: (id) => `/invoices/${id}`, title: (r) => r.invoiceNumber, sub: (r) => `${r.orderNumber} · ${r.status}`, permission: 'invoices.view' },
  dispatch: { label: 'Dispatch', key: K.DISPATCHES, path: (id) => `/dispatch/${id}`, title: (r) => r.dispatchNumber, sub: (r) => `${r.driverName || 'Unassigned'} · ${r.status}`, permission: 'dispatch.view' },
  delivery: { label: 'Delivery', key: K.DELIVERIES, path: (id) => `/dispatch/deliveries/${id}`, title: (r) => `${r.orderNumber} delivery`, sub: (r) => `${r.customerName} · ${r.status}`, permission: 'deliveries.view' },
  product: { label: 'Product', key: K.PRODUCTS, path: (id) => `/products/${id}`, title: (r) => r.name, sub: (r) => `${r.sku} · ${r.barcode || ''}`, permission: 'products.view' },
  batch: { label: 'Batch', key: K.BATCHES, path: (id) => `/inventory/batches?batch=${id}`, title: (r) => r.batchNumber, sub: (r) => `${r.quantity} on hand · exp ${r.expiryDate || '—'}`, permission: 'inventory.batch.view' },
  complaint: { label: 'Complaint', key: K.COMPLAINTS, path: (id) => `/complaints/${id}`, title: (r) => r.number, sub: (r) => `${r.customerName} · ${r.type}`, permission: 'complaints.view' },
}

export const canUseChat = (user = getCurrentUser()) => can(user, 'chat.access')
export const getChannels = () => read(K.CHAT_CHANNELS)
export const getMessages = () => read(K.CHAT_MESSAGES)
export const userName = (id) => (id === 'system' ? 'Bellomassi' : read(K.DEMO_USERS).find((u) => u.id === id)?.name || 'Former user')

/** Channels the user belongs to, newest activity first, with unread counts. */
export const myChannels = (user = getCurrentUser()) => {
  if (!user) return []
  const msgs = getMessages()
  return getChannels().filter((c) => !c.archived && c.members.includes(user.id)).map((c) => {
    const mine = msgs.filter((m) => m.channelId === c.id && !m.deleted)
    const unread = mine.filter((m) => m.senderId !== user.id && !(m.readBy || []).includes(user.id)).length
    const last = mine[mine.length - 1] || null
    const other = c.type === 'personal' ? c.members.find((m) => m !== user.id) : null
    return { ...c, displayName: other ? userName(other) : c.name, unread, last }
  }).sort((a, b) => String(b.last?.createdAt || b.createdAt).localeCompare(String(a.last?.createdAt || a.createdAt)))
}
export const unreadTotal = (user = getCurrentUser()) => myChannels(user).reduce((s, c) => s + c.unread, 0)

export const channelMessages = (channelId, user = getCurrentUser()) => {
  const c = getChannels().find((x) => x.id === channelId)
  if (!c || !user || !c.members.includes(user.id)) return []
  return getMessages().filter((m) => m.channelId === channelId)
}

/** People the user can chat with (active staff accounts; customers / suppliers are excluded). */
export const directory = (q = '', user = getCurrentUser()) => {
  const s = String(q).trim().toLowerCase()
  return read(K.DEMO_USERS).filter((u) => u.id !== user?.id && u.status === 'active' && !['CUSTOMER', 'SUPPLIER'].includes(u.role))
    .filter((u) => !s || [u.name, u.role, u.title, u.department].some((x) => String(x || '').toLowerCase().includes(s)))
}

const writeChannels = (list) => storage.setItem(K.CHAT_CHANNELS, list)

/** Open (or reuse) the 1:1 channel with another user. */
export const openDirect = (otherId) => {
  const user = getCurrentUser()
  if (!canUseChat(user)) return { ok: false, error: 'Chat is not available for your role.' }
  const other = read(K.DEMO_USERS).find((u) => u.id === otherId)
  if (!other || ['CUSTOMER', 'SUPPLIER'].includes(other.role)) return { ok: false, error: 'Choose a staff member.' }
  const list = getChannels()
  const found = list.find((c) => c.type === 'personal' && c.members.length === 2 && c.members.includes(user.id) && c.members.includes(otherId))
  if (found) return { ok: true, record: found }
  const record = { id: uid('chn'), name: `${user.name} · ${other.name}`, type: 'personal', description: '', members: [user.id, otherId], admins: [user.id, otherId], postingRoles: null, createdAt: new Date().toISOString(), createdBy: user.id, archived: false }
  const res = writeChannels([record, ...list])
  return res.ok ? { ok: true, record } : { ok: false, error: res.error }
}

export const createGroup = ({ name, type = 'group', description = '', memberIds = [] }) => {
  const user = getCurrentUser()
  if (!canUseChat(user)) return { ok: false, error: 'Chat is not available for your role.' }
  if (String(name || '').trim().length < 3) return { ok: false, error: 'Enter a group name (at least 3 characters).' }
  if (!CHANNEL_TYPES[type] || type === 'personal') return { ok: false, error: 'Choose the channel type.' }
  if (type === 'announcement' && !can(user, 'chat.announce')) return { ok: false, error: 'Only administrators can create announcement channels.' }
  const members = [...new Set([user.id, ...memberIds])]
  if (members.length < 2) return { ok: false, error: 'Add at least one member.' }
  const list = getChannels()
  if (list.some((c) => !c.archived && c.type !== 'personal' && c.name.toLowerCase() === String(name).trim().toLowerCase())) return { ok: false, error: 'A channel with this name already exists.' }
  const record = { id: uid('chn'), name: String(name).trim(), type, description: String(description).trim(), members, admins: [user.id], postingRoles: type === 'announcement' ? ['ADMIN', 'SUPER_ADMIN'] : null, createdAt: new Date().toISOString(), createdBy: user.id, archived: false }
  const res = writeChannels([record, ...list])
  if (!res.ok) return { ok: false, error: res.error }
  systemMessage(record.id, `${user.name} created ${record.name}.`)
  return { ok: true, record }
}

const isAdminOf = (c, user) => c.admins?.includes(user.id) || ['ADMIN', 'SUPER_ADMIN'].includes(user.role)

export const setMembers = (channelId, { add = [], remove = [] }) => {
  const user = getCurrentUser()
  const list = getChannels()
  const c = list.find((x) => x.id === channelId)
  if (!c) return { ok: false, error: 'This channel no longer exists.' }
  if (c.type === 'personal') return { ok: false, error: 'Personal chats have exactly two members.' }
  if (!isAdminOf(c, user)) return { ok: false, error: 'Only the channel admins can change members.' }
  const members = [...new Set([...c.members.filter((m) => !remove.includes(m)), ...add])]
  if (!members.length) return { ok: false, error: 'A channel needs at least one member.' }
  const record = { ...c, members, admins: (c.admins || []).filter((a) => members.includes(a)) }
  writeChannels(list.map((x) => (x.id === channelId ? record : x)))
  if (add.length) systemMessage(channelId, `${user.name} added ${add.map(userName).join(', ')}.`)
  if (remove.length) systemMessage(channelId, `${user.name} removed ${remove.map(userName).join(', ')}.`)
  return { ok: true, record }
}

const systemMessage = (channelId, body) => storage.setItem(K.CHAT_MESSAGES, [...getMessages(), { id: uid('msg'), channelId, senderId: 'system', senderName: 'Bellomassi', body, system: true, attachments: [], share: null, replyTo: null, pinned: false, editedAt: null, deleted: false, readBy: [], createdAt: new Date().toISOString() }])

/** Resolve a shared record for display, enforcing the viewer's permission. */
export const resolveShare = (share, user = getCurrentUser()) => {
  const t = SHARE_TYPES[share?.type]
  if (!t) return null
  const rec = read(t.key).find((r) => r.id === share.id)
  if (!rec) return { ...share, missing: true, label: t.label }
  const allowed = can(user, t.permission) || (Array.isArray(t.permission) && t.permission.some((p) => can(user, p)))
  return { ...share, label: t.label, title: t.title(rec), sub: allowed ? t.sub(rec) : 'You do not have access to this record', path: allowed ? t.path(rec.id) : null, allowed }
}

/** Records the user can share (search across types they can view). */
export const shareSearch = (type, q = '', user = getCurrentUser()) => {
  const t = SHARE_TYPES[type]
  if (!t || !can(user, t.permission)) return []
  const s = String(q).trim().toLowerCase()
  return read(t.key).filter((r) => !s || [t.title(r), t.sub(r)].some((x) => String(x || '').toLowerCase().includes(s))).slice(0, 20).map((r) => ({ id: r.id, title: t.title(r), sub: t.sub(r) }))
}

const MAX_FILE = 300 * 1024
export const sendMessage = (channelId, { body = '', attachments = [], share = null, replyTo = null }) => {
  const user = getCurrentUser()
  if (!canUseChat(user)) return { ok: false, error: 'Chat is not available for your role.' }
  const c = getChannels().find((x) => x.id === channelId)
  if (!c || !c.members.includes(user.id)) return { ok: false, error: 'You are not a member of this channel.' }
  if (c.postingRoles && !c.postingRoles.includes(user.role) && !can(user, 'chat.announce')) return { ok: false, error: 'Only administrators can post in announcement channels.' }
  const text = String(body || '').trim()
  if (!text && !attachments.length && !share) return { ok: false, error: 'Type a message, attach a file or share a record.' }
  if (text.length > 4000) return { ok: false, error: 'Messages are limited to 4000 characters.' }
  if (attachments.some((a) => String(a.dataUrl || '').length > MAX_FILE * 1.4)) return { ok: false, error: 'Each attachment must be under 300 KB (files are kept in this browser).' }
  if (share) {
    const t = SHARE_TYPES[share.type]
    if (!t || !can(user, t.permission)) return { ok: false, error: 'You can share only records you can open.' }
    if (!read(t.key).some((r) => r.id === share.id)) return { ok: false, error: 'This record no longer exists.' }
  }
  const msg = { id: uid('msg'), channelId, senderId: user.id, senderName: user.name, body: text, attachments: attachments.map((a) => ({ id: uid('att'), name: a.name, type: a.type, size: a.size, dataUrl: a.dataUrl })), share: share ? { type: share.type, id: share.id } : null, replyTo: replyTo || null, pinned: false, editedAt: null, deleted: false, readBy: [user.id], createdAt: new Date().toISOString() }
  const res = storage.setItem(K.CHAT_MESSAGES, [...getMessages(), msg].slice(-3000))
  if (!res.ok) return { ok: false, error: res.error.includes('quota') ? 'Browser storage is full — remove old attachments.' : res.error }
  writeChannels(getChannels().map((x) => (x.id === channelId ? { ...x, lastMessageAt: msg.createdAt } : x)))
  const others = c.members.filter((m) => m !== user.id)
  if (others.length && others.length <= 25) pushNotification({ title: c.type === 'personal' ? `Message from ${user.name}` : `${user.name} in ${c.name}`, message: text ? text.slice(0, 120) : share ? `Shared a ${SHARE_TYPES[share.type].label.toLowerCase()}` : 'Sent an attachment', type: 'info', userIds: others, link: `/chat?c=${channelId}`, category: 'communication' })
  return { ok: true, record: msg }
}

const updateMessage = (id, fn) => {
  const user = getCurrentUser()
  const list = getMessages()
  const m = list.find((x) => x.id === id)
  if (!m) return { ok: false, error: 'This message no longer exists.' }
  const c = getChannels().find((x) => x.id === m.channelId)
  if (!c?.members.includes(user.id)) return { ok: false, error: 'You are not a member of this channel.' }
  const next = fn(m, c, user)
  if (next?.error) return { ok: false, error: next.error }
  storage.setItem(K.CHAT_MESSAGES, list.map((x) => (x.id === id ? next : x)))
  return { ok: true, record: next }
}

export const editMessage = (id, body) => updateMessage(id, (m, c, user) => {
  if (m.senderId !== user.id) return { error: 'You can edit only your own messages.' }
  if (m.deleted) return { error: 'This message was deleted.' }
  if (!String(body || '').trim()) return { error: 'The message cannot be empty.' }
  return { ...m, body: String(body).trim(), editedAt: new Date().toISOString() }
})
export const deleteMessage = (id) => updateMessage(id, (m, c, user) => (m.senderId !== user.id && !isAdminOf(c, user) ? { error: 'You can delete only your own messages.' } : { ...m, deleted: true, body: '', attachments: [], share: null, deletedAt: new Date().toISOString() }))
export const togglePin = (id) => updateMessage(id, (m) => ({ ...m, pinned: !m.pinned }))

export const markChannelRead = (channelId) => {
  const user = getCurrentUser()
  if (!user) return
  const list = getMessages()
  let changed = false
  const next = list.map((m) => {
    if (m.channelId !== channelId || (m.readBy || []).includes(user.id)) return m
    changed = true
    return { ...m, readBy: [...(m.readBy || []), user.id] }
  })
  if (changed) storage.setItem(K.CHAT_MESSAGES, next)
}

/** Message search across the user's channels. */
export const searchMessages = (q, user = getCurrentUser()) => {
  const s = String(q || '').trim().toLowerCase()
  if (s.length < 2) return []
  const ids = new Set(myChannels(user).map((c) => c.id))
  return getMessages().filter((m) => ids.has(m.channelId) && !m.deleted && (m.body.toLowerCase().includes(s) || m.attachments.some((a) => a.name.toLowerCase().includes(s)))).slice(-50).reverse()
}
