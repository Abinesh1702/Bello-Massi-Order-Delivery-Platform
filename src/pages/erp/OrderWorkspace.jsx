import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ShoppingCart, Search, Star, Clock, Flame, UserRound, Plus, Minus, Trash2, Send, Save, AlertTriangle, CreditCard, Copy, PackageCheck, Keyboard } from 'lucide-react'
import { toast } from 'sonner'
import dayjs from 'dayjs'
import PageHeader from '../../components/common/PageHeader'
import Card, { CardHeader } from '../../components/common/Card'
import Badge from '../../components/common/Badge'
import Button from '../../components/common/Button'
import Input from '../../components/common/Input'
import Select from '../../components/common/Select'
import Textarea from '../../components/common/Textarea'
import Checkbox from '../../components/common/Checkbox'
import ProductThumb from '../../components/masterdata/ProductThumb'
import { useStoredValue } from '../../hooks/useLocalStorage'
import { useAuth } from '../../hooks/useAuth'
import { STORAGE_KEYS as K } from '../../utils/constants'
import { createOrder, deliveryFromCustomer, emptyOrderInput, getHubStockLevel, getOrderCreditPosition, newItemKey, priceOrderInput, submitOrder, validateOrder } from '../../services/orderService'
import { effectiveSalesman, personName } from '../../services/erp/salesAssignmentService'
import { getPrefs, toggleFavourite } from '../../services/erp/workspaceService'
import { findByBarcode } from '../../services/erp/workspaceService'
import { productUnits, toBase } from '../../utils/units'
import { formatMoney } from '../../utils/formatters'
import { cn } from '../../utils/helpers'
import { ScanButton } from '../../components/erp/ErpUi'
import { PRODUCT_CATEGORIES } from '../../config/masterData'

const NONE = []
const TABS = [['all', 'All', Search], ['fav', 'Favourites', Star], ['frequent', 'Frequent', Flame], ['recent', 'Recent', Clock], ['customer', 'This customer', UserRound]]

/**
 * Order creation workspace: customer, delivery date and slot on the left; product finder (search, SKU, barcode scan,
 * category, favourites / frequent / recent / customer-specific) in the middle; the cart with quantities in any unit
 * of the product (converted to the base unit), totals and every validation on the right. Saves a draft or submits for
 * approval through orderService — the same rules as every other order path.
 * Keyboard: "/" search · Enter adds the first match · Ctrl+Enter submits · Ctrl+S saves a draft.
 */
