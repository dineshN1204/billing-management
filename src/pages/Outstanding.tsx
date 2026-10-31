import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { db } from '../lib/db'
import { settle } from '../lib/async'
import { PageTitle, Card, Field, Loading, Pagination, EmptyState } from '../components/ui'
import { billRemaining } from '../lib/calculations'
import { displayDate, friendlyError, money, today } from '../lib/format'
import type { Bill } from '../lib/types'

const size = 20

export function Outstanding() {
  const { organization } = useAuth()
  const [rows, setRows] = useState<Bill[]>([])
  const [page, setPage] = useState(1)
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const year = new Date().getFullYear()
  const currentFyStart = new Date().getMonth() < 3 ? `${year - 1}-04-01` : `${year}-04-01`

  // Total across the page actually on screen. It is labelled "in view" because the
  // list is paginated - presenting a page subtotal as the company total would be
  // as misleading as showing nothing.
  //
  // What is summed is what is owed, not what was invoiced. A bill with most of
  // it received still showed its whole total here, which overstated the
  // receivables by everything the customers had already paid.
  const pageTotal = rows.reduce((sum, b) => sum + billRemaining(b), 0)

  useEffect(() => {
    if (!organization) return
    let active = true
    setLoading(true)
    let query = db
      .from('bills')
      .select('*', { count: 'exact' })
      .eq('organization_id', organization.id)
      .is('deleted_at', null)
      .in('payment_status', ['unpaid', 'partial'])
    if (from) query = query.gte('bill_date', from)
    if (to) query = query.lte('bill_date', to)
    query
      .order('bill_date', { ascending: false })
      .range((page - 1) * size, page * size - 1)
    void settle(() => query).then(result => {
        if (!active) return
        if (!result.ok) { setError(friendlyError(result.error)); setLoading(false); return }
        if (result.value.error) { setError(friendlyError(result.value.error)); setLoading(false); return }
        setRows((result.value.data ?? []) as Bill[])
        setCount(result.value.count ?? 0)
        setError('')
        setLoading(false)
      })
    return () => { active = false }
  }, [organization, page, from, to])

  return (
    <div className="outstanding-page">
      <PageTitle eyebrow="REPORTS" title="Outstanding bills" description="What the customers still owe, bill by bill" />
      <Card className="report-filter outstanding-filter">
        <Field label="From" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1) }} />
        <Field label="To" type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1) }} />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="button button-secondary" onClick={() => { setFrom(currentFyStart); setTo(today()); setPage(1) }}>Current FY</button>
          <button className="button button-secondary" onClick={() => { setFrom(''); setTo(''); setPage(1) }}>Clear filters</button>
        </div>
      </Card>
      <Card>
        {error && <p role="alert" className="error-box">{error}</p>}
        {loading ? <Loading label="Loading outstanding bills..." /> : rows.length === 0 ? (
          <EmptyState title="No outstanding bills" description="All invoices are settled for this period." />
        ) : (
          <>
            {/* The page is called "Outstanding" but showed no total. The figure a
                receivables screen exists to answer is the aggregate. */}
            <div className="outstanding-summary">
              <div><span>Bills in view</span><strong>{count}</strong></div>
              <div><span>Outstanding in view</span><strong>{money(pageTotal)}</strong></div>
              <div><span>Oldest bill</span><strong>{displayDate(rows[rows.length - 1]?.bill_date ?? '')}</strong></div>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Bill no.</th>
                    <th>Date</th>
                    <th>Customer</th>
                    <th>GSTIN</th>
                    <th>Total</th>
                    <th>Outstanding</th>
                    <th>Payment</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((b) => (
                    <tr key={b.id}>
                      <td><Link className="table-primary" to={`/bills/${b.id}`}>{b.bill_number}</Link></td>
                      <td>{displayDate(b.bill_date)}</td>
                      <td><Link to={`/customers/${b.customer_id}`}>{b.customer_name}</Link></td>
                      <td className="mono">{b.customer_gstin || '—'}</td>
                      <td className="amount">{money(b.grand_total)}</td>
                      <td className="amount">{money(billRemaining(b))}</td>
                      <td><span className="status status-warning">{b.payment_status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} count={count} size={size} onChange={setPage} />
          </>
        )}
      </Card>
    </div>
  )
}
