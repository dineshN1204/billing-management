import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Plus } from 'lucide-react'
import { CustomerForm } from '../components/CustomerForm'
import { Button, Card, EmptyState, Loading, PageTitle, Pagination, Status } from '../components/ui'
import { useAuth } from '../lib/auth'
import { displayDate, friendlyError, money, normalizeGstin } from '../lib/format'
import { db } from '../lib/db'
import { settleAll } from '../lib/async'
import type { Bill, Customer, PartyType } from '../lib/types'

const size = 20

/**
 * One party master serves Billing and the DC module; this filter is how you
 * narrow it. The route and the nav label stay "Customers" so nothing in Billing
 * has to move.
 */
const PARTY_FILTERS: Array<{ value: PartyType; label: string }> = [
  { value: 'customer', label: 'Customers' },
  { value: 'supplier', label: 'Suppliers' },
  { value: 'vendor', label: 'Vendors' },
  { value: 'other', label: 'Other parties' },
]

/** "Customers" -> "Customer", "Other parties" -> "Other party". */
const roleLabel = (value: string) => {
  const found = PARTY_FILTERS.find(f => f.value === value)?.label ?? 'Parties'
  return found.endsWith('ies') ? `${found.slice(0, -3)}y` : found.endsWith('s') ? found.slice(0, -1) : found
}

export function Customers() {
  const { organization } = useAuth()
  const [rows, setRows] = useState<Customer[]>([])
  const [search, setSearch] = useState('')
  const [role, setRole] = useState<PartyType>('customer')
  const [page, setPage] = useState(1)
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [sort, setSort] = useState<'name' | 'created_at'>('name')
  useEffect(() => { setPage(1) }, [search, sort, role])
  useEffect(() => {
    if (!organization) return
    let active = true
    const timer = window.setTimeout(async () => {
      setLoading(true)
      const q = search.trim()
      let request = db.from('customers').select('*', { count: 'exact' }).eq('organization_id', organization.id).is('deleted_at', null)
      if (role) request = request.eq('party_type', role)
      if (q) request = /\d{2}[a-z]{2,}/i.test(q) ? request.ilike('gstin', `${normalizeGstin(q)}%`) : request.ilike('name', `%${q.replace(/[\\%_]/g, '\\$&')}%`)
      const { data, count: total, error: queryError } = await request.order(sort, { ascending: sort === 'name' }).range((page - 1) * size, page * size - 1)
      if (!active) return
      setRows((data ?? []) as Customer[]); setCount(total ?? 0); setError(queryError ? friendlyError(queryError) : ''); setLoading(false)
    }, search ? 250 : 0)
    return () => { active = false; window.clearTimeout(timer) }
  }, [organization, page, search, sort, role])
  return <><PageTitle eyebrow="RELATIONSHIPS" title="Customers" description="Find a company and see its complete bill history." action={organization?.role !== 'viewer' && <Link className="button button-primary" to="/customers/new"><Plus size={17} /> Add customer</Link>} /><Card><div className="table-toolbar"><input aria-label="Search customers by name or GSTIN" placeholder="Search company name or GSTIN..." value={search} onChange={e => setSearch(e.target.value)} /><select aria-label="Party type" value={role} onChange={e => setRole(e.target.value as PartyType)}>{PARTY_FILTERS.map(filter => <option key={filter.value} value={filter.value}>{filter.label}</option>)}</select><label className="inline-control">Sort <select aria-label="Sort customers" value={sort} onChange={e => setSort(e.target.value as 'name' | 'created_at')}><option value="name">Company A–Z</option><option value="created_at">Newest first</option></select></label></div>{error && <p className="error-box" role="alert">{error}</p>}{loading ? <Loading label="Loading customers..." /> : rows.length === 0 ? <EmptyState title="No customers found" description="Add your first customer or try another search." action={organization?.role !== 'viewer' ? 'Add your first customer' : undefined} href="/customers/new" /> : <><div className="table-scroll"><table><thead><tr><th>Company</th><th>Type</th><th>GSTIN</th><th>Phone</th><th>City</th><th>Added</th><th>Actions</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}><td><Link className="table-primary" to={`/customers/${row.id}`}>{row.name}</Link></td><td><span className={`status ${row.party_type === 'customer' ? 'status-neutral' : 'status-warning'}`}>{roleLabel(row.party_type)}</span></td><td className="mono">{row.gstin || <span className="muted">Needs verification</span>}</td><td>{row.phone || '—'}</td><td>{row.city || '—'}</td><td>{displayDate(row.created_at)}</td><td><Link to={`/customers/${row.id}`} className="text-link">View profile →</Link></td></tr>)}</tbody></table></div><Pagination page={page} count={count} size={size} onChange={setPage} /></>}</Card></>
}

