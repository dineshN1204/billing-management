import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight, Plus, Truck } from 'lucide-react'
import { Button, Card, EmptyState, Loading, PageTitle, Status } from '../components/ui'
import { useAuth } from '../lib/auth'
import { dcApi } from '../lib/dc-api'
import type { DcSummary } from '../lib/dc-types'
import { qty } from '../lib/dc-quantities'
import { challanPath } from '../lib/navigation'
import { describeError, displayDate } from '../lib/format'
import type { DcListRow } from '../lib/dc-api'

/**
 * The DC dashboard answers the questions a stores clerk actually asks at the
 * start of a shift: what came in, what is waiting to be inspected, what is still
 * sitting at a vendor, and what has been rejected but not yet returned.
 */
type Row = Record<string, string | number | null>

/** Keeps the reason a read failed, so the banner can say which one it was. */
function describe(cause: unknown): string {
  return describeError(cause, 'Dashboard data is unavailable.')
}

export function DcDashboard() {
  const { organization } = useAuth()
  const [summary, setSummary] = useState<DcSummary | null>(null)
  const [pending, setPending] = useState<Row[]>([])
  const [recent, setRecent] = useState<DcListRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!organization) return
    let active = true
    setLoading(true)
    void (async () => {
      // Settled rather than all, and one report per box rather than one report
      // for the page: the three reads below are independent, and a single one of
      // them failing used to throw the others away and blank the dashboard.
      const [summaryPart, pendingPart, recentPart] = await Promise.allSettled([
        dcApi.dashboard(organization.id),
        dcApi.pendingInspection(organization.id),
        dcApi.register(organization.id),
      ])
      if (!active) return
      const failures: string[] = []
      if (summaryPart.status === 'fulfilled') setSummary(summaryPart.value)
      else failures.push(describe(summaryPart.reason))
      if (pendingPart.status === 'fulfilled') setPending(pendingPart.value as Row[])
      else failures.push(describe(pendingPart.reason))

      if (recentPart.status === 'fulfilled') setRecent(recentPart.value.slice(0, 8))
      else failures.push(describe(recentPart.reason))
      setError(failures.join(' · '))
      setLoading(false)
    })()
    return () => { active = false }
  }, [organization, attempt])

  if (loading) return <Loading label="Loading DC dashboard..." />

  return (
    <>
      <PageTitle
        eyebrow="DELIVERY CHALLANS"
        title="Material movements"
        description={`Inward receipts, outward dispatches, inspections and pending material${organization?.name ? ` · ${organization.name}` : ''}.`}
        action={organization?.role !== 'viewer' && (
          <div className="inline-actions">
            <Link className="button button-secondary" to="/dc/inward/new"><Plus size={16} /> Inward</Link>
            <Link className="button button-primary" to="/dc/outward/new"><Truck size={16} /> Outward</Link>
          </div>
        )}
      />

      {error && (
        <div role="alert" className="error-box">
          {error}
          <Button variant="secondary" onClick={() => setAttempt(n => n + 1)}>Retry</Button>
        </div>
      )}

      <div className="stat-grid dashboard-stats">
        <Card className="stat">
          <span>Inward this month</span>
          <strong>{summary?.inward_this_month ?? 0}</strong>
          <Link to="/dc/inward">Open register <ArrowUpRight size={14} /></Link>
        </Card>
        <Card className="stat">
          <span>Pending inspection</span>
          <strong>{qty(summary?.pending_inspection_quantity ?? 0)}</strong>
          <small>{summary?.pending_inspection_lines ?? 0} line(s) awaiting inspection</small>
          <Link to="/dc/inspection">Inspect now <ArrowUpRight size={14} /></Link>
        </Card>
        <Card className="stat">
          <span>Open material rejections</span>
          <strong>{summary?.open_material_rejections ?? 0}</strong>
          <small>{qty(summary?.pending_return_quantity ?? 0)} still to be returned</small>
          <Link to="/dc/rejections">Review <ArrowUpRight size={14} /></Link>
        </Card>

        <Card className="stat">
          <span>Customer deliveries open</span>
          <strong>{summary?.outward_customer_open ?? 0}</strong>
          <Link to="/dc/outward">Open register <ArrowUpRight size={14} /></Link>
        </Card>
        <Card className="stat">
          <span>Machining rejection (month)</span>
          <strong>{qty(summary?.machining_rejections_this_month ?? 0)}</strong>
          <small>{summary?.machining_results_recorded ?? 0} result(s) recorded to date</small>
          <Link to="/dc/reports">Reports <ArrowUpRight size={14} /></Link>
        </Card>
      </div>

      <div className="top-gap">
        <Card>
          <div className="section-header">
            <h2>Waiting for inspection</h2>
            <Link className="text-link" to="/dc/inspection">See all →</Link>
          </div>
          {pending.length === 0 ? (
            <EmptyState title="Nothing pending" description="Every received line has been inspected." />
          ) : (
            <div className="table-scroll">
              <table>
                <thead><tr><th>DC</th><th>Part</th><th className="num">Received</th><th className="num">Pending</th></tr></thead>
                <tbody>
                  {pending.slice(0, 8).map(row => (
                    <tr key={String(row.dc_id) + String(row.part_number)}>
                      <td><Link className="table-primary" to={`/dc/inward/${row.dc_id}`}>{row.dc_number}</Link></td>
                      <td>{row.part_number}</td>
                      <td className="num">{qty(Number(row.received_qty))}</td>
                      <td className="num">{qty(Number(row.pending_inspection_qty))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>


      </div>

      <div className="section-header top-gap">
        <h2>Recent challans</h2>
        <Link className="text-link" to="/dc/all">View all →</Link>
      </div>
      <Card>
        {recent.length === 0 ? (
          <EmptyState
            title="No challans yet"
            description="Start by recording an inward delivery challan for material received today."
            action={organization?.role !== 'viewer' ? 'Create inward DC' : undefined}
            href="/dc/inward/new"
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead><tr><th>DC number</th><th>Type</th><th>Date</th><th>Party</th><th className="num">Quantity</th><th>Status</th></tr></thead>
              <tbody>
                {recent.map(row => (
                  <tr key={row.id}>
                    <td>
                      <Link
                        className="table-primary"
                        to={challanPath(row.id, String(row.dc_type))}
                      >{row.dc_number}</Link>
                    </td>
                    <td>{row.dc_type.replaceAll('_', ' ')}</td>
                    <td>{displayDate(row.dc_date)}</td>
                    <td>{row.party_name}</td>
                    <td className="num">{qty(row.total_quantity)}</td>
                    <td><Status value={row.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}