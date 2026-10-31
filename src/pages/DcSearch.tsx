import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Download, Receipt, Search as SearchIcon } from 'lucide-react'
import { Button, Card, EmptyState, JobStatus, Loading, PageTitle, Pagination, Status } from '../components/ui'
import { useAuth } from '../lib/auth'
import { dcApi } from '../lib/dc-api'
import { type DcSearchHit } from '../lib/dc-types'
import { qty } from '../lib/dc-quantities'
import { challanPath } from '../lib/navigation'
import { describeError, displayDate } from '../lib/format'
import { exportRows } from './DcOperations'

const PAGE_SIZE = 25

/**
 * One search over every identifier a store actually holds.
 *
 * Typing a customer's DC number returns the inward challans that carry it and
 * the outward challans drawn from those inward lines - which is the reason the
 * line-level link exists. The same box matches our own DC numbers, part
 * numbers, drawing numbers, customer names, GSTINs and bill numbers, across all
 * customers, because the identifier in front of you rarely says which one it is.
 *
 * The matched identifier is shown on every row. A result that appears for no
 * visible reason is indistinguishable from a bug, and this list mixes matches
 * from six different columns.
 */
export function DcSearch() {
  const { organization } = useAuth()
  const [term, setTerm] = useState('')
  const [hits, setHits] = useState<DcSearchHit[]>([])
  const [page, setPage] = useState(1)
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { setPage(1) }, [term])

  useEffect(() => {
    if (!organization) return
    const trimmed = term.trim()
    // An empty term lists nothing rather than everything: a search box that
    // dumps the whole workspace on focus is indistinguishable from a broken one.
    if (!trimmed) { setHits([]); setSearched(false); setError(''); return }
    let active = true
    setSearching(true)
    const timer = window.setTimeout(() => {
      void dcApi.search(organization.id, trimmed)
        .then(rows => {
          if (!active) return
          setHits(rows)
          setSearched(true)
          setError('')
        })
        .catch(cause => { if (active) setError(describeError(cause, 'Could not search.')) })
        .finally(() => { if (active) setSearching(false) })
    }, 250)
    return () => { active = false; window.clearTimeout(timer) }
  }, [organization, term])

  const paged = useMemo(() => hits.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [hits, page])

  return (
    <>
      <PageTitle
        eyebrow="SEARCH"
        title="Find a challan"
        description="Customer DC number, our DC number, part or drawing number, customer name, GSTIN or bill number. Searching a customer DC number shows the inward challans that carry it and the outward challans made from them."
      />
      <Card>
        <div className="table-toolbar">
          <label className="search-field">
            <SearchIcon size={16} aria-hidden="true" />
            <input
              aria-label="Search challans and bills"
              placeholder="Customer DC, our DC, part number, drawing, customer, GSTIN or bill number..."
              value={term}
              onChange={e => setTerm(e.target.value)}
              autoFocus
            />
          </label>
          <Button
            variant="secondary"
            disabled={hits.length === 0}
            onClick={() => exportRows(hits as unknown as Parameters<typeof exportRows>[0], 'dc-search', [
              'result_type', 'dc_number', 'dc_type', 'dc_date', 'status', 'job_status',
              'party_name', 'customer_dc_numbers', 'line_count', 'total_quantity', 'matched_on',
            ])}
          >
            <Download size={16} /> CSV
          </Button>
        </div>

        {error && <p role="alert" className="error-box">{error}</p>}
        {searching && <Loading label="Searching..." />}
        {!searching && searched && hits.length === 0 && (
          <EmptyState
            title="Nothing matched"
            description={`No challan or bill matches "${term.trim()}".`}
            action="Open the inward register"
            href="/dc/inward"
          />
        )}
        {!searching && !searched && (
          <EmptyState
            title="Search across every challan"
            description="Type a customer DC number to see the inward challans that carry it and the outward challans made from them."
          />
        )}

        {!searching && hits.length > 0 && (
          <>
            <p className="muted">{hits.length} match{hits.length === 1 ? '' : 'es'}</p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Challan</th><th>Direction</th><th>Customer DC</th><th>Date</th>
                    <th>Customer</th><th className="num">Lines</th><th className="num">Quantity</th>
                    <th>Status</th><th>Job</th><th>Matched on</th><th />
                  </tr>
                </thead>
                <tbody>
                  {paged.map(hit => (
                    <tr key={hit.id}>
                      <td><Link className="table-primary" to={challanPath(hit.id, hit.dc_type)}>{hit.dc_number}</Link></td>
                      <td>{hit.result_type === 'inward' ? 'Inward' : 'Outward'}</td>
                      <td className="mono">{(hit.customer_dc_numbers ?? []).join(', ') || '—'}</td>
                      <td>{displayDate(hit.dc_date)}</td>
                      <td><Link to={`/customers/${hit.party_id}`}>{hit.party_name}</Link></td>
                      <td className="num">{hit.line_count}</td>
                      <td className="num">{qty(hit.total_quantity)}</td>
                      <td><Status value={hit.status} /></td>
                       <td>
                        {hit.job_status
                          ? <JobStatus value={hit.job_status} />
                          : '—'}
                      </td>
                      <td className="muted">{hit.matched_on ?? '—'}</td>
                      {/* Searching a customer's DC number and landing on the
                          outward challan is the point of that search, so the
                          next step - raising the bill for it - is offered here
                          rather than making the operator go back and find it.

                          The cell is always rendered, empty for an inward row: a
                          row with one cell fewer than the header puts every
                          column after it under the wrong heading. */}
                      <td>
                        {hit.result_type === 'outward' && hit.status !== 'draft' && hit.status !== 'cancelled' && (
                          <Link className="button button-secondary" to={`/bills/new?dc=${hit.id}`}>
                            <Receipt size={15} /> Bill this
                          </Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} count={hits.length} size={PAGE_SIZE} onChange={setPage} />
          </>
        )}
      </Card>
    </>
  )
}
