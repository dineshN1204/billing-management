import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Search, X } from 'lucide-react'
import { db } from '../lib/db'
import { displayDate, money, normalizeGstin } from '../lib/format'
import { useAuth } from '../lib/auth'
import { DC_TYPE_LABEL } from '../lib/dc-types'
import { dcApi } from '../lib/dc-api'
import { challanPath } from '../lib/navigation'
import { firstSearchTarget, rankDcs, type DcHit } from '../lib/global-search'
import type { Bill, Customer, Product } from '../lib/types'

export function GlobalSearch() {
  const { organization } = useAuth()
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [customers, setCustomers] = useState<Customer[]>([])
  const [bills, setBills] = useState<Bill[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [dcs, setDcs] = useState<DcHit[]>([])
  const ref = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  useEffect(() => {
    function close(event: MouseEvent) { if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  useEffect(() => {
    const q = query.trim()
    if (!organization || q.length < 2) { setCustomers([]); setBills([]); setProducts([]); setDcs([]); setLoading(false); return }
    let active = true
    const timer = window.setTimeout(async () => {
      setLoading(true)
      const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`
      const gst = normalizeGstin(q)
      // Read every match into a plain array. A failed lookup contributes nothing
      // rather than rejecting the whole batch - and because `list` never throws,
      // the lines below always run, so the spinner always clears.
      const list = async <T,>(run: () => PromiseLike<{ data?: T[] | null; error?: unknown }>): Promise<T[]> => {
        try {
          const response = await run()
          return response.error ? [] : (response.data ?? [])
        } catch {
          return []
        }
      }
      const [byName, byGstin, byPhone, billsFound, billsByChallan, productsFound, dcsFound] = await Promise.all([
        list<Customer>(() => db.from('customers').select('*').eq('organization_id', organization.id).is('deleted_at', null).ilike('name', like).limit(6)),
        list<Customer>(() => gst.length >= 4 ? db.from('customers').select('*').eq('organization_id', organization.id).is('deleted_at', null).ilike('gstin', `${gst}%`).limit(6) : Promise.resolve({ data: [] })),
        list<Customer>(() => /^\d{4,}$/.test(q) ? db.from('customers').select('*').eq('organization_id', organization.id).is('deleted_at', null).ilike('phone', `%${q}%`).limit(6) : Promise.resolve({ data: [] })),
        list<Bill>(() => db.from('bills').select('*').eq('organization_id', organization.id).is('deleted_at', null).ilike('bill_number', like).order('bill_date', { ascending: false }).limit(6)),
        // The bills whose challan carries the term.
        //
        // A bill is named by its own number, but the number in the operator's
        // hand is usually the number on the challan - and the bill and the
        // challan it pays for are the same job, so the serial is the same.
        // Searching 0020 has to answer with the inward challan, the outward
        // challan and the bill.
        (async () => {
          try {
            const matches = await dcApi.billsForDcNumber(organization.id, q)
            if (!matches.length) return [] as Bill[]
            const { data, error } = await db.from('bills').select('*').eq('organization_id', organization.id).is('deleted_at', null).in('id', matches.map(match => match.bill_id)).limit(6)
            if (error) return [] as Bill[]
            return (data ?? []) as Bill[]
          } catch { return [] as Bill[] }
        })(),
        list<Product>(() => db.from('products').select('*').eq('organization_id', organization.id).is('deleted_at', null).ilike('name', like).limit(6)),
        // dc_search rather than a direct read of dc_documents. The direct read
        // only ever saw OUR number, so the customer's own challan number - the
        // number printed on their paperwork and the one they quote on the
        // phone - found nothing at all. It also matches part and drawing
        // numbers, and the inward challan behind an outward one, which is what
        // makes one search answer "where is my material" in either module.
        //
        // It resolves to a plain array rather than the { data, error } shape the
        // others do, so it gets its own guard: a failed lookup contributes
        // nothing rather than rejecting the batch.
        (async () => { try { return await dcApi.search(organization.id, q, 6) } catch { return [] as DcHit[] } })(),
      ])
      if (!active) return
      // GSTIN and phone matches are listed first: they are the more specific hit.
      const merged = new Map<string, Customer>()
      for (const row of [...byGstin, ...byName, ...byPhone]) merged.set(row.id, row)
      setCustomers([...merged.values()].slice(0, 6))
      // A bill found by its own number and a bill found by the number of the
      // challan it pays for are the same bill, and it is listed once.
      const seen = new Set(billsFound.map(bill => bill.id))
      setBills([...billsFound, ...billsByChallan.filter(bill => !seen.has(bill.id))].slice(0, 6))
      setProducts(productsFound)
      setDcs(rankDcs(q, dcsFound))
      setLoading(false)
    }, 300)
    return () => { active = false; window.clearTimeout(timer) }
  }, [query, organization])

  function go(path: string) { setOpen(false); setQuery(''); navigate(path) }
  const hasResults = customers.length + bills.length + products.length + dcs.length > 0
  return <div className="global-search" ref={ref}>
    <Search size={18} aria-hidden="true" />
    <input aria-label="Search challans, customers, bills and products" placeholder="Search customer DC, our DC, part, GST number, company, bill number, phone or product..." value={query} onFocus={() => setOpen(true)} onChange={event => { setQuery(event.target.value); setOpen(true) }} onKeyDown={event => { if (event.key === 'Escape') setOpen(false); if (event.key === 'Enter') { const target = firstSearchTarget(query, { dcs, customers, bills, products }); if (target) go(target) } }} />
    {query && <button className="icon-button" aria-label="Clear search" onClick={() => setQuery('')}><X size={16} /></button>}
    {open && query.trim().length >= 2 && <div className="search-results" role="region" aria-label="Search results">
      {loading ? <div className="search-hint">Searching...</div> : !hasResults ? <div className="search-hint">No matches found</div> : <>
        {dcs.length > 0 && <section><h3>Delivery Challans</h3>{dcs.map(d => <Link onClick={() => { setOpen(false); setQuery('') }} to={challanPath(d.id, d.dc_type)} key={d.id}><strong>{d.dc_number} · {d.party_name}</strong><small>{DC_TYPE_LABEL[d.dc_type]} · {displayDate(d.dc_date)} · {d.status.replaceAll('_', ' ')}{d.matched_on ? ` · matched ${d.matched_on}` : ''}</small></Link>)}</section>}
        {customers.length > 0 && <section><h3>Customers</h3>{customers.map(c => <Link onClick={() => { setOpen(false); setQuery('') }} to={`/customers/${c.id}`} key={c.id}><strong>{c.name}</strong><small>{c.gstin || c.phone || 'No GSTIN'}</small></Link>)}</section>}
        {bills.length > 0 && <section><h3>Bills</h3>{bills.map(b => <Link onClick={() => { setOpen(false); setQuery('') }} to={`/bills/${b.id}`} key={b.id}><strong>{b.bill_number} · {b.customer_name}</strong><small>{displayDate(b.bill_date)} · {money(b.grand_total)}</small></Link>)}</section>}
        {products.length > 0 && <section><h3>Products</h3>{products.map(p => <Link onClick={() => { setOpen(false); setQuery('') }} to={`/products/${p.id}`} key={p.id}><strong>{p.name}</strong><small>{p.product_code || p.hsn_code || 'Product'}</small></Link>)}</section>}
      </>}
    </div>}
  </div>
}
