import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { z } from 'zod'
import { Plus } from 'lucide-react'
import { Button, Card, EmptyState, Field, Loading, PageTitle, Pagination, TextArea } from '../components/ui'
import { useAuth } from '../lib/auth'
import { friendlyError, money } from '../lib/format'
import { db } from '../lib/db'
import { settle } from '../lib/async'
import type { Product } from '../lib/types'

const schema = z.object({ name: z.string().trim().min(1).max(200), product_code: z.string().max(64), hsn_code: z.union([z.literal(''), z.string().regex(/^\d{2,8}$/)]), unit: z.string().trim().min(1).max(32), default_rate: z.coerce.number().min(0), gst_rate: z.coerce.number().min(0).max(100), description: z.string().max(500) })
type Values = z.infer<typeof schema>
const defaults: Values = { name: '', product_code: '', hsn_code: '', unit: 'NOS', default_rate: 0, gst_rate: 18, description: '' }

export function Products() {
  const { organization } = useAuth()
  const [rows, setRows] = useState<Product[]>([])
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => { setPage(1) }, [search])
  useEffect(() => {
    if (!organization) return
    let active = true
    const timer = window.setTimeout(() => {
      const base = db.from('products').select('*', { count: 'exact' }).eq('organization_id', organization.id).is('deleted_at', null)
      const filtered = search ? base.ilike('name', `%${search.trim().replace(/[\\%_]/g, '\\$&')}%`) : base
      void settle(() => filtered.order('name').range((page - 1) * 20, page * 20 - 1)).then(result => {
          if (!active) return
          // A rejected request used to be indistinguishable from "no products",
          // so a network failure showed "No products found" - a confident
          // statement that was false.
          if (!result.ok) { setError(friendlyError(result.error)); setLoading(false); return }
          if (result.value.error) { setError(friendlyError(result.value.error)); setLoading(false); return }
          setError('')
          setRows((result.value.data ?? []) as Product[])
          setCount(result.value.count ?? 0)
          setLoading(false)
        })
    }, search ? 250 : 0)
    return () => { active = false; window.clearTimeout(timer) }
  }, [organization, search, page])
  return <><PageTitle eyebrow="CATALOG" title="Products" description="Reusable product defaults; historical bill items keep their original values." action={organization?.role !== 'viewer' && <Link className="button button-primary" to="/products/new"><Plus size={17} /> Add product</Link>} /><Card><div className="table-toolbar"><input aria-label="Search products" placeholder="Search products..." value={search} onChange={e => setSearch(e.target.value)} /></div>{error && <p role="alert" className="error-box table-error">{error}</p>}{loading ? <Loading label="Loading products..." /> : rows.length ? <><div className="table-scroll"><table><thead><tr><th>Product</th><th>Code</th><th>HSN</th><th>Unit</th><th>Default rate</th><th>GST</th></tr></thead><tbody>{rows.map(p => <tr key={p.id}><td><Link className="table-primary" to={`/products/${p.id}`}>{p.name}</Link></td><td>{p.product_code || '—'}</td><td>{p.hsn_code || '—'}</td><td>{p.unit}</td><td>{money(p.default_rate)}</td><td>{p.gst_rate}%</td></tr>)}</tbody></table></div><Pagination page={page} count={count} size={20} onChange={setPage} /></> : <EmptyState title="No products found" description="Create a reusable product or enter products directly on a bill." action="Add product" href="/products/new" />}</Card></>
}