export default function OrderWorkspace() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const customers = useStoredValue(K.CUSTOMERS, NONE)
  const products = useStoredValue(K.PRODUCTS, NONE)
  const hubs = useStoredValue(K.HUBS, NONE)
  const orders = useStoredValue(K.ORDERS, NONE)
  const inventory = useStoredValue(K.INVENTORY, NONE)
  const settings = useStoredValue(K.ERP_SETTINGS, {})
  useStoredValue(K.USER_PREFS, {})
  const [input, setInput] = useState(() => ({ ...emptyOrderInput(user), deliverySlotId: '' }))
  const [custQ, setCustQ] = useState('')
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('')
  const [tab, setTab] = useState('all')
  const [errors, setErrors] = useState({})
  const [busy, setBusy] = useState(false)
  const searchRef = useRef(null)
  const prefs = getPrefs(user)
  const customer = customers.find((c) => c.id === input.customerId) || null
  const P = useMemo(() => Object.fromEntries(products.map((p) => [p.id, p])), [products])
  const eff = customer ? effectiveSalesman(customer, input.requestedDeliveryDate) : null

  const pickCustomer = (c) => {
    const salesman = ['SALESMAN', 'HORECA_SALES_EXEC', 'VAN_SALES_EXEC'].includes(user.role) ? user.id : effectiveSalesman(c, input.requestedDeliveryDate).salesmanId || c.salesRepId
    setInput((s) => ({ ...s, customerId: c.id, hubId: c.hubId || s.hubId, salesmanId: salesman, ...deliveryFromCustomer(c), paymentTerms: c.creditEnabled ? 'Credit' : 'Cash on Delivery', deliverySlotId: c.deliverySlotId || s.deliverySlotId }))
    setCustQ('')
  }
  const custMatches = custQ.length >= 1 ? customers.filter((c) => [c.name, c.code, c.mobile, c.city].some((x) => String(x || '').toLowerCase().includes(custQ.toLowerCase()))).slice(0, 8) : []

  // Product lists
  const since = dayjs().subtract(90, 'day').format('YYYY-MM-DD')
  const frequency = useMemo(() => { const m = {}; orders.filter((o) => o.orderDate >= since && !['CANCELLED', 'REJECTED', 'DRAFT'].includes(o.orderStatus)).forEach((o) => o.items.forEach((it) => { m[it.productId] = (m[it.productId] || 0) + 1 })); return m }, [orders, since])
  const recentIds = useMemo(() => [...new Set(orders.filter((o) => o.createdBy === user.id || o.salesmanId === user.id).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).flatMap((o) => o.items.map((i) => i.productId)))].slice(0, 24), [orders, user.id])
  const customerHistory = useMemo(() => { const m = {}; orders.filter((o) => o.customerId === input.customerId && !['CANCELLED', 'REJECTED'].includes(o.orderStatus)).sort((a, b) => String(a.orderDate).localeCompare(String(b.orderDate))).forEach((o) => o.items.forEach((it) => { m[it.productId] = { count: (m[it.productId]?.count || 0) + 1, lastQty: it.entryQuantity ?? it.orderedQuantity, lastUnit: it.entryUnit || it.unit } })); return m }, [orders, input.customerId])
  const list = useMemo(() => {
    let base = products.filter((p) => p.status === 'Active')
    if (tab === 'fav') base = base.filter((p) => prefs.favouriteProducts.includes(p.id))
    if (tab === 'frequent') base = base.filter((p) => frequency[p.id]).sort((a, b) => frequency[b.id] - frequency[a.id])
    if (tab === 'recent') base = recentIds.map((id) => P[id]).filter(Boolean)
    if (tab === 'customer') base = base.filter((p) => customerHistory[p.id]).sort((a, b) => customerHistory[b.id].count - customerHistory[a.id].count)
    const s = q.trim().toLowerCase()
    return base.filter((p) => (!cat || p.category === cat) && (!s || [p.name, p.sku, p.code, p.barcode, p.subcategory].some((x) => String(x || '').toLowerCase().includes(s)))).slice(0, 60)
  }, [products, tab, prefs.favouriteProducts, frequency, recentIds, customerHistory, q, cat, P])

  // Cart
  const addLine = (p, qty = null, unit = null) => {
    if (!p) return
    setInput((s) => {
      const existing = s.items.find((l) => l.productId === p.id)
      const u = unit || existing?.entryUnit || customerHistory[p.id]?.lastUnit || p.salesUnit || p.unit
      const add = Number(qty ?? (customerHistory[p.id]?.lastQty || p.minOrderQty || 1))
      if (existing) { toast.message(`${p.name} is already in the cart — quantity increased`); return { ...s, items: s.items.map((l) => (l.productId === p.id ? { ...l, entryQuantity: String((Number(l.entryQuantity) || 0) + (l.entryUnit === u ? add : 0) || add) } : l)) } }
      return { ...s, items: [...s.items, { key: newItemKey(), productId: p.id, entryUnit: u, entryQuantity: String(add), orderedQuantity: '', discountPercentage: '0', itemNotes: '' }] }
    })
  }
  const setLine = (key, patch) => setInput((s) => ({ ...s, items: s.items.map((l) => (l.key === key ? { ...l, ...patch } : l)) }))
  const removeLine = (key) => setInput((s) => ({ ...s, items: s.items.filter((l) => l.key !== key) }))
  // Base quantity mirrors the entry quantity × unit factor (validation and pricing convert again)
  const normalized = useMemo(() => ({ ...input, items: input.items.map((l) => { const p = P[l.productId]; const base = p ? toBase(p, Number(l.entryQuantity), l.entryUnit) : 0; return { ...l, orderedQuantity: l.entryUnit === (p?.baseUnit || p?.unit) ? l.entryQuantity : String(base ?? '') } }) }), [input, P])
  const priced = useMemo(() => priceOrderInput(normalized), [normalized, inventory]) // eslint-disable-line react-hooks/exhaustive-deps
  const live = useMemo(() => validateOrder(normalized, { mode: 'submit' }), [normalized, orders]) // eslint-disable-line react-hooks/exhaustive-deps
  const credit = customer ? getOrderCreditPosition(customer, priced.totals.totalAmount) : null
  const lastOrder = useMemo(() => orders.filter((o) => o.customerId === input.customerId && o.orderStatus !== 'DRAFT').sort((a, b) => String(b.orderDate).localeCompare(String(a.orderDate)))[0], [orders, input.customerId])

  const save = (submit) => {
    setBusy(true)
    const payload = normalized
    const res = submit ? submitOrder(null, payload) : createOrder(payload)
    setBusy(false)
    if (!res.ok) { setErrors(res.errors || {}); toast.error(res.error || Object.values(res.errors || {})[0] || 'Please fix the highlighted items.'); return }
    toast.success(submit ? `${res.record.orderNumber} submitted for approval` : 'Draft saved')
    navigate(`/orders/${res.record.id}`)
  }
  useEffect(() => {
    const h = (e) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') { e.preventDefault(); searchRef.current?.focus() }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(true) }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(false) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })
  const onScan = (code) => { const p = findByBarcode(code); if (!p) { toast.error(`No product with barcode ${code}`); return } addLine(p); toast.success(`${p.name} added`) }
  const err = (k) => errors[k] || (input.items.length ? live[k] : null)
  const lineErr = (l, f) => errors[`item:${l.key}:${f}`] || live[`item:${l.key}:${f}`]
  const slots = settings.deliverySlots || []

  return (
    <>
      <PageHeader title="Order workspace" description="Find products fast, enter quantities in any unit, check stock and credit, then save a draft or submit for approval."
        actions={<><span className="hidden items-center gap-1 text-xs text-muted lg:flex"><Keyboard size={14} />/ search · Enter add · Ctrl+Enter submit · Ctrl+S draft</span><Button variant="secondary" icon={Save} loading={busy} onClick={() => save(false)} disabled={!input.customerId}>Save draft</Button><Button icon={Send} loading={busy} onClick={() => save(true)} disabled={!input.customerId || !input.items.length}>Submit for approval</Button></>} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] 2xl:grid-cols-[300px_minmax(0,1fr)_380px]">
        {/* Customer & delivery */}
        <div className="space-y-4 lg:col-span-2 lg:grid lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start lg:gap-4 lg:space-y-0 2xl:col-span-1 2xl:block 2xl:space-y-4">
          <Card>
            <CardHeader title="Customer" icon={UserRound} />
            {customer ? (
              <div className="space-y-2 text-sm">
                <div className="flex items-start justify-between gap-2"><div><p className="font-semibold text-ink">{customer.name}</p><p className="text-xs text-muted">{customer.code} · {customer.city}</p></div><Button size="xs" variant="ghost" onClick={() => setInput({ ...emptyOrderInput(user), deliverySlotId: '' })}>Change</Button></div>
                <Badge tone={customer.status === 'Active' ? 'success' : 'danger'}>{customer.status}</Badge>{customer.creditHold && <Badge tone="danger" className="ml-1">Credit hold</Badge>}
                {eff && <p className="text-xs text-muted">Salesman: <b className="text-ink">{personName(input.salesmanId)}</b>{eff.role !== 'primary' && <span className="block text-warning">{eff.reason}</span>}</p>}
                {err('customerId') && <p className="text-xs text-danger">{err('customerId')}</p>}
                {lastOrder && <Button size="xs" variant="secondary" icon={Copy} onClick={() => lastOrder.items.forEach((it) => addLine(P[it.productId], it.entryQuantity ?? it.orderedQuantity, it.entryUnit || it.unit))}>Add last order ({lastOrder.orderNumber})</Button>}
              </div>
            ) : (
              <div className="relative">
                <Input label="Search customer" value={custQ} onChange={(e) => setCustQ(e.target.value)} placeholder="Name, code, mobile, city" autoFocus icon={Search} />
                {custMatches.length > 0 && <ul className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl border border-line bg-surface shadow-pop">{custMatches.map((c) => <li key={c.id}><button type="button" onClick={() => pickCustomer(c)} className="flex w-full justify-between px-3 py-2 text-left text-sm hover:bg-surface-2"><span>{c.name}</span><span className="text-xs text-muted">{c.code}</span></button></li>)}</ul>}
              </div>
            )}
          </Card>
          <Card>
            <CardHeader title="Delivery" icon={PackageCheck} />
            <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-1">
              <Select label="Fulfilment hub" value={input.hubId} onChange={(e) => setInput({ ...input, hubId: e.target.value })} options={hubs.filter((h) => h.status === 'Active').map((h) => ({ value: h.id, label: h.name }))} error={err('hubId')} />
              <Input label="Delivery date" type="date" value={input.requestedDeliveryDate} min={dayjs().format('YYYY-MM-DD')} onChange={(e) => setInput({ ...input, requestedDeliveryDate: e.target.value })} error={err('requestedDeliveryDate')} />
              <div className="sm:col-span-2 2xl:col-span-1"><span className="text-label">Slot</span><div className="mt-1 grid grid-cols-2 gap-1 sm:grid-cols-4 2xl:grid-cols-2">{slots.map((sl) => <button key={sl.id} type="button" onClick={() => setInput({ ...input, deliverySlotId: sl.id, requestedDeliveryTime: sl.from })} className={cn('rounded-lg border px-2 py-1.5 text-left text-xs', input.deliverySlotId === sl.id ? 'border-brand bg-brand/10 text-brand' : 'border-line')}><b>{sl.label}</b><span className="block text-muted">{sl.from}–{sl.to}</span></button>)}</div>{err('deliverySlotId') && <p className="mt-1 text-xs text-danger">{err('deliverySlotId')}</p>}</div>
              <Select label="Payment terms" value={input.paymentTerms} onChange={(e) => setInput({ ...input, paymentTerms: e.target.value })} options={['Credit', 'Cash on Delivery', 'Advance Payment'].map((x) => ({ value: x, label: x }))} error={err('paymentTerms')} />
              <Textarea label="Delivery address" value={input.deliveryAddress} onChange={(e) => setInput({ ...input, deliveryAddress: e.target.value })} rows={2} error={err('deliveryAddress')} className="sm:col-span-2 2xl:col-span-1" />
              <Input label="Customer reference" value={input.customerReference} onChange={(e) => setInput({ ...input, customerReference: e.target.value })} />
            </div>
          </Card>
        </div>
        {/* Product finder */}
        <Card className="min-w-0">
          <div className="flex flex-wrap items-end gap-2">
            <Input ref={searchRef} label="Find products" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, SKU, code or barcode (press /)" icon={Search} className="min-w-[220px] flex-1"
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); const exact = findByBarcode(q); addLine(exact || list[0]); if (exact || list[0]) setQ('') } }} />
            <Select aria-label="Category" value={cat} onChange={(e) => setCat(e.target.value)} options={PRODUCT_CATEGORIES.map((c) => ({ value: c, label: c }))} placeholder="All categories" className="w-44" />
            <ScanButton onDetected={onScan} />
          </div>
          <div className="mt-3 flex gap-1 overflow-x-auto scroll-thin" role="tablist">{TABS.map(([id, label, Icon]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} disabled={id === 'customer' && !customer} className={cn('flex items-center gap-1 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs font-medium', tab === id ? 'bg-brand text-white' : 'bg-surface-2 text-ink-2 hover:bg-surface-3 disabled:opacity-40')}><Icon size={13} />{label}</button>)}</div>
          <ul className="mt-3 grid gap-2 md:grid-cols-2">
            {list.map((p) => {
              const stock = input.hubId && p.trackInventory ? getHubStockLevel(p.id, input.hubId, inventory) : null
              const inCart = input.items.some((l) => l.productId === p.id)
              const fav = prefs.favouriteProducts.includes(p.id)
              return (
                <li key={p.id} className={cn('flex gap-2 rounded-xl border p-2', inCart ? 'border-brand/50 bg-brand/5' : 'border-line')}>
                  <ProductThumb product={p} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink" title={p.name}>{p.name}</p>
                    <p className="truncate text-[11px] text-muted">{p.sku} · {p.packSize || p.unit}</p>
                    <p className="text-xs"><b>{formatMoney(p.sellingPrice)}</b><span className="text-muted">/{p.unit}</span>{stock && <span className={cn('ml-2', stock.available <= 0 ? 'text-danger' : stock.low ? 'text-warning' : 'text-success')}>{stock.available} avail.</span>}</p>
                    {customerHistory[p.id] && <p className="text-[11px] text-muted">Last: {customerHistory[p.id].lastQty} {customerHistory[p.id].lastUnit}</p>}
                  </div>
                  <div className="flex flex-col items-end justify-between">
                    <button type="button" aria-label={fav ? 'Remove favourite' : 'Add favourite'} onClick={() => toggleFavourite('product', p.id)} className={fav ? 'text-accent' : 'text-muted hover:text-ink'}><Star size={15} fill={fav ? 'currentColor' : 'none'} /></button>
                    <Button size="xs" icon={Plus} onClick={() => addLine(p)} aria-label={`Add ${p.name}`}>Add</Button>
                  </div>
                </li>
              )
            })}
          </ul>
          {!list.length && <p className="py-8 text-center text-sm text-muted">No products match.</p>}
        </Card>
        {/* Cart */}
        <Card className="lg:sticky lg:top-20 lg:self-start">
          <CardHeader title={`Cart (${input.items.length})`} icon={ShoppingCart} />
          <ul className="space-y-2">
            {priced.items.map((it, i) => {
              const l = input.items[i]
              const p = P[l.productId]
              const units = productUnits(p)
              return (
                <li key={l.key} className="rounded-xl border border-line p-2">
                  <div className="flex items-start justify-between gap-2"><span className="text-sm font-medium leading-tight">{it.productName}</span><button type="button" aria-label="Remove" onClick={() => removeLine(l.key)} className="text-muted hover:text-danger"><Trash2 size={14} /></button></div>
                  <div className="mt-1 flex items-center gap-1">
                    <button type="button" aria-label="Decrease" className="grid h-8 w-8 place-items-center rounded-lg border border-line" onClick={() => setLine(l.key, { entryQuantity: String(Math.max(0, (Number(l.entryQuantity) || 0) - 1)) })}><Minus size={13} /></button>
                    <input aria-label={`Quantity of ${it.productName}`} type="number" min="0" step="any" value={l.entryQuantity} onChange={(e) => setLine(l.key, { entryQuantity: e.target.value })} className="h-8 w-16 rounded-lg border border-line bg-surface px-2 text-sm tabular" />
                    <button type="button" aria-label="Increase" className="grid h-8 w-8 place-items-center rounded-lg border border-line" onClick={() => setLine(l.key, { entryQuantity: String((Number(l.entryQuantity) || 0) + 1) })}><Plus size={13} /></button>
                    <select aria-label="Unit" value={l.entryUnit} onChange={(e) => setLine(l.key, { entryUnit: e.target.value })} className="h-8 rounded-lg border border-line bg-surface-2 px-1 text-xs">{units.map((u) => <option key={u.code} value={u.code}>{u.code}</option>)}</select>
                    <span className="ml-auto text-sm font-semibold tabular">{formatMoney(it.totalAmount)}</span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted tabular">= {it.orderedQuantity} {it.unit}{it.stockAvailable !== null && <span className={it.stockShort ? 'ml-2 text-danger' : 'ml-2'}>· {it.stockAvailable} available</span>}</p>
                  {lineErr(l, 'orderedQuantity') && <p className="text-[11px] text-danger">{lineErr(l, 'orderedQuantity')}</p>}
                  {lineErr(l, 'productId') && <p className="text-[11px] text-danger">{lineErr(l, 'productId')}</p>}
                </li>
              )
            })}
          </ul>
          {!input.items.length && <p className="py-6 text-center text-sm text-muted">Add products from the list, scan a barcode or press Enter in the search.</p>}
          <dl className="mt-3 space-y-1 border-t border-line pt-3 text-sm">
            <div className="flex justify-between"><dt className="text-muted">Subtotal</dt><dd className="tabular">{formatMoney(priced.totals.subtotal)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Discount</dt><dd className="tabular">−{formatMoney(priced.totals.discountAmount || 0)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Tax</dt><dd className="tabular">{formatMoney(priced.totals.taxAmount)}</dd></div>
            <div className="flex justify-between text-base font-semibold"><dt>Total</dt><dd className="tabular">{formatMoney(priced.totals.totalAmount)}</dd></div>
          </dl>
          {credit && input.paymentTerms === 'Credit' && <p className={cn('mt-2 flex items-center gap-1 text-xs', priced.creditWarning ? 'text-danger' : 'text-muted')}><CreditCard size={13} />Credit after order {formatMoney(credit.projectedBalance)} of {formatMoney(credit.limit || customer.creditLimit)}{priced.creditWarning && ' — over the limit (approval will flag it)'}</p>}
          {priced.stockWarning && <p className="mt-1 flex items-center gap-1 text-xs text-warning"><AlertTriangle size={13} />Some lines exceed available stock.</p>}
          {err('duplicate') && <div className="mt-2 rounded-lg border border-warning/40 bg-warning/10 p-2 text-xs"><p>{err('duplicate')}</p><Checkbox className="mt-1" label="Yes, place another order" checked={Boolean(input.confirmDuplicate)} onChange={(e) => setInput({ ...input, confirmDuplicate: e.target.checked })} /></div>}
          {err('items') && <p className="mt-1 text-xs text-danger">{err('items')}</p>}
          <div className="mt-3 grid grid-cols-2 gap-2"><Button variant="secondary" icon={Save} onClick={() => save(false)} disabled={!input.customerId}>Draft</Button><Button icon={Send} onClick={() => save(true)} disabled={!input.customerId || !input.items.length}>Submit</Button></div>
        </Card>
      </div>
    </>
  )
}
