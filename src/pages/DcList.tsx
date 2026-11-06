import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Download, Filter, Plus } from 'lucide-react'
import { Button, Card, EmptyState, JobStatus, Loading, PageTitle, Pagination, Status } from '../components/ui'
import { useAuth } from '../lib/auth'
import { dcApi, type DcListRow } from '../lib/dc-api'
import { DC_TYPE_DESCRIPTION, DC_TYPE_LABEL, JOB_STATUS_LABEL, type DcJobStatus, type DcType } from '../lib/dc-types'
import { qty } from '../lib/dc-quantities'
import { challanPath } from '../lib/navigation'
import { buildCsv, downloadCsv } from '../lib/csv'
import { describeError, displayDate } from '../lib/format'

const PAGE_SIZE = 25

/**
 * The stored status an inward challan can actually reach. It is written once,
 * when the challan is issued, and nothing ever moves it - offering
 * `dispatched` or `delivered` on the inward register can only ever return an
 * empty table, which reads like a bug. The work itself is the job status.
 */
const RECEIPT_STATUSES = [
  { value: 'draft', label: 'Draft' },
  { value: 'issued', label: 'Issued' },
  { value: 'cancelled', label: 'Cancelled' },
]

/**
 * An outward challan *is* its own delivery, so `confirm_delivery` does move
 * its stored status through dispatched, partially delivered and delivered.
 */
const MOVEMENT_STATUSES = [
  { value: 'draft', label: 'Draft' },
  { value: 'issued', label: 'Issued' },
  { value: 'dispatched', label: 'Dispatched' },
  { value: 'partially_delivered', label: 'Partially delivered' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'cancelled', label: 'Cancelled' },
]

const JOB_STATUSES: DcJobStatus[] = ['not_started', 'in_progress', 'partially_delivered', 'delivered']

/** The customer's own challan numbers, joined for a single cell. */
function customerDcs(row: DcListRow): string[] {
  return (row.customer_dc_numbers ?? []).filter(value => Boolean(value && value.trim()))
}