type Summary = { bill_count: number; total_purchase: number; total_gst: number; average_bill: number; last_bill: string | null }
type ProductHistory = { product_name: string; quantity: number; total_amount: number; last_purchased: string }
export function CustomerDetail() {
  const { id } = useParams()
  const { organization } = useAuth()
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [bills, setBills] = useState<Bill[]>([])
  const [products, setProducts] = useState<ProductHistory[]>([])
  const [tab, setTab] = useState<'bills' | 'products' | 'payments' | 'documents' | 'activity'>('bills')
  const [page, setPage] = useState(1)
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [edit, setEdit] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!id || !organization) return
    let active = true
    setLoading(true)
    void settleAll([
      () => db.from('customers').select('*').eq('id', id).eq('organization_id', organization.id).is('deleted_at', null).single(),
      () => db.rpc('customer_summary', { target_customer_id: id }),
      () => db.rpc('customer_products', { target_customer_id: id }),
      () => db.from('bills').select('*', { count: 'exact' }).eq('organization_id', organization.id).eq('customer_id', id).is('deleted_at', null).order('bill_date', { ascending: false }).range((page - 1) * size, page * size - 1),
    ]).then(([c, s, p, b]) => {
      if (!active) return
      const cq = c.ok ? c.value : null
      setCustomer((cq?.data ?? null) as Customer | null)
      setSummary((s.ok ? s.value.data : null) as Summary | null)
      setProducts((p.ok ? p.value.data ?? [] : []) as ProductHistory[])
      const bq = b.ok ? b.value : null
      setBills((bq?.data ?? []) as Bill[])
      setCount(bq?.count ?? 0)
      // Report the first genuine failure. The previous expression silently dropped
      // the products error and, when both summary and bills failed, only ever
      // surfaced the summary - so a broken bills query was invisible.
      const failure = !c.ok ? c.error
        : cq?.error
        ?? (!s.ok ? s.error : s.value.error)
        ?? (!b.ok ? b.error : bq?.error)
        ?? null
      setError(failure ? friendlyError(failure) : '')
      setLoading(false)
    })
    return () => { active = false }
  }, [id, organization, page])
  async function verify() {
    if (!customer || verifying) return
    setVerifying(true)
    try {
      const { data, error: verifyError } = await db.rpc('set_customer_verification', { target_customer_id: customer.id, new_status: 'verified' })
      if (verifyError) setError(friendlyError(verifyError))
      else setCustomer(data as Customer)
    } catch (cause) {
      // Without this the button stayed disabled forever if the request threw.
      setError(friendlyError(cause))
    } finally {
      setVerifying(false)
    }
  }
  if (loading) return <Loading label="Loading customer profile..." />
  if (!customer) return <>
    {error && <p role="alert" className="error-box">{error}</p>}
    <EmptyState title={error ? 'This customer could not be loaded' : 'Customer not found'} description={error || 'The customer is missing or you do not have access.'} action="Back to customers" href="/customers" />
  </>
  return <><Link className="back-link" to="/customers"><ArrowLeft size={16} /> All customers</Link><PageTitle eyebrow="CUSTOMER PROFILE" title={customer.name} description={[customer.gstin || 'GSTIN needs verification', [customer.city, customer.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')} action={<div className="inline-actions">{organization?.role !== 'viewer' && customer.verification_status !== 'verified' && <Button variant="secondary" disabled={verifying} onClick={() => void verify()}>{verifying ? 'Verifying...' : 'Mark verified'}</Button>}{organization?.role !== 'viewer' && <Button variant="secondary" onClick={() => setEdit(true)}>Edit customer</Button>}{customer.party_type === 'customer' && <Link className="button button-secondary" to={`/dc/ledger?customer=${customer.id}`}>Material ledger</Link>}{(customer.party_type === 'vendor' || customer.party_type === 'supplier') && <Link className="button button-secondary" to="/dc/pending">Material at vendor</Link>}<Link className="button button-primary" to={`/bills/new?customer=${customer.id}`}>New bill</Link></div>} />{error && <p role="alert" className="error-box">{error}</p>}
    <div className="stat-grid"><Card className="stat"><span>Total bills</span><strong>{summary?.bill_count ?? 0}</strong></Card><Card className="stat"><span>Total purchase</span><strong>{money(summary?.total_purchase)}</strong></Card><Card className="stat"><span>Total GST</span><strong>{money(summary?.total_gst)}</strong></Card><Card className="stat"><span>Average bill</span><strong>{money(summary?.average_bill)}</strong></Card></div>
    <div className="two-column top-gap"><Card className="detail-card"><h2>Contact details</h2><dl className="detail-list"><dt>Party type</dt><dd><span className={`status ${customer.party_type === 'customer' ? 'status-neutral' : 'status-warning'}`}>{roleLabel(customer.party_type)}</span></dd><dt>GSTIN</dt><dd className="mono">{customer.gstin || 'Needs verification'}</dd><dt>Phone</dt><dd>{customer.phone || '—'}</dd><dt>Email</dt><dd>{customer.email || '—'}</dd><dt>Address</dt><dd>{[customer.address_line_1, customer.address_line_2, customer.city, customer.state, customer.pincode].filter(Boolean).join(', ') || customer.address || '—'}</dd><dt>Verification</dt><dd><Status value={customer.verification_status} /></dd><dt>Notes</dt><dd>{customer.notes || '—'}</dd></dl><p className="muted dc-party-note">
        {customer.party_type === 'customer'
          ? 'Used in inward and outward customer challans, and as a material owner when stock is issued to a vendor.'
          : customer.party_type === 'vendor' || customer.party_type === 'supplier'
            ? 'Offered as a destination on outward self challans. Not offered as a customer delivery destination.'
            : 'Offered wherever a DC accepts any authorised party.'}
      </p></Card><Card className="detail-card"><h2>At a glance</h2><p className="muted">Last invoice</p><strong>{summary?.last_bill ? displayDate(summary.last_bill) : 'No bills yet'}</strong><p className="muted top-gap">Records remain tied to this customer even when their contact information changes.</p></Card></div>
    <Card className="top-gap"><div className="tabs" role="tablist"><button role="tab" aria-selected={tab === 'bills'} className={tab === 'bills' ? 'active' : ''} onClick={() => setTab('bills')}>Bill history</button><button role="tab" aria-selected={tab === 'products'} className={tab === 'products' ? 'active' : ''} onClick={() => setTab('products')}>Products purchased</button><button role="tab" aria-selected={tab === 'payments'} className={tab === 'payments' ? 'active' : ''} onClick={() => setTab('payments')}>Payments</button><button role="tab" aria-selected={tab === 'documents'} className={tab === 'documents' ? 'active' : ''} onClick={() => setTab('documents')}>Documents</button><button role="tab" aria-selected={tab === 'activity'} className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}>Activity</button></div>{tab === 'bills' ? bills.length === 0 ? <EmptyState title="No bills yet" description="Create a bill for this customer to begin their history." action="Create bill" href={`/bills/new?customer=${customer.id}`} /> : <><div className="table-scroll"><table><thead><tr><th>Bill no.</th><th>Date</th><th>Taxable</th><th>GST</th><th>Total</th><th>Payment</th></tr></thead><tbody>{bills.map(b => <tr key={b.id}><td><Link className="table-primary" to={`/bills/${b.id}`}>{b.bill_number}</Link></td><td>{displayDate(b.bill_date)}</td><td>{money(b.taxable_amount)}</td><td>{money(b.tax_total)}</td><td className="amount">{money(b.grand_total)}</td><td><Status value={b.payment_status} /></td></tr>)}</tbody></table></div><Pagination page={page} count={count} size={size} onChange={setPage} /></> : tab === 'products' ? products.length === 0 ? <EmptyState title="No products purchased" description="Product history appears when bills are saved." /> : <div className="table-scroll"><table><thead><tr><th>Product</th><th>Quantity</th><th>Total</th><th>Last purchased</th></tr></thead><tbody>{products.map(p => <tr key={p.product_name}><td className="table-primary">{p.product_name}</td><td>{p.quantity}</td><td>{money(p.total_amount)}</td><td>{displayDate(p.last_purchased)}</td></tr>)}</tbody></table></div> : tab === 'payments' ? <EmptyState title="Payments" description="Payment details are shown on individual bills." /> : tab === 'documents' ? <EmptyState title="Documents" description="Original bills attached to this customer appear on their bill pages." /> : <EmptyState title="Activity" description="Customer activity appears in the audit log for your workspace." />}</Card>{edit && <CustomerForm customer={customer} onClose={() => setEdit(false)} onSaved={value => { setCustomer(value); setEdit(false) }} />}</>
}
