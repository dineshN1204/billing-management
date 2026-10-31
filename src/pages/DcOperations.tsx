import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Download } from 'lucide-react'
import { Button, Card, EmptyState, Field, Loading, PageTitle, SelectField, Status } from '../components/ui'
import { useAuth } from '../lib/auth'
import { dcApi } from '../lib/dc-api'
import { DISPOSITION_LABEL, type Disposition } from '../lib/dc-types'
import { parseQty, pendingReturn, qty } from '../lib/dc-quantities'
import { challanPath } from '../lib/navigation'
import { exportCsv } from '../lib/csv'
import { describeError, displayDate, explainError, friendlyError } from '../lib/format'

/** A report row: the Data API returns each column as a scalar or null. */
export type ReportRow = Record<string, string | number | boolean | null | undefined>

type Row = ReportRow

/** Shared CSV export so every report behaves the same way. */
export function exportRows(rows: ReportRow[], filename: string, headers?: string[]) {
  if (!rows.length) return
  const columns = headers ?? Object.keys(rows[0]!)
  exportCsv(filename, columns, rows.map(row => columns.map(column => row[column])))
}

function DateRange({ from, to, setFrom, setTo }: {
  from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void
}) {
  return (
    <>
      <Field label="From" type="date" value={from} onChange={e => setFrom(e.target.value)} />
      <Field label="To" type="date" value={to} onChange={e => setTo(e.target.value)} />
    </>
  )
}