/** The register behind every DC list: one table, filtered by document type. */
export function DcList({ dcType, title, eyebrow }: { dcType: DcType; title: string; eyebrow: string }) {
  const { organization } = useAuth()
  const [rows, setRows] = useState<DcListRow[]>([])
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [jobStatus, setJobStatus] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)

  useEffect(() => { setPage(1) }, [search, status, jobStatus, from, to])

  useEffect(() => {
    if (!organization) return
    let active = true
    setLoading(true)
    void (async () => {
      try {
        const data = await dcApi.register(organization.id, { dc_type: dcType, from, to, status, job_status: jobStatus })
        const term = search.trim().toLowerCase()
        const filtered = term
          ? data.filter(row =>
            row.dc_number.toLowerCase().includes(term) ||
            row.party_name.toLowerCase().includes(term) ||
            (row.party_gstin ?? '').toLowerCase().includes(term) ||
            // The customer DC numbers live on the lines, and the register only
            // holds the document row, so they come through the RPC's aggregate.
            customerDcs(row).some(value => value.toLowerCase().includes(term)))
          : data
        if (active) { setRows(filtered); setError('') }
      } catch (cause) {
        if (active) setError(describeError(cause, 'Could not load challans.'))
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [organization, dcType, search, status, jobStatus, from, to])

  const paged = useMemo(() => rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [rows, page])
  const newPath = dcType === 'inward' ? '/dc/inward/new' : '/dc/outward/new'

  const detailPath = (row: DcListRow) => challanPath(row.id, row.dc_type)

  function exportCsv() {
    // Only the inward register carries a job status, so only it carries the
    // column. An outward challan is its own delivery and has none.
    const withJob = dcType === 'inward'
    const header = ['DC number', 'Customer DC', 'Type', 'Date', 'Status', ...(withJob ? ['Job status'] : []), 'Party', 'Lines', 'Quantity']
    const body = rows.map(row => [
      row.dc_number, customerDcs(row).join(' / '), row.dc_type, row.dc_date,
      row.status, ...(withJob ? [row.job_status ?? ''] : []),
      row.party_name, row.line_count, row.total_quantity,
    ])
    downloadCsv(`dc-${dcType}-register`, buildCsv(header, body))
  }

  return (
    <>
      <PageTitle
        eyebrow={eyebrow}
        title={title}
        description={DC_TYPE_DESCRIPTION[dcType]}
        action={
          <div className="inline-actions">
            <Button variant="secondary" onClick={exportCsv} disabled={rows.length === 0}>
              <Download size={16} /> CSV
            </Button>
            {organization?.role !== 'viewer' && (
              <Link className="button button-primary" to={newPath}><Plus size={17} /> New {DC_TYPE_LABEL[dcType]}</Link>
            )}
          </div>
        }
      />
      <Card>
        <div className="table-toolbar dc-list-toolbar">
          <div className="dc-list-search-row">
            <input
              aria-label={`Search ${title}`}
              placeholder="Search customer DC, our DC, party, part or GSTIN..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            {/* Below 1280px the five filter controls do not fit on one line, so
                they move behind this button and leave the register above the
                fold. On a wide screen the button is hidden and the filters sit
                inline exactly as before. */}
            <button
              type="button"
              className={`dc-list-filter-toggle ${filterOpen ? 'active' : ''}`}
              aria-label={filterOpen ? 'Hide filters' : 'Show filters'}
              aria-expanded={filterOpen}
              aria-controls="dc-list-filters"
              onClick={() => setFilterOpen(open => !open)}
            >
              <Filter size={17} />
            </button>
          </div>
          <div id="dc-list-filters" className={`dc-list-filters ${filterOpen ? 'open' : ''}`}>
            <select aria-label="DC status" value={status} onChange={e => setStatus(e.target.value)}>
              <option value="">All DC statuses</option>
              {(dcType === 'inward' ? RECEIPT_STATUSES : MOVEMENT_STATUSES).map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            {dcType === 'inward' && (
              <select aria-label="Job status" value={jobStatus} onChange={e => setJobStatus(e.target.value)}>
                <option value="">All job statuses</option>
                {JOB_STATUSES.map(value => <option key={value} value={value}>{JOB_STATUS_LABEL[value]}</option>)}
              </select>
            )}
            <label className="inline-control">From <input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
            <label className="inline-control">To <input type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
          </div>
        </div>
        {error && <p role="alert" className="error-box">{error}</p>}
        {loading ? <Loading label="Loading challans..." /> : rows.length === 0 ? (
          <EmptyState
            title="No challans found"
            description="Adjust the filters, or create the first one."
            action={organization?.role !== 'viewer' ? `Create ${DC_TYPE_LABEL[dcType]}` : undefined}
            href={newPath}
          />
        ) : (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>DC number</th><th>Customer DC</th><th>Date</th><th>Party</th>
                    {dcType === 'outward_customer' && <th>Answers inward</th>}
                    <th className="num">Lines</th><th className="num">Quantity</th>

                    <th>DC status</th>
                    {dcType === 'inward' && <th>Job status</th>}
                  </tr>
                </thead>
                <tbody>
                  {paged.map(row => (
                    <tr key={row.id}>
                      <td><Link className="table-primary" to={detailPath(row)}>{row.dc_number}</Link></td>
                      <td className="mono">{customerDcs(row).join(', ') || '—'}</td>
                      <td>{displayDate(row.dc_date)}</td>
                      <td><Link to={`/customers/${row.party_id}`}>{row.party_name}</Link></td>
                      {dcType === 'outward_customer' && (
                        <td className="mono">
                          {row.reference_inward_number
                            ? <Link to={`/dc/inward/${row.reference_inward_dc_id}`}>{row.reference_inward_number}</Link>
                            : '—'}
                        </td>
                      )}
                      <td className="num">{row.line_count}</td>
                      <td className="num">{qty(row.total_quantity)}</td>

                      <td><Status value={row.status} /></td>
                      {dcType === 'inward' && <td><JobStatus value={row.job_status} /></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} count={rows.length} size={PAGE_SIZE} onChange={setPage} />
          </>
        )}
      </Card>
    </>
  )
}

export function InwardList() {
  return <DcList dcType="inward" eyebrow="RECEIVING" title="Inward Delivery Challans" />
}

export function OutwardCustomerList() {
  return <DcList dcType="outward_customer" eyebrow="DELIVERING" title="Outward Delivery Challans" />
}

/** Every challan in one register, which is what a store keeper actually wants. */
export function AllChallans() {
  const { organization } = useAuth()
  const [rows, setRows] = useState<DcListRow[]>([])
  const [search, setSearch] = useState('')
  const [type, setType] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!organization) return
    let active = true
    setLoading(true)
    void (async () => {
      try {
        const data = await dcApi.register(organization.id, { dc_type: type || undefined })
        if (active) { setRows(data); setError('') }
      } catch (cause) {
        if (active) setError(describeError(cause, 'Could not load challans.'))
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [organization, type])

  const term = search.trim().toLowerCase()
  const filtered = term
    ? rows.filter(row =>
      row.dc_number.toLowerCase().includes(term) ||
      row.party_name.toLowerCase().includes(term) ||
      (row.party_gstin ?? '').toLowerCase().includes(term))
    : rows

  return (
    <>
      <PageTitle eyebrow="REGISTER" title="All Delivery Challans" description="Every inward, outward and return challan in one place." />
      <Card>
        <div className="table-toolbar">
          <input aria-label="Search challans" placeholder="Search DC number or party..." value={search} onChange={e => setSearch(e.target.value)} />
          <select aria-label="Document type" value={type} onChange={e => setType(e.target.value)}>
            <option value="">All types</option>
            <option value="inward">Inward</option>
            <option value="outward_customer">Outward</option>
            <option value="material_return">Material return</option>
          </select>
        </div>
        {error && <p role="alert" className="error-box">{error}</p>}
        {loading ? <Loading label="Loading..." /> : filtered.length === 0 ? (
          <EmptyState title="No challans yet" description="Create an inward or outward challan to get started." />
        ) : (
          <div className="table-scroll">
            <table>
              <thead><tr><th>DC number</th><th>Type</th><th>Date</th><th>Party</th><th className="num">Quantity</th><th>DC status</th><th>Job status</th></tr></thead>
              <tbody>
                {filtered.slice(0, 200).map(row => {
                  return (
                    <tr key={row.id}>
                      <td><Link className="table-primary" to={challanPath(row.id, row.dc_type)}>{row.dc_number}</Link></td>
                      <td>{DC_TYPE_LABEL[row.dc_type]}</td>
                      <td>{displayDate(row.dc_date)}</td>
                      <td>{row.party_name}</td>
                      <td className="num">{qty(row.total_quantity)}</td>
                      <td><Status value={row.status} /></td>
                      <td><JobStatus value={row.job_status} /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {filtered.length > 200 && <p className="muted">Showing the first 200 of {filtered.length}. Narrow the search to see more.</p>}
      </Card>
    </>
  )
}