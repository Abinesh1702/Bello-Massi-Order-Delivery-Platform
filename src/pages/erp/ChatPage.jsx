import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { MessagesSquare, Plus, Search, Send, Paperclip, Pin, PinOff, Reply, Pencil, Trash2, Users, Share2, Download, Megaphone, Hash, UserRound, X, Check, CheckCheck } from 'lucide-react'
import { toast } from 'sonner'
import dayjs from 'dayjs'
import Card from '../../components/common/Card'
import Button from '../../components/common/Button'
import Modal from '../../components/common/Modal'
import Input from '../../components/common/Input'
import Select from '../../components/common/Select'
import Textarea from '../../components/common/Textarea'
import Badge from '../../components/common/Badge'
import Avatar from '../../components/common/Avatar'
import EmptyState from '../../components/common/EmptyState'
import { useStoredValue } from '../../hooks/useLocalStorage'
import { useAuth } from '../../hooks/useAuth'
import { usePermission } from '../../hooks/usePermission'
import { STORAGE_KEYS as K } from '../../utils/constants'
import {
  CHANNEL_TYPES, channelMessages, createGroup, deleteMessage, directory, editMessage, markChannelRead, myChannels, openDirect, resolveShare,
  searchMessages, sendMessage, setMembers, SHARE_TYPES, shareSearch, togglePin, userName,
} from '../../services/erp/chatService'
import { cn } from '../../utils/helpers'
import { formatBytes, formatDateTime } from '../../utils/formatters'

const NONE = []
const typeIcon = (t) => (t === 'personal' ? UserRound : t === 'announcement' ? Megaphone : t === 'group' || t === 'project' ? Users : Hash)

/**
 * Application chat. Data lives in this browser (LocalStorage); other open tabs update instantly through the storage
 * event — real-time delivery between devices needs a chat server (not part of the prototype).
 */
