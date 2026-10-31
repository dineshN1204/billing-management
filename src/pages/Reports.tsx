import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, Field, Loading, PageTitle } from '../components/ui'
import { useAuth } from '../lib/auth'
import { explainError, financialYear, money, today } from '../lib/format'
import { db } from '../lib/db'
import { settle } from '../lib/async'

type Summary = { taxable: number; cgst: number; sgst: number; igst: number; total_gst: number; cess: number; sales: number; bills: number; pending: number }
export function Reports() {
  const { organization } = useAuth()
  const current = new Date()
  const fyStart = current.getMonth() < 3 ? current.getFullYear() - 1 : current.getFullYear()
  const [start, setStart] = useState(`${fyStart}-04-01`)
  const [end, setEnd] = useState(today())
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!organization) return
    // Clear the previous result before validating the range. The old guard returned
    // early and left the last period's figures on screen with no explanation, so
    // clearing the "From" date silently kept showing the old totals.
    setSummary(null)
    if (!start || !end || start > end) { setError(''); setLoading(false); return }
    let active = true
    setLoading(true)
    void settle(() => db.rpc('report_summary', { org_id: organization.id, start_date: start, end_date: end })).then(result => {
      if (!active) return
      if (!result.ok) { setError(explainError(result.error, 'The report could not be generated.')); setLoading(false); return }
      if (result.value.error) { setError(explainError(result.value.error, 'The report could not be generated.')); setLoading(false); return }
      // Keep the server's own wording where it is actionable, instead of the fixed
      // "could not be generated" sentence that hid the real cause.
      setError('')
      setSummary(result.value.data as Summary | null)
      setLoading(false)
    })
    return () => { active = false }
  }, [organization, start, end])
  return <><PageTitle eyebrow="BUSINESS INTELLIGENCE" title="Reports" description="Figures come directly from verified database records, not a browser-side approximation." /><Card className="report-filter"><Field label="From" type="date" value={start} onChange={e => setStart(e.target.value)} /><Field label="To" type="date" value={end} onChange={e => setEnd(e.target.value)} /><div><span className="eyebrow">PERIOD</span><p>Indian financial year {financialYear(start)}</p></div></Card>{start > end && <p role="alert" className="error-box">The start date must be on or before the end date.</p>}{error && <p role="alert" className="error-box">{error}</p>}{loading ? <Loading label="Generating report..." /> : summary && <><div className="stat-grid top-gap"><Card className="stat"><span>Sales</span><strong>{money(summary.sales)}</strong></Card><Card className="stat"><span>Bills</span><strong>{summary.bills}</strong></Card><Card className="stat"><span>Outstanding</span><strong>{money(summary.pending)}</strong><small>Full totals of bills not marked paid</small></Card></div><div className="two-column top-gap"><Card className="detail-card"><h2>GST breakdown</h2><dl className="detail-list"><dt>Taxable amount</dt><dd>{money(summary.taxable)}</dd><dt>CGST</dt><dd>{money(summary.cgst)}</dd><dt>SGST</dt><dd>{money(summary.sgst)}</dd><dt>IGST</dt><dd>{money(summary.igst)}</dd><dt>Total GST</dt><dd><strong>{money(summary.total_gst)}</strong></dd>{summary.cess > 0 && <><dt>Cess</dt><dd>{money(summary.cess)}</dd><dt>Tax payable (GST + cess)</dt><dd><strong>{money(summary.total_gst + summary.cess)}</strong></dd></>}</dl></Card><Card className="detail-card"><h2>Explore records</h2><p>Use the bill list to filter by financial year or payment status, and customer profiles to see purchase history.</p><div className="quick-links"><Link to="/bills">Browse bills →</Link><Link to="/customers">Customer history →</Link><Link to="/products">Product catalog →</Link></div></Card></div></>}</>
}