/** Lines that have arrived but not been fully inspected. */
export function DcInspection() {
  const { organization } = useAuth()
  const [rows, setRows] = useState<Row[]>([])
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!organization) return
    let active = true
    setLoading(true)
    void dcApi.pendingInspection(organization.id, from || undefined, to || undefined)
      .then(data => { if (active) { setRows(data as Row[]); setError('') } })
      .catch(cause => { if (active) setError(describeError(cause, 'Could not load.')) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [organization, from, to])

  return (
    <>
      <PageTitle
        eyebrow="QUALITY"
        title="Material Inspection"
        description="Received lines still awaiting a decision. Open the challan to record accepted, rejected and pending quantities."
      />
      <Card className="dc-card">
        <div className="field-grid">
          <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
        </div>
        <Button variant="secondary" onClick={() => exportRows(rows, 'pending-inspection')} disabled={rows.length === 0}>
          <Download size={16} /> CSV
        </Button>
      </Card>

      {error && <p role="alert" className="error-box">{error}</p>}
      {loading ? <Loading label="Loading..." /> : rows.length === 0 ? (
        <Card className="top-gap">
          <EmptyState
            title="Nothing awaiting inspection"
            description="Every received line has been inspected, or no material has been received yet."
            action="Open the inward register"
            href="/dc/inward"
          />
        </Card>
      ) : (
        <Card className="top-gap">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>DC</th><th>Date</th><th>Party</th><th>Part</th><th>Batch</th>
                  <th className="num">Received</th><th className="num">Pending inspection</th>
                  <th className="num">Accepted</th><th className="num">Rejected</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={`${row.dc_id}-${row.part_number}-${row.batch_lot_no}`}>
                    <td><Link className="table-primary" to={`/dc/inward/${row.dc_id}`}>{row.dc_number}</Link></td>
                    <td>{displayDate(String(row.dc_date))}</td>
                    <td>{row.party_name}</td>
                    <td>{row.part_number}</td>
                    <td>{row.batch_lot_no || '—'}</td>
                    <td className="num">{qty(Number(row.received_qty))}</td>
                    <td className="num strong">{qty(Number(row.pending_inspection_qty))}</td>
                    <td className="num">{qty(Number(row.accepted_qty))}</td>
                    <td className="num">{qty(Number(row.rejected_qty))}</td>
                    <td><Status value={String(row.inspection_status)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  )
}

/**
 * Rejection management.
 *
 * Material rejection and machining rejection are deliberately separate tables
 * here: one is stock refused on arrival, the other is components that failed
 * during processing. Merging them into a single "rejections" figure would hide
 * which problem a part actually has.
 */
export function DcRejections() {
  const { organization } = useAuth()
  const [material, setMaterial] = useState<Row[]>([])
  const [machining, setMachining] = useState<Row[]>([])
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState('')
  const [quantity, setQuantity] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  async function load() {
    if (!organization) return
    setLoading(true)
    try {
      const [m, x] = await Promise.all([
        dcApi.materialRejections(organization.id, from || undefined, to || undefined),
        dcApi.machiningRejections(organization.id, from || undefined, to || undefined),
      ])
      setMaterial(m as Row[]); setMachining(x as Row[]); setError('')
    } catch (cause) {
      setError(describeError(cause, 'Could not load rejections.'))
    } finally { setLoading(false) }
  }

  useEffect(() => { void load() }, [organization, from, to])

  async function recordReturn() {
    if (!organization || !selected || parseQty(quantity) <= 0) return
    setBusy(true); setError(''); setNotice('')
    try {
      await dcApi.recordMaterialReturn(organization.id, { rejection_id: selected, returned_qty: parseQty(quantity) })
      setNotice('Return recorded and a material return challan created.')
      setSelected(''); setQuantity('')
      await load()
    } catch (cause) {
      setError(explainError(cause, friendlyError(cause)))
    } finally { setBusy(false) }
  }

  const open = material.filter(r => Number(r.quantity_rejected) - Number(r.quantity_returned) - Number(r.quantity_scrapped) > 0)

  return (
    <>
      <Link className="back-link" to="/dc"><ArrowLeft size={16} /> DC dashboard</Link>
      <PageTitle
        eyebrow="QUALITY"
        title="Rejection Management"
        description="Material rejected on arrival and components rejected during processing, tracked separately, with partial returns supported."
      />
      <Card className="dc-card">
        <div className="field-grid">
          <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
        </div>
      </Card>

      {error && <p role="alert" className="error-box">{error}</p>}
      {notice && <p role="status" className="success-box">{notice}</p>}
      {loading ? <Loading label="Loading..." /> : (
        <>
          <div className="section-header top-gap">
            <h2>Material rejections</h2>
            <Button variant="secondary" onClick={() => exportRows(material, 'material-rejections')} disabled={material.length === 0}>
              <Download size={16} /> CSV
            </Button>
          </div>
          <Card>
            {material.length === 0 ? (
              <EmptyState title="No material rejections" description="No incoming material has been rejected in this period." />
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th><th>DC</th><th>Party</th><th>Part</th><th>Batch</th>
                      <th className="num">Rejected</th><th className="num">Returned</th><th className="num">Scrapped</th>
                      <th className="num">Pending return</th><th>Reason</th><th>Disposition</th><th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {material.map(row => (
                      <tr key={String(row.id)}>
                        <td>{displayDate(String(row.rejection_date))}</td>
                        <td>
                          {/* challanPath, not a hardcoded /dc/inward/ segment:
                              dc_material_rejections returned dc_number but no
                              dc_id until 0032, so this link was building
                              /dc/inward/undefined and reporting that a real
                              challan did not exist. */}
                          <Link className="table-primary" to={challanPath(String(row.dc_id), String(row.dc_type))}>
                            {row.dc_number}
                          </Link>
                        </td>
                        <td>{row.party_name}</td>
                        <td>{row.part_number}</td>
                        <td>{row.batch_lot_no || '—'}</td>
                        <td className="num">{qty(Number(row.quantity_rejected))}</td>
                        <td className="num">{qty(Number(row.quantity_returned))}</td>
                        <td className="num">{qty(Number(row.quantity_scrapped))}</td>
                        <td className="num strong">{qty(Number(row.outstanding))}</td>
                        <td>{row.rejection_reason || '—'}</td>
                        <td>{DISPOSITION_LABEL[(row.disposition ?? 'other') as Disposition] ?? String(row.disposition)}</td>
                        <td><Status value={String(row.status)} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {open.length > 0 && organization?.role !== 'viewer' && (
            <Card className="dc-card top-gap">
              <h2>Return rejected material</h2>
              <p className="muted">
                A rejection is not a return. Record what physically went back and the remainder stays visible
                as outstanding.
              </p>
              <div className="field-grid">
                <SelectField label="Rejection" value={selected} onChange={e => setSelected(e.target.value)}>
                  <option value="">Choose a rejection</option>
                  {open.map(row => (
                    <option key={String(row.id)} value={String(row.id)}>
                      {row.party_name} · {row.part_number} — {qty(Number(row.outstanding))} pending
                    </option>
                  ))}
                </SelectField>
                <Field label="Quantity returned now" type="number" min="0" step="0.001" value={quantity} onChange={e => setQuantity(e.target.value)} />
              </div>
              <Button disabled={busy || !selected || parseQty(quantity) <= 0} onClick={() => void recordReturn()}>
                {busy ? 'Recording...' : 'Record return'}
              </Button>
            </Card>
          )}

          <div className="section-header top-gap">
            <h2>Machining rejections</h2>
            <Button variant="secondary" onClick={() => exportRows(machining, 'machining-rejections')} disabled={machining.length === 0}>
              <Download size={16} /> CSV
            </Button>
          </div>
          <Card>
            {machining.length === 0 ? (
              <EmptyState
                title="No machining results recorded"
                description="Machining results exist only from the point this module was used. Nothing before that can be reconstructed."
              />
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th><th>DC</th><th>Part</th><th>Operation</th><th>Vendor</th>
                      <th className="num">Input</th><th className="num">Accepted output</th>
                      <th className="num">Rejection</th><th className="num">Rework</th><th className="num">Scrap</th>
                      <th className="num">Loss</th><th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {machining.map(row => (
                      <tr key={String(row.id)}>
                        <td>{displayDate(String(row.operation_date))}</td>
                        {/* The link goes to the OUTWARD challan: that is the
                            challan the work was done against and the one with
                            the machining history on it. The inward challan the
                            material came from is shown beside it, because that
                            is where the loss ultimately lands - but it is not
                            where the operator asked to go. dc_machining_rejections
                            returned neither id until 0032, so this column did
                            not exist at all before. */}
                        <td>
                          {row.source_dc_id
                            ? <Link className="table-primary" to={challanPath(String(row.source_dc_id), String(row.source_dc_type))}>
                                {String(row.source_dc_number)}
                              </Link>
                            : <span className="muted">—</span>}
                          {row.inward_dc_id && (
                            <small className="block muted">from {String(row.inward_dc_number)}</small>
                          )}
                        </td>
                        <td className="table-primary">{row.part_number}</td>
                        <td>{row.operation}</td>
                        <td>{row.party_name || '—'}</td>
                        <td className="num">{qty(Number(row.input_quantity))} {row.input_unit}</td>
                        <td className="num">{qty(Number(row.accepted_output_quantity))}</td>
                        <td className="num strong">{qty(Number(row.machining_rejection_quantity))}</td>
                        <td className="num">{qty(Number(row.rework_quantity))}</td>
                        <td className="num">{qty(Number(row.scrap_quantity))}</td>
                        <td className="num">{qty(Number(row.process_loss_quantity))}</td>
                        <td>{row.rejection_reason || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </>
  )
}

/** Everything still outstanding: inspection, material returns and customer deliveries. */
export function DcPending() {
  const { organization } = useAuth()
  const [deliveries, setDeliveries] = useState<Row[]>([])
  const [inspection, setInspection] = useState<Row[]>([])
  const [returns, setReturns] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!organization) return
    let active = true
    setLoading(true)
    void (async () => {
      // All-settled, so one failed report does not blank the other three panels and
      // does not leave them showing "nothing pending". Each panel is reported
      // independently.
      const results = await Promise.allSettled([
        dcApi.pendingCustomerDelivery(organization.id),
        dcApi.pendingInspection(organization.id),
        dcApi.materialRejections(organization.id),
      ])
      if (!active) return
      const value = (step: PromiseSettledResult<unknown>): Row[] => (step.status === 'fulfilled' ? step.value as Row[] : [])
      const failures = results
        .map((step, index) => (step.status === 'rejected' ? `${['customer delivery', 'pending inspection', 'material rejections'][index]}: ${describeError(step.reason, 'request failed')}` : ''))
        .filter(Boolean)
      setDeliveries(value(results[0])); setInspection(value(results[1]))
      setReturns(value(results[2]).filter(row => pendingReturn(Number(row.quantity_rejected), Number(row.quantity_returned), Number(row.quantity_scrapped)) > 0))
      // Clear the banner on a good load. It used to persist for the life of the
      // page, so a single early failure left a red warning beside correct data.
      setError(failures.join(' · '))
      setLoading(false)
    })()
    return () => { active = false }
  }, [organization])

  return (
    <>
      <PageTitle
        eyebrow="OUTSTANDING"
        title="Pending Quantities"
        description="What is still waiting: inspection, material to be returned, and deliveries not yet confirmed."
      />
      {error && <p role="alert" className="error-box">{error}</p>}
      {loading ? <Loading label="Loading..." /> : (
        <div className="two-column">
          <Card>
            <div className="section-header"><h2>Awaiting inspection</h2></div>
            {inspection.length === 0 ? <EmptyState title="Nothing pending" description="No line is awaiting inspection." /> : (
              <div className="table-scroll">
                <table>
                  <thead><tr><th>DC</th><th>Part</th><th className="num">Pending</th></tr></thead>
                  <tbody>
                    {inspection.slice(0, 12).map(row => (
                      <tr key={`${row.dc_id}-${row.part_number}`}>
                        <td><Link className="table-primary" to={`/dc/inward/${row.dc_id}`}>{row.dc_number}</Link></td>
                        <td>{row.part_number}</td>
                        <td className="num">{qty(Number(row.pending_inspection_qty))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>


          <Card>
            <div className="section-header"><h2>Rejected material to be returned</h2></div>
            {returns.length === 0 ? <EmptyState title="Nothing to return" description="All rejected material has been returned or scrapped." /> : (
              <div className="table-scroll">
                <table>
                  <thead><tr><th>DC</th><th>Party</th><th>Part</th><th className="num">Pending return</th></tr></thead>
                  <tbody>
                    {returns.map(row => (
                      <tr key={String(row.id)}>
                        <td><Link className="table-primary" to={`/dc/inward/${row.dc_id}`}>{row.dc_number}</Link></td>
                        <td>{row.party_name}</td>
                        <td>{row.part_number}</td>
                        <td className="num strong">
                          {qty(pendingReturn(Number(row.quantity_rejected), Number(row.quantity_returned), Number(row.quantity_scrapped)))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card className="full-width">
            <div className="section-header"><h2>Customer deliveries not confirmed</h2></div>
            {deliveries.length === 0 ? <EmptyState title="Nothing outstanding" description="Every dispatch has been confirmed." /> : (
              <div className="table-scroll">
                <table>
                  <thead><tr><th>DC</th><th>Customer</th><th className="num">Dispatched</th><th className="num">Delivered</th><th className="num">Outstanding</th><th>Status</th></tr></thead>
                  <tbody>
                    {deliveries.slice(0, 12).map(row => (
                      <tr key={String(row.dc_id)}>
                        <td>
                          {/* Through challanPath, so the route follows the
                              document's own type instead of a hardcoded
                              legacy alias. */}
                          <Link className="table-primary" to={challanPath(String(row.dc_id), String(row.dc_type))}>
                            {row.dc_number}
                          </Link>
                        </td>
                        <td>{row.party_name}</td>
                        <td className="num">{qty(Number(row.qty_dispatched))}</td>
                        <td className="num">{qty(Number(row.qty_delivered))}</td>
                        <td className="num strong">{qty(Number(row.qty_outstanding))}</td>
                        <td><Status value={String(row.status)} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}
    </>
  )
}

/** Every dispatch, receipt and return as a single chronological log. */
export function DcMovements() {
  const { organization } = useAuth()
  const [rows, setRows] = useState<Row[]>([])
  const [type, setType] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!organization) return
    let active = true
    setLoading(true)
    void dcApi.movementHistory(organization.id, from || undefined, to || undefined, type || undefined)
      .then(data => { if (active) { setRows(data as Row[]); setError('') } })
      .catch(cause => { if (active) setError(describeError(cause, 'Could not load movements.')) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [organization, type, from, to])

  return (
    <>
      <PageTitle
        eyebrow="HISTORY"
        title="Dispatch and Receipt History"
        description="Every material movement in chronological order, including reversals recorded by cancellations."
      />
      <Card className="dc-card">
        <div className="field-grid">
          <SelectField label="Movement type" value={type} onChange={e => setType(e.target.value)}>
            <option value="">All movements</option>
            <option value="receipt">Receipt</option>
            <option value="dispatch">Dispatch to vendor</option>
            <option value="vendor_return">Vendor return</option>
            <option value="material_return">Material return</option>
            <option value="customer_delivery">Customer delivery</option>
          </SelectField>
          <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
        </div>
        <Button variant="secondary" onClick={() => exportRows(rows, 'dc-movements')} disabled={rows.length === 0}>
          <Download size={16} /> CSV
        </Button>
      </Card>
      {error && <p role="alert" className="error-box">{error}</p>}
      {loading ? <Loading label="Loading..." /> : rows.length === 0 ? (
        <Card className="top-gap"><EmptyState title="No movements" description="No material has moved in this period." /></Card>
      ) : (
        <Card className="top-gap">
          <div className="table-scroll">
            <table>
              <thead><tr><th>When</th><th>Movement</th><th>DC</th><th>Party</th><th>Part</th><th className="num">Quantity</th><th>Unit</th><th>Remarks</th></tr></thead>
              <tbody>
                {rows.map(row => (
                  <tr key={String(row.movement_type) + String(row.moved_at) + String(row.dc_number) + String(row.part_number)}>
                    <td>{new Date(String(row.moved_at)).toLocaleString('en-IN')}</td>
                    <td>{row.is_reversal ? `${String(row.movement_type).replaceAll('_', ' ')} (reversal)` : String(row.movement_type).replaceAll('_', ' ')}</td>
                    <td><Link className="table-primary" to={row.dc_id ? challanPath(String(row.dc_id), String(row.dc_type)) : '/dc/all'}>{row.dc_number}</Link></td>
                    <td>{row.party_name}</td>
                    <td>{row.part_number || '—'}</td>
                    <td className="num">{qty(Number(row.quantity))}</td>
                    <td>{row.unit}</td>
                    <td>{row.remarks || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  )
}