export function ProductForm() {
  const { id } = useParams()
  const { organization } = useAuth()
  const navigate = useNavigate()
  const [values, setValues] = useState<Values>(defaults)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(Boolean(id))
  useEffect(() => { if (!id || !organization) return; const active = true; void settle(() => db.from('products').select('*').eq('id', id).eq('organization_id', organization.id).is('deleted_at', null).single()).then(result => { if (!active) return; if (!result.ok) { setError(friendlyError(result.error)); setLoading(false); return } if (result.value.error) { setError(friendlyError(result.value.error)); setLoading(false); return } const data = result.value.data; if (data) setValues({ name: data.name, product_code: data.product_code || '', hsn_code: data.hsn_code || '', unit: data.unit, default_rate: Number(data.default_rate), gst_rate: Number(data.gst_rate), description: data.description || '' }); else setError('This product no longer exists.'); setLoading(false) }) }, [id, organization])
  if (loading) return <Loading />
  if (organization?.role === 'viewer') return <EmptyState title="Read-only access" description="You cannot edit products with this role." />
  function update(key: keyof Values, value: string | number) { setValues(old => ({ ...old, [key]: value })) }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (!organization || busy) return
    const parsed = schema.safeParse(values)
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check your inputs.'); return }
    setBusy(true); setError('')
    const record = { ...parsed.data, name: parsed.data.name.trim(), unit: parsed.data.unit.trim(), product_code: parsed.data.product_code || null, hsn_code: parsed.data.hsn_code || null, description: parsed.data.description || null }
    try {
      const result = id ? await db.from('products').update(record).eq('id', id).eq('organization_id', organization.id).select('id').single() : await db.from('products').insert({ ...record, organization_id: organization.id }).select('id').single()
      if (result.error) setError(friendlyError(result.error))
      else navigate(`/products/${result.data.id}`)
    } catch (cause) {
      // Without a catch, a thrown request left the Save button disabled forever.
      setError(friendlyError(cause))
    } finally {
      setBusy(false)
    }
  }
  return <><PageTitle eyebrow="CATALOG" title={id ? 'Edit product' : 'New product'} description="Defaults speed up bill entry without changing old bills." /><Card className="form-card"><form onSubmit={submit}><div className="form-grid"><Field label="Product name" required value={values.name} onChange={e => update('name', e.target.value)} /><Field label="Product code" value={values.product_code} onChange={e => update('product_code', e.target.value)} /><Field label="HSN code" value={values.hsn_code} onChange={e => update('hsn_code', e.target.value)} /><Field label="Unit" required value={values.unit} onChange={e => update('unit', e.target.value)} /><Field label="Default rate (₹)" type="number" min="0" step="0.0001" value={values.default_rate} onChange={e => update('default_rate', e.target.value)} /><Field label="GST rate (%)" type="number" min="0" max="100" step="0.01" value={values.gst_rate} onChange={e => update('gst_rate', e.target.value)} /><div className="full-width"><TextArea label="Description" value={values.description} onChange={e => update('description', e.target.value)} /></div></div>{error && <p role="alert" className="error-box">{error}</p>}<div className="form-actions"><Button type="button" variant="secondary" onClick={() => navigate('/products')}>Cancel</Button><Button disabled={busy}>{busy ? 'Saving...' : 'Save product'}</Button></div></form></Card></>
}

export function ProductDetail() {
  const { id } = useParams()
  const { organization } = useAuth()
  const [product, setProduct] = useState<Product | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => { if (!id || !organization) return; const active = true; setLoading(true); void settle(() => db.from('products').select('*').eq('id', id).eq('organization_id', organization.id).is('deleted_at', null).single()).then(result => { if (!active) return; if (!result.ok) { setError(friendlyError(result.error)); setLoading(false); return } if (result.value.error) { setError(friendlyError(result.value.error)); setLoading(false); return } setProduct(result.value.data as Product | null); setLoading(false) }) }, [id, organization])
  if (loading) return <Loading />
  if (!product) return <>
    {error && <p role="alert" className="error-box">{error}</p>}
    <EmptyState title={error ? 'This product could not be loaded' : 'Product not found'} description={error || 'This product does not exist or is not accessible.'} action="Back to products" href="/products" />
  </>
  return <><PageTitle eyebrow="PRODUCT" title={product.name} action={organization?.role !== 'viewer' && <Link className="button button-secondary" to={`/products/${id}/edit`}>Edit product</Link>} /><Card className="detail-card"><dl className="detail-list"><dt>Code</dt><dd>{product.product_code || '—'}</dd><dt>HSN</dt><dd>{product.hsn_code || '—'}</dd><dt>Unit</dt><dd>{product.unit}</dd><dt>Default rate</dt><dd>{money(product.default_rate)}</dd><dt>Default GST</dt><dd>{product.gst_rate}%</dd><dt>Description</dt><dd>{product.description || '—'}</dd></dl></Card></>
}