export default function ChatPage() {
  const { user } = useAuth()
  const [params, setParams] = useSearchParams()
  useStoredValue(K.CHAT_CHANNELS, NONE)
  const allMessages = useStoredValue(K.CHAT_MESSAGES, NONE)
  const canAnnounce = usePermission('chat.announce')
  const channels = myChannels(user)
  const active = channels.find((c) => c.id === params.get('c')) || channels[0] || null
  const [filter, setFilter] = useState('')
  const [search, setSearch] = useState('')
  const [text, setText] = useState('')
  const [reply, setReply] = useState(null)
  const [editing, setEditing] = useState(null)
  const [files, setFiles] = useState([])
  const [modal, setModal] = useState(null)
  const [share, setShare] = useState(null)
  const end = useRef(null)
  const msgs = useMemo(() => (active ? channelMessages(active.id, user) : []), [active?.id, allMessages, user]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (active) markChannelRead(active.id) }, [active?.id, msgs.length]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [active?.id, msgs.length])
  const open = (id) => { const p = new URLSearchParams(params); p.set('c', id); setParams(p, { replace: true }) }
  const visibleChannels = channels.filter((c) => !filter || c.displayName.toLowerCase().includes(filter.toLowerCase()) || CHANNEL_TYPES[c.type]?.toLowerCase().includes(filter.toLowerCase()))
  const found = search.length >= 2 ? searchMessages(search, user) : []
  const pinned = msgs.filter((m) => m.pinned && !m.deleted)

  const attach = async (list) => {
    const out = []
    for (const f of [...list].slice(0, 4)) {
      if (f.size > 300 * 1024) { toast.error(`${f.name} is larger than 300 KB`); continue }
      out.push(await new Promise((res) => { const r = new FileReader(); r.onload = () => res({ name: f.name, type: f.type, size: f.size, dataUrl: String(r.result) }); r.readAsDataURL(f) }))
    }
    setFiles((s) => [...s, ...out])
  }
  const send = (e) => {
    e?.preventDefault()
    if (editing) { const r = editMessage(editing.id, text); if (!r.ok) return toast.error(r.error); setEditing(null); setText(''); return }
    const r = sendMessage(active.id, { body: text, attachments: files, share, replyTo: reply?.id || null })
    if (!r.ok) return toast.error(r.error)
    setText(''); setFiles([]); setReply(null); setShare(null)
  }
  const replyOf = (id) => msgs.find((m) => m.id === id)
  const dayGroups = []
  msgs.forEach((m) => { const d = dayjs(m.createdAt).format('YYYY-MM-DD'); if (!dayGroups.length || dayGroups[dayGroups.length - 1].day !== d) dayGroups.push({ day: d, items: [] }); dayGroups[dayGroups.length - 1].items.push(m) })

  return (
    <div className="grid h-[calc(100vh-150px)] min-h-[520px] gap-4 lg:grid-cols-[300px_1fr]">
      <Card padded={false} className="flex min-h-0 flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-line p-3">
          <h1 className="flex items-center gap-2 text-base font-semibold"><MessagesSquare size={18} />Chat</h1>
          <div className="flex gap-1"><Button size="xs" variant="secondary" icon={UserRound} onClick={() => setModal({ type: 'direct', q: '' })}>New</Button><Button size="xs" variant="secondary" icon={Plus} onClick={() => setModal({ type: 'group', name: '', kind: 'group', members: [], q: '' })}>Group</Button></div>
        </div>
        <div className="space-y-2 border-b border-line p-3">
          <Input aria-label="Filter conversations" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter conversations" icon={Search} />
          <Input aria-label="Search messages" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search messages…" icon={Search} />
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto scroll-thin">
          {search.length >= 2 ? found.map((m) => (
            <li key={m.id}><button type="button" onClick={() => { open(m.channelId); setSearch('') }} className="w-full border-b border-line/60 px-3 py-2 text-left text-sm hover:bg-surface-2"><span className="font-medium">{m.senderName}</span><span className="block truncate text-xs text-muted">{m.body}</span><span className="text-[10px] text-muted">{formatDateTime(m.createdAt)}</span></button></li>
          )) : visibleChannels.map((c) => { const Icon = typeIcon(c.type); return (
            <li key={c.id}><button type="button" onClick={() => open(c.id)} className={cn('flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-2', active?.id === c.id && 'bg-brand/8')}>
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-3 text-ink-2"><Icon size={15} /></span>
              <span className="min-w-0 flex-1"><span className="flex items-center justify-between gap-1"><span className="truncate text-sm font-medium">{c.displayName}</span>{c.last && <span className="shrink-0 text-[10px] text-muted">{dayjs(c.last.createdAt).isSame(dayjs(), 'day') ? dayjs(c.last.createdAt).format('HH:mm') : dayjs(c.last.createdAt).format('DD MMM')}</span>}</span>
                <span className="flex items-center justify-between gap-1"><span className="truncate text-xs text-muted">{c.last ? (c.last.deleted ? 'Message deleted' : `${c.last.senderId === user.id ? 'You: ' : ''}${c.last.body || (c.last.share ? 'Shared a record' : 'Attachment')}`) : CHANNEL_TYPES[c.type]}</span>{c.unread > 0 && <span className="rounded-full bg-brand px-1.5 text-[10px] font-semibold text-white">{c.unread}</span>}</span></span>
            </button></li>) })}
          {search.length >= 2 && !found.length && <li className="p-4 text-sm text-muted">No messages found.</li>}
        </ul>
        <p className="border-t border-line p-2 text-[10.5px] text-muted">Messages are stored in this browser. Other tabs update instantly (simulated real time) — no message leaves this device.</p>
      </Card>
      <Card padded={false} className="flex min-h-0 flex-col">
        {!active ? <EmptyState icon={MessagesSquare} title="No conversations" description="Start a direct message or create a group." /> : (
          <>
            <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
              <div className="min-w-0"><p className="truncate font-semibold">{active.displayName}</p><p className="truncate text-xs text-muted">{CHANNEL_TYPES[active.type]} · {active.members.length} members{active.description ? ` · ${active.description}` : ''}</p></div>
              {active.type !== 'personal' && <Button size="xs" variant="secondary" icon={Users} onClick={() => setModal({ type: 'members', add: [], q: '' })}>Members</Button>}
            </div>
            {pinned.length > 0 && <div className="border-b border-line bg-accent/5 px-4 py-1.5 text-xs"><Pin size={12} className="mr-1 inline" />{pinned.map((m) => m.body.slice(0, 60)).join(' · ')}</div>}
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto scroll-thin px-4 py-3" aria-live="polite">
              {dayGroups.map((g) => (
                <div key={g.day}>
                  <p className="my-2 text-center text-[11px] text-muted">{dayjs(g.day).isSame(dayjs(), 'day') ? 'Today' : dayjs(g.day).format('ddd DD MMM YYYY')}</p>
                  {g.items.map((m) => {
                    const mine = m.senderId === user.id
                    if (m.system) return <p key={m.id} className="my-1 text-center text-xs text-muted">{m.body}</p>
                    const rs = m.share ? resolveShare(m.share, user) : null
                    const rp = m.replyTo ? replyOf(m.replyTo) : null
                    const others = active.members.filter((x) => x !== m.senderId)
                    const readAll = others.length && others.every((x) => (m.readBy || []).includes(x))
                    return (
                      <div key={m.id} className={cn('group my-1 flex gap-2', mine && 'flex-row-reverse')}>
                        {!mine && <Avatar name={m.senderName} size="sm" />}
                        <div className={cn('max-w-[75%] rounded-2xl px-3 py-2 text-sm', mine ? 'bg-navy text-white' : 'bg-surface-2 text-ink', m.pinned && 'ring-2 ring-accent/50')}>
                          {!mine && <p className="text-[11px] font-semibold text-brand">{m.senderName}</p>}
                          {rp && <p className={cn('mb-1 border-l-2 pl-2 text-xs', mine ? 'border-white/50 text-white/80' : 'border-brand/40 text-muted')}>{rp.senderName}: {rp.deleted ? 'deleted' : rp.body.slice(0, 80)}</p>}
                          {m.deleted ? <p className="italic opacity-70">Message deleted</p> : <p className="whitespace-pre-wrap break-words">{m.body}</p>}
                          {m.attachments.map((a) => a.type?.startsWith('image/') ? <a key={a.id} href={a.dataUrl} download={a.name} className="mt-1 block"><img src={a.dataUrl} alt={a.name} className="max-h-48 rounded-lg" /></a> : <a key={a.id} href={a.dataUrl} download={a.name} className={cn('mt-1 flex items-center gap-1 rounded-lg px-2 py-1 text-xs', mine ? 'bg-white/15' : 'bg-surface-3')}><Download size={12} />{a.name} · {formatBytes(a.size)}</a>)}
                          {rs && <div className={cn('mt-1 rounded-lg border px-2 py-1.5 text-xs', mine ? 'border-white/30 bg-white/10' : 'border-line bg-surface')}><span className="font-semibold">{rs.label}</span> · {rs.missing ? 'no longer exists' : rs.path ? <Link to={rs.path} className={cn('underline', mine ? 'text-white' : 'text-brand')}>{rs.title}</Link> : rs.title}<span className="block opacity-80">{rs.sub}</span></div>}
                          <p className={cn('mt-0.5 flex items-center gap-1 text-[10px]', mine ? 'justify-end text-white/70' : 'text-muted')}>{dayjs(m.createdAt).format('HH:mm')}{m.editedAt && ' · edited'}{mine && (readAll ? <CheckCheck size={12} aria-label="Read" /> : <Check size={12} aria-label="Sent" />)}</p>
                        </div>
                        {!m.deleted && <div className="flex items-start gap-0.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                          <button type="button" aria-label="Reply" className="rounded p-1 text-muted hover:bg-surface-3" onClick={() => setReply(m)}><Reply size={13} /></button>
                          <button type="button" aria-label={m.pinned ? 'Unpin' : 'Pin'} className="rounded p-1 text-muted hover:bg-surface-3" onClick={() => togglePin(m.id)}>{m.pinned ? <PinOff size={13} /> : <Pin size={13} />}</button>
                          {mine && <button type="button" aria-label="Edit" className="rounded p-1 text-muted hover:bg-surface-3" onClick={() => { setEditing(m); setText(m.body) }}><Pencil size={13} /></button>}
                          {mine && <button type="button" aria-label="Delete" className="rounded p-1 text-muted hover:bg-surface-3" onClick={() => { const r = deleteMessage(m.id); if (!r.ok) toast.error(r.error) }}><Trash2 size={13} /></button>}
                        </div>}
                      </div>
                    )
                  })}
                </div>
              ))}
              <div ref={end} />
            </div>
            <form onSubmit={send} className="border-t border-line p-3">
              {(reply || editing || share || files.length > 0) && (
                <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                  {reply && <Badge>Replying to {reply.senderName} <button type="button" aria-label="Cancel reply" onClick={() => setReply(null)}><X size={11} /></button></Badge>}
                  {editing && <Badge tone="warning">Editing message <button type="button" aria-label="Cancel edit" onClick={() => { setEditing(null); setText('') }}><X size={11} /></button></Badge>}
                  {share && <Badge tone="brand">{SHARE_TYPES[share.type].label}: {share.title} <button type="button" aria-label="Remove share" onClick={() => setShare(null)}><X size={11} /></button></Badge>}
                  {files.map((f, i) => <Badge key={i}>{f.name} <button type="button" aria-label="Remove file" onClick={() => setFiles(files.filter((_, j) => j !== i))}><X size={11} /></button></Badge>)}
                </div>
              )}
              <div className="flex items-end gap-2">
                <label className="grid h-10 w-10 shrink-0 cursor-pointer place-items-center rounded-lg border border-line hover:bg-surface-2" title="Attach files"><Paperclip size={16} /><input type="file" multiple className="sr-only" onChange={(e) => attach(e.target.files)} aria-label="Attach files" /></label>
                <button type="button" title="Share a record" aria-label="Share a record" className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-line hover:bg-surface-2" onClick={() => setModal({ type: 'share', kind: 'order', q: '' })}><Share2 size={16} /></button>
                <textarea aria-label="Message" rows={1} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) send(e) }} placeholder={active.type === 'announcement' && !canAnnounce ? 'Only administrators can post here' : 'Write a message — Enter to send, Shift+Enter for a new line'} disabled={active.type === 'announcement' && !canAnnounce} className="max-h-32 min-h-10 flex-1 resize-y rounded-lg border border-line bg-surface px-3 py-2 text-sm focus:border-brand focus:outline-none" />
                <Button type="submit" icon={Send} disabled={active.type === 'announcement' && !canAnnounce}>{editing ? 'Save' : 'Send'}</Button>
              </div>
            </form>
          </>
        )}
      </Card>

      <Modal open={modal?.type === 'direct'} onClose={() => setModal(null)} title="New message" icon={UserRound}>
        <Input label="Search people or departments" value={modal?.q || ''} onChange={(e) => setModal({ ...modal, q: e.target.value })} autoFocus />
        <ul className="mt-2 max-h-72 overflow-y-auto scroll-thin">{directory(modal?.q || '', user).map((u) => <li key={u.id}><button type="button" className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-2" onClick={() => { const r = openDirect(u.id); if (!r.ok) return toast.error(r.error); open(r.record.id); setModal(null) }}><Avatar name={u.name} size="sm" /><span>{u.name}<span className="block text-xs text-muted">{u.title || u.role}</span></span></button></li>)}</ul>
      </Modal>
      <Modal open={modal?.type === 'group'} onClose={() => setModal(null)} title="Create group" icon={Users}
        footer={<><Button variant="secondary" onClick={() => setModal(null)}>Cancel</Button><Button onClick={() => { const r = createGroup({ name: modal.name, type: modal.kind, memberIds: modal.members, description: modal.description }); if (!r.ok) return toast.error(r.error); open(r.record.id); setModal(null) }}>Create</Button></>}>
        {modal?.type === 'group' && <div className="space-y-3">
          <Input label="Name" value={modal.name} onChange={(e) => setModal({ ...modal, name: e.target.value })} required />
          <Select label="Type" value={modal.kind} onChange={(e) => setModal({ ...modal, kind: e.target.value })} options={Object.entries(CHANNEL_TYPES).filter(([k]) => k !== 'personal' && (k !== 'announcement' || canAnnounce)).map(([v, l]) => ({ value: v, label: l }))} />
          <Textarea label="Description" value={modal.description || ''} onChange={(e) => setModal({ ...modal, description: e.target.value })} rows={2} />
          <Input label="Add members" value={modal.q} onChange={(e) => setModal({ ...modal, q: e.target.value })} placeholder="Search people" />
          <ul className="max-h-48 overflow-y-auto scroll-thin">{directory(modal.q, user).map((u) => <li key={u.id}><label className="flex items-center gap-2 px-1 py-1 text-sm"><input type="checkbox" checked={modal.members.includes(u.id)} onChange={() => setModal({ ...modal, members: modal.members.includes(u.id) ? modal.members.filter((x) => x !== u.id) : [...modal.members, u.id] })} />{u.name}<span className="text-xs text-muted">{u.title}</span></label></li>)}</ul>
        </div>}
      </Modal>
      <Modal open={modal?.type === 'members'} onClose={() => setModal(null)} title={`Members — ${active?.displayName}`} icon={Users}>
        {modal?.type === 'members' && active && <div className="space-y-3">
          <ul className="divide-y divide-line text-sm">{active.members.map((id) => <li key={id} className="flex items-center justify-between py-1.5"><span>{userName(id)}{active.admins?.includes(id) && <Badge className="ml-1">admin</Badge>}</span>{id !== user.id && <Button size="xs" variant="ghost" onClick={() => { const r = setMembers(active.id, { remove: [id] }); if (!r.ok) toast.error(r.error) }}>Remove</Button>}</li>)}</ul>
          <Input label="Add people" value={modal.q} onChange={(e) => setModal({ ...modal, q: e.target.value })} />
          <ul className="max-h-40 overflow-y-auto">{directory(modal.q, user).filter((u) => !active.members.includes(u.id)).slice(0, 12).map((u) => <li key={u.id}><button type="button" className="w-full rounded px-2 py-1 text-left text-sm hover:bg-surface-2" onClick={() => { const r = setMembers(active.id, { add: [u.id] }); if (!r.ok) toast.error(r.error) }}>+ {u.name}</button></li>)}</ul>
        </div>}
      </Modal>
      <Modal open={modal?.type === 'share'} onClose={() => setModal(null)} title="Share a record" icon={Share2}>
        {modal?.type === 'share' && <div className="space-y-3">
          <Select label="Type" value={modal.kind} onChange={(e) => setModal({ ...modal, kind: e.target.value })} options={Object.entries(SHARE_TYPES).map(([v, t]) => ({ value: v, label: t.label }))} />
          <Input label="Search" value={modal.q} onChange={(e) => setModal({ ...modal, q: e.target.value })} />
          <ul className="max-h-60 overflow-y-auto scroll-thin">{shareSearch(modal.kind, modal.q, user).map((r) => <li key={r.id}><button type="button" className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-surface-2" onClick={() => { setShare({ type: modal.kind, id: r.id, title: r.title }); setModal(null) }}>{r.title}<span className="block text-xs text-muted">{r.sub}</span></button></li>)}</ul>
          <p className="text-xs text-muted">Recipients open the record with their own permissions.</p>
        </div>}
      </Modal>
    </div>
  )
}
