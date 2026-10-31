import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight, Plus, ScanLine } from 'lucide-react'
import { Card, EmptyState, Loading, PageTitle, Status, Button } from '../components/ui'
import { useAuth } from '../lib/auth'
import { displayDate, explainError, financialYear, friendlyError, money, today } from '../lib/format'
import { db, queryWithRetry } from '../lib/db'
import type { Bill } from '../lib/types'

type Summary = { total_customers: number; total_bills: number; total_sales: number; current_fy_sales: number; pending_amount: number; bills_this_month: number }

/**
 * Stands in for a figure that could not be read.
 *
 * Rendering ₹0 for a failed query is the worst option available: it is
 * indistinguishable from a genuine zero, so the number looks trustworthy and
 * gets acted on. Saying "unavailable" keeps the gap honest.
 */
function Unavailable() {
  return <span className="stat-unavailable" title="This figure could not be loaded">Unavailable</span>
}
export function Dashboard() {
  const { organization } = useAuth()
  const [summary, setSummary] = useState<Summary | null>(null)
  const [recent, setRecent] = useState<Bill[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [summaryFailed, setSummaryFailed] = useState(false)
  const [recentFailed, setRecentFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!organization) return
    let active = true
    setLoading(true)
    // Settled rather than all: the totals and the recent-bills list are read
    // separately, and one of them failing used to throw the other's result away
    // and leave the whole page reporting that no data was available.
    void Promise.allSettled([
      queryWithRetry(() => db.rpc('dashboard_summary', { org_id: organization.id })),
      queryWithRetry(() => db.from('bills').select('*').eq('organization_id', organization.id).is('deleted_at', null).order('created_at', { ascending: false }).limit(6)),
    ]).then(([s, b]) => {
      if (!active) return
      // Track each half separately. Reporting ₹0 because a read failed is worse
      // than showing nothing: the user has no way to tell a real zero from a
      // broken connection, and may act on the number.
      const messages: string[] = []
      let summaryFailed = false
      if (s.status === 'fulfilled') {
        if (s.value.error) { messages.push(friendlyError(s.value.error)); summaryFailed = true }
        else setSummary(s.value.data as Summary | null)
      } else { messages.push(explainError(s.reason, 'The dashboard totals could not be loaded.')); summaryFailed = true }
      let recentFailed = false
      if (b.status === 'fulfilled') {
        if (b.value.error) { messages.push(friendlyError(b.value.error)); recentFailed = true }
        else setRecent((b.value.data ?? []) as Bill[])
      } else { messages.push(explainError(b.reason, 'Recent bills could not be loaded.')); recentFailed = true }
      setSummaryFailed(summaryFailed)
      setRecentFailed(recentFailed)
      setError(messages.join(' '))
      setLoading(false)
    })
    return () => { active = false }
  }, [organization, attempt])
  if (loading) return <Loading label="Loading dashboard..." />
  return <><PageTitle eyebrow={`WORKSPACE / ${financialYear(today())}`} title="Good to see you." description={`Your business records at a glance${organization?.name ? ` · ${organization.name}` : ''}.`} action={organization?.role !== 'viewer' && <div className="inline-actions"><Link to="/scan" className="button button-secondary"><ScanLine size={16} /> Scan bill</Link><Link to="/bills/new" className="button button-primary"><Plus size={16} /> New bill</Link></div>} />{error && <div role="alert" className="error-box">{error}<Button variant="secondary" onClick={() => setAttempt(n => n + 1)}>Retry</Button></div>}<div className="stat-grid dashboard-stats"><Card className="stat"><span>Total customers</span><strong>{summaryFailed ? <Unavailable /> : summary?.total_customers ?? 0}</strong><Link to="/customers">Browse customers <ArrowUpRight size={14} /></Link></Card><Card className="stat"><span>Total bills</span><strong>{summaryFailed ? <Unavailable /> : summary?.total_bills ?? 0}</strong><Link to="/bills">View all bills <ArrowUpRight size={14} /></Link></Card><Card className="stat"><span>Total sales</span><strong>{summaryFailed ? <Unavailable /> : money(summary?.total_sales)}</strong><small>All financial years</small></Card><Card className="stat"><span>Current FY sales</span><strong>{summaryFailed ? <Unavailable /> : money(summary?.current_fy_sales)}</strong><small>{financialYear(today())}</small></Card><Card className="stat"><span>Pending amount</span><strong>{summaryFailed ? <Unavailable /> : money(summary?.pending_amount)}</strong><small>Unpaid & partial bills</small></Card><Card className="stat"><span>Bills this month</span><strong>{summaryFailed ? <Unavailable /> : summary?.bills_this_month ?? 0}</strong><small>By bill date</small></Card></div><div className="section-header top-gap"><h2>Recent bills</h2><Link to="/bills" className="text-link">View all →</Link></div><Card>{recentFailed ? <EmptyState title="Recent bills could not be loaded" description="The connection failed. Use Retry above, or open the bill list." action="Open bills" href="/bills" /> : recent.length ? <div className="table-scroll"><table><thead><tr><th>Bill no.</th><th>Customer</th><th>Date</th><th>Payment</th><th>Total</th></tr></thead><tbody>{recent.map(b => <tr key={b.id}><td><Link className="table-primary" to={`/bills/${b.id}`}>{b.bill_number}</Link></td><td><Link to={`/customers/${b.customer_id}`}>{b.customer_name}</Link></td><td>{displayDate(b.bill_date)}</td><td><Status value={b.payment_status} /></td><td className="amount">{money(b.grand_total)}</td></tr>)}</tbody></table></div> : <EmptyState title="No bills yet" description="Digitize your first physical bill or enter one manually." action={organization?.role !== 'viewer' ? 'Create your first bill' : undefined} href="/bills/new" />}</Card></>
}
