import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Ban, Download, PackageCheck, Printer, Receipt, Truck } from 'lucide-react'
import { Button, Card, EmptyState, Field, Loading, PageTitle, SelectField, Status, JobStatus, TextArea } from '../components/ui'
import { DcPaper, inspectionBadge } from '../components/DcPaper'
import { useAuth } from '../lib/auth'
import { dcApi, loadDcBundle } from '../lib/dc-api'
import { DC_TYPE_LABEL, DISPOSITION_LABEL, type DcBundle, type DcDocument, type DcItem, type DcJobProgressRow, type DcType } from '../lib/dc-types'
import {
  balanceInspectionOutcome, deliveryBalance, deliveryClosesChallan, deliveryPreview, INSPECTION_KEYS, inwardCompletion,
  inspectionBalance, isNegativeQty, outcomeTotal, outwardCompletion, parseQty, pendingReturn, qty,
  quantityText, receiptSplit, type InspectionKey, type InspectionOutcome, type OutwardCompletion,
} from '../lib/dc-quantities'
import { displayDate, explainError, friendlyError, localDateTime, today } from '../lib/format'
import { db } from '../lib/db'
import { settle } from '../lib/async'

const listPathFor = (type: DcType) => (type === 'inward' ? '/dc/inward' : '/dc/outward')

type Panel = 'receipt' | 'inspection' | 'dispatch' | 'delivery' | 'machining' | 'cancel'

export function DcDetail() {
  const { id } = useParams()
  const { organization } = useAuth()
  const [bundle, setBundle] = useState<DcBundle | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [panel, setPanel] = useState<Panel | null>(null)
  // Derived by the database, never stored: how far the job on an inward challan
  // has got. Deliberately separate from `doc.status`, which on an inward challan
  // means the receipt lifecycle rather than the work.
  const [progress, setProgress] = useState<DcJobProgressRow[]>([])
  // The outward challans made from this inward challan, so the pair can be
  // read from the inward side without opening the other document.
  const [outwardChallans, setOutwardChallans] = useState<Array<{
    dc_id: string; dc_number: string; dc_date: string; dc_status: string
    line_count: number; total_dispatched: number; total_delivered: number
  }>>([])

  const readOnly = organization?.role === 'viewer'
  const doc = bundle?.document

  const jobSummary = progress.find(row => row.scope === 'document') ?? null
  const jobLines = progress.filter(row => row.scope === 'line')

  // Every customer DC number this challan touches, from both directions. Falls
  // back to deriving them here so a challan loaded before the resolver was
  // available still shows them rather than a blank.
  const customerDcNumbers = bundle?.customer_dc_numbers?.length
    ? bundle.customer_dc_numbers
    : [...new Set((bundle?.items ?? []).flatMap(item =>
      [item.customer_dc_number, item.source_inward_customer_dc_number]
        .filter((value): value is string => Boolean(value && value.trim())),
    ))].sort((a, b) => a.localeCompare(b))

  // A reload token, so a slow response from a challan the user has already
// navigated away from cannot overwrite the one now on screen.
const loadToken = useRef(0)

  const reload = useCallback(async () => {
    if (!id || !organization) return
    const token = ++loadToken.current
    const result = await settle(() => loadDcBundle(id, organization.id))
    if (token !== loadToken.current) return
    if (!result.ok) { setError(explainError(result.error, 'The challan could not be loaded.')); setLoading(false); return }
    const { bundle: data, partialErrors } = result.value
    setBundle(data)
    // A challan whose lines failed to load is shown with a warning rather than as
    // an empty document, so nobody mistakes a failed read for a challan with no
    // material on it.
    if (partialErrors.length) setError(`Some of this challan could not be loaded (${partialErrors.join('; ')}).`)
    else setError('')
    if (!data) setError('Delivery challan not found, or you do not have access to it.')
    setLoading(false)
  }, [id, organization])

  useEffect(() => { setLoading(true); void reload() }, [reload])

  // Only an inward challan carries a job. `settle` rather than a bare await, so a
  // failed read cannot leave the page stuck loading - and a failure here is not
  // fatal anyway: everything below it still renders.
  useEffect(() => {
    if (!id || !organization || bundle?.document.dc_type !== 'inward') {
      setProgress([])
      return
    }
    let active = true
    void settle(() => dcApi.jobProgress(organization.id, id!))
      .then(result => { if (active) setProgress(result.ok ? result.value : []) })
    return () => { active = false }
  }, [id, organization, bundle?.document.dc_type])

  // The outward challans drawn from this inward challan. A failed read leaves
  // the list empty rather than raising on the page: an inward challan with no
  // outward challan yet is the ordinary case.
  useEffect(() => {
    if (!id || !organization || bundle?.document.dc_type !== 'inward') {
      setOutwardChallans([])
      return
    }
    let active = true
    void settle(() => dcApi.outwardsForInward(organization.id, id!))
      .then(result => { if (active) setOutwardChallans(result.ok ? result.value : []) })
    return () => { active = false }
  }, [id, organization, bundle?.document.dc_type])

  /**
   * The letterhead.
   *
   * Taken from the signed-in workspace rather than read again from the
   * organizations table: the session already carries the company details, and a
   * second read could fail on its own and leave the challan printing the
   * literal string "Organization" - a wrong letterhead rather than an obvious
   * gap.
   */
  const company = useMemo(() => ({
    name: organization?.name ?? 'Organization',
    gstin: organization?.gstin ?? null,
    address: organization?.address ?? null,
    phone: organization?.phone ?? null,
    email: organization?.email ?? null,
  }), [organization])


  async function run<T>(action: () => Promise<T>, success: string) {
    // Guard on the live value. Without this a second action started while the
    // first was still in flight had its busy flag cleared by the first one's
    // finally block, re-enabling the buttons mid-submission - and setPanel(null)
    // then closed whichever panel that second action had opened.
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      await action()
      setNotice(success)
      await reload()
      setPanel(null)
    } catch (cause) {
      setError(explainError(cause, friendlyError(cause)))
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <Loading label="Loading challan..." />
  if (!bundle || !doc) {
    return (
      <>
        <Link className="back-link" to="/dc"><ArrowLeft size={16} /> Delivery challans</Link>
        <EmptyState title="Challan not found" description="It may have been removed, or it belongs to another workspace." action="Back to DC dashboard" href="/dc" />
      </>
    )
  }

  return (
    <>
      <div className="no-print dc-detail">
        <Link className="back-link" to={listPathFor(doc.dc_type)}><ArrowLeft size={16} /> {DC_TYPE_LABEL[doc.dc_type]}s</Link>
        <PageTitle
          eyebrow={DC_TYPE_LABEL[doc.dc_type].toUpperCase()}
          title={doc.dc_number}
          description={`${doc.party_name} · ${displayDate(doc.dc_date)}`}
          action={
            <div className="inline-actions">
              <Status value={doc.status} />
              {jobSummary?.job_status && (
                <JobStatus value={jobSummary.job_status} />
              )}
              {doc.dc_type === 'inward' && doc.status !== 'cancelled' && <CompletionBadge bundle={bundle} />}
              {doc.dc_type === 'outward_customer' && doc.status !== 'cancelled' && <OutwardBadge bundle={bundle} />}
              {!readOnly && doc.status !== 'cancelled' && (
                <Link className="button button-secondary" to={`${listPathFor(doc.dc_type)}/${doc.id}/edit`}>Edit</Link>
              )}
              <Button variant="secondary" onClick={() => window.print()}><Printer size={16} /> Print</Button>
              <Button variant="secondary" onClick={() => void download()}>
                <Download size={16} /> PDF
              </Button>
            </div>
          }
        />

        {error && <p role="alert" className="error-box">{error}</p>}
        {notice && <p role="status" className="success-box">{notice}</p>}

        <div className="dc-card-stack">
        {doc.cancel_reason && (
          <Card className="detail-card">
            <h2>Cancelled</h2>
            <p>{doc.cancel_reason}</p>
            <small>The document is kept for the record and no longer counts as a completed dispatch.</small>
          </Card>
        )}

        <div className="dc-actions">
          {doc.dc_type === 'inward' && doc.status !== 'cancelled' && (
            <>
              {!readOnly && <Button variant="secondary" onClick={() => setPanel(panel === 'receipt' ? null : 'receipt')}><Truck size={16} /> Record receipt</Button>}
              {!readOnly && <Button variant="secondary" onClick={() => setPanel(panel === 'inspection' ? null : 'inspection')}>Record inspection</Button>}
              {/* The next step of the job: send the finished parts back. It is
                  offered only once every line has been received and judged,
                  because an outward challan drawn from a line that is still
                  awaiting inspection would be dispatching material nobody has
                  accepted. The outward challan takes the same serial as this
                  one and carries its customer DC numbers across. */}
              {!readOnly && (
                jobSummary?.job_status === 'delivered'
                  ? <Button variant="secondary" disabled title="Every line on this inward challan has already been delivered, so there is nothing left to send out."><Truck size={16} /> Create outward DC</Button>
                  : inwardCompletion(bundle.items) === 'complete'
                    ? <Link className="button button-secondary" to={`/dc/outward/new?fromInward=${doc.id}`}><Truck size={16} /> Create outward DC</Link>
                    : <Button variant="secondary" disabled title="Record the receipt and the inspection for every line first.">Create outward DC</Button>
              )}
            </>
          )}
          {/* In the order the work actually happens. Machining comes first because
              it is what produces the finished quantity: 90 accepted in, 5 rejected
              in machining, 85 out. Dispatch then moves the 85 and confirm delivery
              records the customer taking them. Confirming delivery before dispatch
              is refused by the database (0025 raises NOT_DISPATCHED), so this order
              is the only one the RPCs allow. */}
          {doc.dc_type === 'outward_customer' && doc.status !== 'cancelled' && (
            <>
              {!readOnly && doc.status !== 'delivered' && <Button variant="secondary" onClick={() => setPanel(panel === 'machining' ? null : 'machining')}>Record machining result</Button>}
              {!readOnly && doc.status !== 'delivered' && <Button variant="secondary" onClick={() => setPanel(panel === 'dispatch' ? null : 'dispatch')}><Truck size={16} /> Dispatch</Button>}
              {/* Confirming delivery is the step that closes the challan. It was
                  the missing half: the RPC and the api wrapper both existed, but
                  nothing on this page ever called them, so an outward challan
                  could reach `dispatched` and go no further. Once delivered, the
                  work is closed, so the step is offered only while the customer
                  still owes us the balance. */}
              {!readOnly && (doc.status === 'dispatched' || doc.status === 'partially_delivered') && (
                <Button variant="secondary" onClick={() => setPanel(panel === 'delivery' ? null : 'delivery')}><PackageCheck size={16} /> Confirm delivery</Button>
              )}
              {/* Once there is something to invoice: finalized and not
                  cancelled, both of which the block above already guarantees.
                  The bill opens with this challan's customer, parts and
                  dispatched quantities already in it; the rates are typed,
                  because a challan records what moved, not what it cost. */}
              {!readOnly && doc.status !== 'draft' && (
                <Link className="button button-secondary" to={`/bills/new?dc=${doc.id}`}><Receipt size={16} /> Bill this challan</Link>
              )}
            </>
          )}

          {!readOnly && doc.status !== 'cancelled' && (
            <Button variant="danger" onClick={() => setPanel(panel === 'cancel' ? null : 'cancel')}><Ban size={16} /> Cancel</Button>
          )}
        </div>

        {doc.dc_type === 'inward' && jobSummary?.job_status && (
          <Card className="detail-card no-print">
            <div className="section-header">
              <h2>Job progress</h2>
              <JobStatus value={jobSummary.job_status} />
            </div>
            <p className="muted">
              Derived from the outward challans drawn from this one, not a stored status. The status
              above is the receipt: <em>{doc.status.replaceAll('_', ' ')}</em> means the material
              arrived at our gate. This one is the work on it: it reads <strong>Work in process</strong>
              from the moment an outward challan is raised against it, and <strong>Delivered</strong>
              once the customer has acknowledged every linked line.
            </p>
            {jobLines.length > 0 && (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Line</th><th>Customer DC</th><th>Part</th>
                      <th className="num">Accepted</th>
                      <th className="num">Machining rejection</th>
                      <th className="num">Dispatched</th>
                      <th className="num">Delivered</th>
                      <th className="num">Outstanding</th>
                      <th className="num">Outward DCs</th>
                      <th>Job</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobLines.map(row => (
                      <tr key={row.line_no}>
                        <td className="num">{row.line_no}</td>
                        <td className="mono">{row.customer_dc_number || '—'}</td>
                        <td className="table-primary">{row.part_number}</td>
                        <td className="num">{qty(row.accepted_qty)}</td>
                        <td className="num">{qty(row.machining_rejection_qty)}</td>
                        <td className="num">{qty(row.dispatched_qty)}</td>
                        <td className="num">{qty(row.delivered_qty)}</td>
                        <td className="num strong">{qty(row.outstanding_qty)}</td>
                        <td className="num">{row.linked_dc_count}</td>
                        <td><JobStatus value={row.job_status ?? null} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}

        {doc.dc_type === 'inward' && outwardChallans.length > 0 && (
          <Card className="detail-card no-print">
            <div className="section-header"><h2>Outward challans from this one</h2></div>
            <p className="muted">
              Each of these answers this inward challan. Their numbers carry the same serial, so the
              two sit next to each other in the register: inward {doc.dc_number} is answered by an
              outward numbered after it.
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Outward DC</th><th>Date</th><th className="num">Lines</th>
                    <th className="num">Dispatched</th><th className="num">Delivered</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {outwardChallans.map(challan => (
                    <tr key={challan.dc_id}>
                      <td><Link className="table-primary" to={`/dc/outward/${challan.dc_id}`}>{challan.dc_number}</Link></td>
                      <td>{displayDate(challan.dc_date)}</td>
                      <td className="num">{challan.line_count}</td>
                      <td className="num">{qty(challan.total_dispatched)}</td>
                      <td className="num">{qty(challan.total_delivered)}</td>
                      <td><Status value={challan.dc_status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {doc.dc_type === 'outward_customer' && bundle.items.some(item => item.source_inward_item_id) && (
          <Card className="detail-card no-print">
            <div className="section-header"><h2>Against inward challans</h2></div>
            {customerDcNumbers.length > 0 && (
              <p>
                <strong>Customer DC{customerDcNumbers.length === 1 ? '' : 's'}:</strong>{' '}
                {customerDcNumbers.join(', ')}
              </p>
            )}
            <p className="muted">
              Filled in from the inward lines these lines were drawn from. Dispatch on this challan is
              capped at what is left of each inward line: accepted, less machining rejection, less
              what other outward challans have already taken.
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Line</th><th>Part</th><th>Inward DC</th><th>Inward line</th>
                    <th>Customer DC</th><th className="num">Accepted there</th>
                    <th className="num">Available here</th>
                  </tr>
                </thead>
                <tbody>
                  {bundle.items.filter(item => item.source_inward_item_id).map(item => (
                    <tr key={item.id}>
                      <td className="num">{item.line_no}</td>
                      <td className="table-primary">{item.part_number}</td>
                      <td>
                        {item.source_inward_dc_id
                          ? <Link to={`/dc/inward/${item.source_inward_dc_id}`}>{item.source_inward_dc_number}</Link>
                          : '—'}
                      </td>
                      <td className="num">{item.source_inward_line_no ?? '—'}</td>
                      <td className="mono">{item.source_inward_customer_dc_number || '—'}</td>
                      <td className="num">{qty(item.source_inward_accepted_qty ?? 0)}</td>
                      <td className="num strong">{qty(item.source_available_qty ?? 0)} {item.unit}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {panel === 'receipt' && (
          <ReceiptPanel bundle={bundle} busy={busy} organizationId={organization!.id} onCancel={() => setPanel(null)} onSubmit={values => run(() => dcApi.recordReceipt(organization!.id, values), 'Receipt recorded.')} />
        )}
        {panel === 'inspection' && (
          <InspectionPanel bundle={bundle} busy={busy} organizationId={organization!.id} onCancel={() => setPanel(null)} onSubmit={values => run(() => dcApi.recordInspection(organization!.id, values), 'Inspection recorded.')} />
        )}
        {panel === 'machining' && (
          <MachiningPanel bundle={bundle} busy={busy} organizationId={organization!.id} onCancel={() => setPanel(null)} onSubmit={values => run(() => dcApi.recordMachiningBatch(organization!.id, values), 'Machining results recorded.')} />
        )}
        {panel === 'dispatch' && (
          <DispatchPanel bundle={bundle} busy={busy} organizationId={organization!.id} onCancel={() => setPanel(null)} onSubmit={values => run(() => dcApi.recordDispatch(organization!.id, values), 'Dispatch recorded.')} />
        )}
        {panel === 'delivery' && (
          <DeliveryPanel bundle={bundle} busy={busy} organizationId={organization!.id} onCancel={() => setPanel(null)} onSubmit={values => run(() => dcApi.confirmDelivery(organization!.id, values), 'Delivery recorded.')} />
        )}

        {panel === 'cancel' && (
          <CancelPanel
            busy={busy}
            organizationId={organization!.id}
            onCancel={() => setPanel(null)}
            onSubmit={reason => run(() => dcApi.cancel(organization!.id, doc.id, reason), 'Challan cancelled and recorded in the audit trail.')}
          />
        )}

        {doc.dc_type === 'outward_customer' && !readOnly && (
          <LinkedBills dc={doc} />
        )}

        <ItemTable bundle={bundle} />
        {doc.dc_type === 'outward_customer' && <DeliverySummary bundle={bundle} />}
        <Movements bundle={bundle} />
        <InspectionHistory bundle={bundle} />
        {bundle.rejections.length > 0 && <Rejections bundle={bundle} onReturn={(rejectionId, quantity) => run(() => dcApi.recordMaterialReturn(organization!.id, { rejection_id: rejectionId, returned_qty: quantity }), 'Material return recorded.')} busy={busy} readOnly={readOnly} />}
        {bundle.machining_results.length > 0 && <MachiningResults bundle={bundle} />}
        </div>
      </div>

      <DcPaper bundle={bundle} company={company} />
    </>
  )

  async function download() {
    setBusy(true)
    try {
      const { downloadDcPdf } = await import('../lib/dc-pdf')
      await downloadDcPdf(bundle!, company, doc!.dc_number)
    } catch (cause) {
      setError(explainError(cause, 'The PDF could not be generated.'))
    } finally {
      setBusy(false)
    }
  }
}

// ---------------------------------------------------------------------------
// Bills covering this challan
//
// The link is many-to-many on purpose: a customer invoiced for a month's
// deliveries has one bill over several outward challans, and a challan paid in
// instalments has several bills. Set rather than toggle, so re-sending the same
// list is harmless.
// ---------------------------------------------------------------------------

type LinkedBill = {
  bill_id: string
  bill_number: string
  bill_date: string
  customer_name: string
  grand_total: number
  payment_status: string
}

function LinkedBills({ dc }: { dc: DcDocument }) {
  const { organization } = useAuth()
  const [attached, setAttached] = useState<LinkedBill[]>([])
  const [term, setTerm] = useState('')
  const [matches, setMatches] = useState<Array<{ id: string; bill_number: string; bill_date: string; customer_name: string; grand_total: number; payment_status: string }>>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!organization) return
    let active = true
    void settle(() => dcApi.linkedBills(organization.id, dc.id))
      .then(result => { if (active) setAttached(result.ok ? result.value : []) })
    return () => { active = false }
  }, [organization, dc.id])

  useEffect(() => {
    if (!organization || term.trim().length < 2) { setMatches([]); return }
    let active = true
    const timer = window.setTimeout(() => {
      const like = `%${term.trim().replace(/[\\%_]/g, '\\$&')}%`
      void settle(() => db.from('bills').select('id,bill_number,bill_date,customer_name,grand_total,payment_status')
        .eq('organization_id', organization.id).is('deleted_at', null)
        .eq('customer_id', dc.party_id).ilike('bill_number', like).limit(10))
        .then(result => { if (active) setMatches(result.ok && !result.value.error ? result.value.data ?? [] : []) })
    }, 250)
    return () => { active = false; window.clearTimeout(timer) }
  }, [organization, term, dc.party_id])

  async function link(billId: string) {
    if (!organization || busy) return
    setBusy(true); setError('')
    try {
      await dcApi.linkBills(organization.id, dc.id, [...attached.map(b => b.bill_id), billId])
      setAttached(await dcApi.linkedBills(organization.id, dc.id))
      setTerm(''); setMatches([])
    } catch (cause) {
      setError(explainError(cause, friendlyError(cause)))
    } finally {
      setBusy(false)
    }
  }

  async function unlink(billId: string) {
    if (!organization || busy) return
    setBusy(true); setError('')
    try {
      await dcApi.linkBills(organization.id, dc.id, attached.filter(b => b.bill_id !== billId).map(b => b.bill_id))
      setAttached(await dcApi.linkedBills(organization.id, dc.id))
    } catch (cause) {
      setError(explainError(cause, friendlyError(cause)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="detail-card no-print">
      <div className="section-header"><h2>Bills covering this challan</h2></div>
      <p className="muted">
        Linking a bill lets a bill number find this challan in search. One bill can cover several
        challans, and one challan can be billed across several bills.
      </p>
      {error && <p role="alert" className="error-box">{error}</p>}
      {attached.length > 0 ? (
        <ul className="plain-list">
          {attached.map(bill => (
            <li key={bill.bill_id}>
              <Link to={`/bills/${bill.bill_id}`}>{bill.bill_number}</Link>
              <span className="muted"> · {displayDate(bill.bill_date)} · {bill.payment_status} · ₹{Number(bill.grand_total).toFixed(2)}</span>
              <Button variant="ghost" disabled={busy} onClick={() => void unlink(bill.bill_id)} aria-label={`Remove bill ${bill.bill_number}`}>
                <Ban size={15} />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No bill is linked to this challan.</p>
      )}
      <div className="field-grid">
        <Field
          label="Attach a bill"
          value={term}
          onChange={e => setTerm(e.target.value)}
          hint="Search this customer's bills by number"
        />
      </div>
      {matches.length > 0 && (
        <ul className="plain-list">
          {matches.map(bill => (
            <li key={bill.id}>
              <strong>{bill.bill_number}</strong>
              <span className="muted"> · {displayDate(bill.bill_date)} · {bill.payment_status}</span>
              <Button variant="secondary" disabled={busy} onClick={() => void link(bill.id)}>Attach</Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Line items with their live balances
// ---------------------------------------------------------------------------

function ItemTable({ bundle }: { bundle: DcBundle }) {
  const doc = bundle.document
  const isInward = doc.dc_type === 'inward'

  return (
    <Card className="detail-card no-print">
      <div className="section-header"><h2>Line items</h2></div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>#</th><th>Part number</th><th>Customer DC</th><th>Description</th><th>Drawing</th>
              <th className="num">Declared</th>
              {isInward
                ? <><th className="num">Received</th><th className="num">Shortage</th><th className="num">Accepted</th><th className="num">Rejected</th><th>Inspection</th></>
                : <><th className="num">Ordered</th><th className="num">Dispatched</th></>}
              <th>Unit</th>
            </tr>
          </thead>
          <tbody>
            {bundle.items.map(item => (
              <tr key={item.id}>
                <td>{item.line_no}</td>
                <td className="table-primary">{item.part_number}</td>
                {/* Which of the customer's own challans this material arrived on.
                    One inward challan can carry several of theirs, so this is a
                    per-line fact and not a header field. On an outward line the
                    number comes from the inward line it was drawn from. */}
                <td className="mono">{item.customer_dc_number || item.source_inward_customer_dc_number || '—'}</td>
                <td>{item.description ?? '—'}</td>
                <td>{item.drawing_number ?? '—'}</td>
                <td className="num">{qty(item.declared_qty)}</td>
                {isInward && <>
                  <td className="num">{qty(item.received_qty)}</td>
                  <td className="num">{qty(item.shortage_qty)}</td>
                  <td className="num">{qty(item.accepted_qty)}</td>
                  <td className="num">{qty(item.rejected_qty)}</td>
                  <td>{inspectionBadge(item)}</td>
                </>}

                {doc.dc_type === 'outward_customer' && <>
                  <td className="num">{item.ordered_qty === null ? '—' : qty(item.ordered_qty)}</td>
                  <td className="num">{qty(item.qty_dispatched)}</td>
                </>}
                <td>{item.unit}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function Movements({ bundle }: { bundle: DcBundle }) {
  if (!bundle.movements.length) return null
  return (
    <Card className="detail-card no-print">
      <div className="section-header"><h2>Movement history</h2></div>
      <div className="table-scroll">
        <table>
          <thead><tr><th>When</th><th>Movement</th><th className="num">Quantity</th><th>Unit</th><th>Remarks</th></tr></thead>
          <tbody>
            {bundle.movements.map(movement => (
              <tr key={movement.id}>
                <td>{new Date(movement.moved_at).toLocaleString('en-IN')}</td>
                <td>{movement.is_reversal ? `${movement.movement_type.replaceAll('_', ' ')} (reversal)` : movement.movement_type.replaceAll('_', ' ')}</td>
                <td className="num">{qty(movement.quantity)}</td>
                <td>{movement.unit}</td>
                <td>{movement.remarks ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

/**
 * Where an inward challan has got to, derived from its lines.
 *
 * There is no "finalised" state on an inward document. A challan is finished
 * when every line has been judged, and that is a fact about the quantities
 * rather than a box somebody ticks, so it is computed and can never drift out of
 * step with the numbers underneath it.
 */
function CompletionBadge({ bundle }: { bundle: DcBundle }) {
  const state = inwardCompletion(bundle.items)
  const awaiting = bundle.items.filter(
    line => line.inspection_required && (line.pending_inspection_qty ?? 0) > 0,
  )
  const tone = state === 'complete' ? 'success' : state === 'awaiting_inspection' ? 'warning' : 'neutral'
  const label = state === 'complete'
    ? 'Fully received and inspected'
    : state === 'awaiting_inspection'
      ? `${awaiting.length} ${awaiting.length === 1 ? 'line' : 'lines'} awaiting inspection`
      : 'Receipt not recorded yet'

  return (
    <span className={`status status-${tone}`} title={awaiting.map(l => `${l.part_number}: ${qty(l.pending_inspection_qty)} pending`).join(', ')}>
      {label}
    </span>
  )
}

/**
 * The outward counterpart of CompletionBadge: how much of what was dispatched
 * the customer has actually acknowledged.
 *
 * Derived from the line quantities for the same reason inwardCompletion is -
 * the stored `status` is itself derived from these numbers by
 * `confirm_delivery`, so computing it twice from the same source is what keeps
 * the two from ever disagreeing.
 */
function OutwardBadge({ bundle }: { bundle: DcBundle }) {
  const state = outwardCompletion(bundle.items)
  const outstanding = bundle.items
    .map(line => ({ part: line.part_number, left: deliveryBalance(line.qty_dispatched, line.qty_delivered), unit: line.unit }))
    .filter(line => line.left > 0)

  const label: Record<OutwardCompletion, string> = {
    not_dispatched: 'Nothing dispatched yet',
    awaiting_delivery: 'Awaiting customer delivery',
    partially_delivered: `${qty(outstanding.reduce((sum, line) => sum + line.left, 0))} outstanding`,
    complete: 'Fully delivered',
  }

  return (
    <span
      className={`status status-${state === 'complete' ? 'success' : state === 'not_dispatched' ? 'neutral' : 'warning'}`}
      title={outstanding.map(l => `${l.part}: ${qty(l.left)} ${l.unit} not delivered`).join(', ')}
    >
      {label[state]}
    </span>
  )
}

/**
 * What the customer signed for: who took it, when, against which reference.
 *
 * Stored on the document since 0016 but rendered nowhere until now - not on the
 * screen, not on the printed challan, not in the PDF.
 */
function DeliverySummary({ bundle }: { bundle: DcBundle }) {
  const d = bundle.document
  if (!d.proof_of_delivery_ref && !d.receiver_name && !d.actual_delivery_at) return null

  return (
    <Card className="detail-card no-print">
      <div className="section-header"><h2>Delivery</h2></div>
      <div className="field-grid">
        <Field label="Proof of delivery reference" value={d.proof_of_delivery_ref ?? ''} readOnly />
        <Field label="Received by (customer)" value={d.receiver_name ?? ''} readOnly />
        <Field
          label="Delivered at"
          value={d.actual_delivery_at ? new Date(d.actual_delivery_at).toLocaleString('en-IN') : ''}
          readOnly
        />
      </div>
    </Card>
  )
}

/**
 * Every inspection recorded against the challan.
 *
 * This is the missing half of the record: dcApi has always fetched the
 * inspections, but the page used them only to decide whether the receipt button
 * was locked. Somebody could record a whole inspection and then see nothing of
 * what they had entered - no quantities, no inspector, no reason.
 *
 * Append-only by design, so a second inspection appears as a second row rather
 * than overwriting the first. That is why the running totals are not shown: the
 * line-item table already carries the current position.
 */
function InspectionHistory({ bundle }: { bundle: DcBundle }) {
  if (!bundle.inspections.length) return null
  const partOf = (itemId: string) => bundle.items.find(i => i.id === itemId)?.part_number ?? '—'

  return (
    <Card className="detail-card no-print">
      <div className="section-header"><h2>Inspection results</h2></div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>When</th><th>Part</th>
              <th className="num">Inspected</th><th className="num">Accepted</th><th className="num">Rejected</th>
              <th className="num">Rework</th><th className="num">Pending</th>
              <th>Reason</th><th>Report</th><th>Remarks</th>
            </tr>
          </thead>
          <tbody>
            {bundle.inspections.map(inspection => (
              <tr key={inspection.id}>
                <td>{new Date(inspection.inspected_at).toLocaleString('en-IN')}</td>
                <td className="table-primary">{partOf(inspection.dc_item_id)}</td>
                <td className="num">{qty(inspection.inspected_quantity)}</td>
                <td className="num">{qty(inspection.accepted_quantity)}</td>
                <td className="num">{qty(inspection.rejected_quantity)}</td>
                <td className="num">{qty(inspection.rework_quantity)}</td>
                <td className="num">{qty(inspection.pending_quantity)}</td>
                <td>{inspection.rejection_reason ?? '—'}</td>
                <td>{inspection.inspection_report_no ?? '—'}</td>
                <td>{inspection.remarks ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

type PanelProps = { busy: boolean; onCancel: () => void; organizationId: string }

/**
 * The configurable rejection reason list, shared by the two panels that can
 * record a rejection.
 *
 * The load is per-panel because only one panel is ever open at a time, but the
 * option set, its id and its failure message are the same, so they live here
 * rather than being written out twice.
 */
function useRejectionReasons(organizationId: string) {
  const [reasons, setReasons] = useState<string[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void settle(() => dcApi.options(organizationId, 'rejection_reason'))
      .then(result => {
        if (!active) return
        if (!result.ok) { setError('Rejection reasons could not be loaded. You can still type a reason.'); return }
        setReasons(result.value.map(row => row.option_value))
      })
    return () => { active = false }
  }, [organizationId])
  return { reasons, error }
}

function ReceiptPanel({ bundle, busy, organizationId, onCancel, onSubmit }: PanelProps & {
  bundle: DcBundle
  onSubmit: (values: Record<string, unknown>) => Promise<void>
}) {
  const [lines, setLines] = useState(() => bundle.items.map(item => ({
    id: item.id,
    part: item.part_number,
    declared: item.declared_qty,
    received: String(item.received_qty || ''),
    rejected: String(item.rejected_qty || 0),
    // Carried over from an existing gate rejection. Saving the receipt replaces
    // that record wholesale, so a blank field would quietly erase a reason
    // somebody had already typed in.
    //
    // "The gate rejection" means the newest one on this line that nothing has
    // been returned or scrapped against - the same rule the database's delete
    // uses before it writes the replacement. This used to test
    // quantity_inspected === 0, which was a marker 0022 wrote and 0023 had to
    // change (the table's constraint forbids it), so it stopped matching
    // anything and the reason was dropped on every reopen.
    reason: bundle.rejections
      .filter(r => r.dc_item_id === item.id && r.quantity_returned === 0 && r.quantity_scrapped === 0 && r.return_dc_id === null)
      .sort((a, b) => b.rejection_date.localeCompare(a.rejection_date))[0]?.rejection_reason ?? '',
    inspection_required: item.inspection_required,
  })))
  const [receivedBy, setReceivedBy] = useState('')
  const [unloading, setUnloading] = useState('')
  const { reasons, error: reasonError } = useRejectionReasons(organizationId)

  // A receipt is correctable right up until an inspection exists. After that the
  // database refuses the save outright (RECEIPT_AFTER_INSPECTION), because
  // overwriting a quality record is worse than making a typo expensive. Say so
  // here rather than letting someone fill in a form that cannot be sent.
  const alreadyInspected = bundle.inspections.length > 0

  /** Refusing material at the gate cannot exceed what actually arrived. */
  const setRejected = (index: number, raw: string) => {
    setLines(old => old.map((line, i) => {
      if (i !== index) return line
      const applied = Math.min(parseQty(raw), parseQty(line.received))
      return { ...line, rejected: quantityText(raw, applied) }
    }))
  }

  return (
    <Card className="dc-panel">
      <h2>Record what physically arrived</h2>
      <p className="muted">
        The quantity on the customer DC and the quantity that actually arrived are recorded separately.
        Anything refused at the gate is recorded here as rejected and can be returned or scrapped later.
        Leave inspection unchecked when nobody is going to judge this material: it is then accepted on
        arrival and the challan is complete.
      </p>
      {alreadyInspected && (
        <p className="error-box">
          This challan has already been inspected, so the received quantities can no longer be changed.
          Cancel it and raise a new one if the receipt was recorded wrongly.
        </p>
      )}
      {receiptError(lines)}
      <div className="table-scroll">
        <table>
          <thead><tr><th>Part</th><th className="num">Declared</th><th className="num">Received</th><th className="num">Shortage</th><th className="num">Excess</th><th className="num">Rejected</th><th>Reason</th><th className="num">To inspect</th><th>Inspection</th></tr></thead>
          <tbody>
            {lines.map((line, index) => {
              const split = receiptSplit(line.declared, parseQty(line.received), parseQty(line.rejected))
              const rejectedOverReceived = parseQty(line.rejected) > parseQty(line.received)
              return (
                <tr key={line.id}>
                  <td className="table-primary">{line.part}</td>
                  <td className="num">{qty(line.declared)}</td>
                  <td className="num">
                    <input
                      className="dc-qty-input"
                      value={line.received}
                      inputMode="decimal"
                      aria-label={`Received quantity for ${line.part}`}
                      onChange={e => setLines(old => old.map((l, i) => i === index ? { ...l, received: e.target.value } : l))}
                    />
                  </td>
                  <td className="num">{qty(split.shortage)}</td>
                  <td className="num">{qty(split.excess)}</td>
                  <td className="num">
                    <input
                      className={`dc-qty-input${rejectedOverReceived ? ' invalid' : ''}`}
                      value={line.rejected}
                      inputMode="decimal"
                      aria-label={`Rejected at the gate for ${line.part}`}
                      onChange={e => setRejected(index, e.target.value)}
                    />
                  </td>
                  <td>
                    <input
                      value={line.reason}
                      list="dc-receipt-rejection-reasons"
                      aria-label={`Rejection reason for ${line.part}`}
                      disabled={parseQty(line.rejected) <= 0}
                      onChange={e => setLines(old => old.map((l, i) => i === index ? { ...l, reason: e.target.value } : l))}
                    />
                  </td>
                  <td className="num">
                    {line.inspection_required ? qty(split.pending) : <span className="muted">accepted on arrival</span>}
                  </td>
                  <td>
                    <label className="inline-control">
                      <input
                        type="checkbox"
                        checked={line.inspection_required}
                        onChange={e => setLines(old => old.map((l, i) => i === index ? { ...l, inspection_required: e.target.checked } : l))}
                      />
                      Required
                    </label>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <datalist id="dc-receipt-rejection-reasons">
        {reasons.map(r => <option key={r} value={r} />)}
      </datalist>
      {reasonError && <p className="muted">{reasonError}</p>}
      <div className="field-grid">
        <Field label="Received by" value={receivedBy} onChange={e => setReceivedBy(e.target.value)} />
      </div>
      <TextArea label="Unloading remarks" value={unloading} onChange={e => setUnloading(e.target.value)} rows={2} />
      <div className="inline-actions">
        <Button disabled={busy || alreadyInspected} onClick={() => void onSubmit({
          dc_id: bundle.document.id,
          received_by: receivedBy || null,
          responsible_person: receivedBy || null,
          receipt_date: today(),
          unloading_remarks: unloading || null,
          lines: lines.map(l => ({
            dc_item_id: l.id,
            received_qty: parseQty(l.received),
            rejected_qty: parseQty(l.rejected),
            rejection_reason: parseQty(l.rejected) > 0 ? l.reason || null : null,
            inspection_required: l.inspection_required,
          })),
        })}>{busy ? 'Saving...' : 'Record receipt'}</Button>
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
    </Card>
  )
}

/**
 * The two things a receipt can get wrong that the database will refuse.
 *
 * `isNegativeQty` rather than `parseQty(x) < 0`: parseQty clamps negatives to
 * zero before it returns, so that comparison was always false and this warning
 * could never be shown.
 */
function receiptError(lines: Array<{ received: string; rejected: string }>) {
  const negative = lines.some(l => isNegativeQty(l.received) || isNegativeQty(l.rejected))
  const overRejected = lines.some(l => parseQty(l.rejected) > parseQty(l.received))
  return negative ? <p role="alert" className="error-box">Quantities cannot be negative.</p>
    : overRejected ? <p role="alert" className="error-box">You cannot reject more than you received.</p>
      : null
}function InspectionPanel({ bundle, busy, organizationId, onCancel, onSubmit }: PanelProps & {
  bundle: DcBundle
  onSubmit: (values: Record<string, unknown>) => Promise<void>
}) {
  // Only lines that still have something awaiting inspection belong here.
  //
  // The previous filter admitted any line with received_qty > 0, including lines
  // already fully inspected. Those defaulted to all-zero outcomes, and
  // record_material_inspection rejects an all-zero line outright ("each inspected
  // line must record at least one non-zero quantity"). Because that check runs
  // inside a single transaction, one such line aborted the whole submission and the
  // operator saw every other line fail as well.
  const inspectable = bundle.items.filter(
    item => item.inspection_required && item.received_qty > 0 && item.pending_inspection_qty > 0,
  )
  const fullyInspected = bundle.items.filter(
    item => item.inspection_required && item.received_qty > 0 && item.pending_inspection_qty <= 0,
  )

  type InspectionLine = {
    id: string
    part: string
    received: number
    /** Everything already judged on this line, gate rejections included. */
    judged: { accepted: number; rejected: number; rework: number }
    accepted: string
    rejected: string
    rework: string
    pending: string
    reason: string
    report: string
  }

  const [responsible, setResponsible] = useState('')
  const [lines, setLines] = useState<InspectionLine[]>(() => inspectable.map(item => ({
    id: item.id,
    part: item.part_number,
    received: item.received_qty,
    judged: { accepted: item.accepted_qty, rejected: item.rejected_qty, rework: item.rework_qty },
    // Everything still awaiting inspection is offered as accepted, which is what
    // this form has always done and is the right default for clean material.
    // The balance below is what the four fields must add up to, and it is
    // measured against the received quantity less everything judged so far -
    // NOT against pending_inspection_qty, which is a stored remainder rather
    // than the authority on what is left. When the two disagree the form used to
    // pre-fill a figure the database would refuse.
    accepted: String(item.pending_inspection_qty || 0),
    rejected: '0',
    rework: '0',
    pending: '0',
    reason: '',
    report: '',
  })))
  const { reasons, error: reasonError } = useRejectionReasons(organizationId)

  const balanceOf = (line: InspectionLine) => inspectionBalance(line.received, line.judged)
  const outcomeOf = (line: InspectionLine): InspectionOutcome => ({
    accepted: parseQty(line.accepted),
    rejected: parseQty(line.rejected),
    rework: parseQty(line.rework),
    pending: parseQty(line.pending),
  })
  const isBalanced = (line: InspectionLine) =>
    Math.abs(outcomeTotal(outcomeOf(line)) - balanceOf(line)) < 0.0005
  const asFields = (outcome: InspectionOutcome): Record<InspectionKey, string> => ({
    accepted: String(outcome.accepted),
    rejected: String(outcome.rejected),
    rework: String(outcome.rework),
    pending: String(outcome.pending),
  })

  /**
   * Editing any one outcome rebalances the other three around it.
   *
   * The edited field keeps the operator's own text; everything else is derived.
   * Accepted + rejected + rework + pending therefore always equals the quantity
   * still to be inspected, which is what the database now requires - an
   * unbalanced sum can no longer be submitted at all.
   */
  const editOutcome = (target: number, key: InspectionKey, raw: string) => {
    setLines(old => old.map((line, index) => {
      if (index !== target) return line
      const balanced = balanceInspectionOutcome(outcomeOf(line), key, raw, balanceOf(line))
      return { ...line, ...asFields(balanced), [key]: quantityText(raw, balanced[key]) }
    }))
  }

  const unbalanced = lines.filter(line => !isBalanced(line))

  return (
    <Card className="dc-panel">
      <h2>Record the inspection result</h2>
      <p className="muted">
        Accepted, rejected, rework and pending always add up to the quantity still to be inspected.
        Change any one of them and the rest rebalance themselves. Only accepted material becomes
        available for processing or dispatch.
      </p>
      {inspectable.length === 0 && lines.length === 0 ? (
        <EmptyState
          title="Nothing awaiting inspection"
          description="Record a receipt first, or mark inspection as not required for this challan."
        />
      ) : (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Part</th><th className="num">Received</th><th className="num">To inspect</th><th className="num">Accepted</th><th className="num">Rejected</th><th className="num">Rework</th><th className="num">Pending</th><th>Reason</th></tr></thead>
            <tbody>
              {lines.map((line, index) => {
                const balance = balanceOf(line)
                const total = outcomeTotal(outcomeOf(line))
                return (
                  <tr key={line.id}>
                    <td className="table-primary">{line.part}</td>
                    <td className="num">{qty(line.received)}</td>
                    <td className="num">
                      {qty(balance)}
                      <div className="dc-hint">{isBalanced(line) ? `sum ${qty(total)}` : `sum ${qty(total)} of ${qty(balance)}`}</div>
                    </td>
                    {INSPECTION_KEYS.map(key => (
                      <td key={key} className="num">
                        <input
                          className="dc-qty-input"
                          value={line[key]}
                          inputMode="decimal"
                          aria-label={`${key} quantity for ${line.part}`}
                          onChange={e => editOutcome(index, key, e.target.value)}
                        />
                      </td>
                    ))}
                    <td>
                      <input
                        value={line.reason}
                        list="dc-rejection-reasons"
                        aria-label={`Rejection reason for ${line.part}`}
                        onChange={e => setLines(old => old.map((l, i) => i === index ? { ...l, reason: e.target.value } : l))}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {fullyInspected.length > 0 && (
        <p className="muted">
          {fullyInspected.length === 1 ? 'One line is' : `${fullyInspected.length} lines are`} already fully
          inspected and {fullyInspected.length === 1 ? 'is' : 'are'} left out of this form. Recording them again
          would be refused by the database.
        </p>
      )}
      {reasonError && <p className="muted">{reasonError}</p>}
      {unbalanced.length > 0 && (
        <p className="error-box">
          {unbalanced.length === 1 ? 'One line does' : `${unbalanced.length} lines do`} not add up to the
          quantity still to be inspected: {unbalanced.map(line => `${line.part} ${qty(outcomeTotal(outcomeOf(line)))} of ${qty(balanceOf(line))}`).join(', ')}.
        </p>
      )}
      <datalist id="dc-rejection-reasons">
        {reasons.map(r => <option key={r} value={r} />)}
      </datalist>
      <div className="field-grid">
        <Field label="Inspected by / responsible person" value={responsible} onChange={e => setResponsible(e.target.value)} />
      </div>
      <div className="inline-actions">
        <Button
          disabled={busy || lines.length === 0 || unbalanced.length > 0}
          onClick={() => void onSubmit({
            dc_id: bundle.document.id,
            responsible_person: responsible || null,
            inspection_date: today(),
            lines: lines.map(l => ({
              dc_item_id: l.id,
              accepted_qty: parseQty(l.accepted),
              rejected_qty: parseQty(l.rejected),
              rework_qty: parseQty(l.rework),
              pending_qty: parseQty(l.pending),
              rejection_reason: l.reason || null,
              disposition: parseQty(l.rejected) > 0 ? 'hold_for_decision' : null,
            })),
          })}
        >{busy ? 'Saving...' : 'Record inspection'}</Button>
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function DispatchPanel({ bundle, busy, onCancel, onSubmit }: PanelProps & {
  bundle: DcBundle
  onSubmit: (values: Record<string, unknown>) => Promise<void>
}) {
  // Default to what is still to be dispatched on this challan, not the declared
  // figure. Defaulting to the declared quantity meant a second dispatch against
  // the same challan offered to send everything again.
  const [lines, setLines] = useState(() => bundle.items.map(item => ({
    id: item.id,
    part: item.part_number,
    unit: item.unit,
    dispatched: String(qty(Math.max(0, item.declared_qty - item.qty_dispatched)) || ''),
  })))
  const [vehicle, setVehicle] = useState(bundle.document.vehicle_number ?? '')
  const [transporter, setTransporter] = useState(bundle.document.transporter_name ?? '')
  const [lr, setLr] = useState(bundle.document.lr_number ?? '')
  const [eway, setEway] = useState(bundle.document.eway_bill_number ?? '')
  const [pod, setPod] = useState(bundle.document.proof_of_delivery_ref ?? '')

  return (
    <Card className="dc-panel">
      <h2>Dispatch to the customer</h2>
      <p className="muted">
        The database refuses a dispatch larger than the eligible balance for this customer and part,
        and refuses two people consuming the same quantity at once.
      </p>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Part</th><th>Unit</th><th className="num">Declared on this DC</th><th className="num">Dispatching now</th></tr></thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={line.id}>
                <td className="table-primary">{line.part}</td>
                <td>{line.unit}</td>
                <td className="num">{qty(bundle.items[index]?.declared_qty)}</td>
                <td className="num">
                  <input
                    className="dc-qty-input"
                    value={line.dispatched}
                    inputMode="decimal"
                    aria-label={`Dispatching quantity for ${line.part}`}
                    onChange={e => setLines(old => old.map((l, i) => i === index ? { ...l, dispatched: e.target.value } : l))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="field-grid">
        <Field label="Vehicle number" value={vehicle} onChange={e => setVehicle(e.target.value)} />
        <Field label="Transporter" value={transporter} onChange={e => setTransporter(e.target.value)} />
        <Field label="LR / docket" value={lr} onChange={e => setLr(e.target.value)} />
        <Field label="E-way bill" value={eway} onChange={e => setEway(e.target.value)} />
        {/* 120 characters, because that is what the database accepts. The field
            is not left to find out at the save. */}
        <Field label="Proof of delivery reference" maxLength={120} value={pod} onChange={e => setPod(e.target.value)} hint="Saved on the challan. Required when the delivery is finally confirmed." />
      </div>
      <div className="inline-actions">
        <Button
          disabled={busy}
          onClick={() => void onSubmit({
            dc_id: bundle.document.id,
            vehicle_number: vehicle || null,
            transporter_name: transporter || null,
            lr_number: lr || null,
            eway_bill_number: eway || null,
            proof_of_delivery_ref: pod || null,
            lines: lines.map(l => ({ dc_item_id: l.id, dispatched_qty: parseQty(l.dispatched) })),
          })}
        >{busy ? 'Saving...' : 'Record dispatch'}</Button>
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
    </Card>
  )
}

/**
 * Recording what the customer actually took.
 *
 * Dispatch is the truck leaving; this is the gate at the other end. Without it
 * a challan could never leave `dispatched`, and the "pending customer delivery"
 * report could only ever grow.
 *
 * Each line defaults to its outstanding balance, so confirming the whole
 * challan is the default action and a part-delivery is one edit away. The
 * database re-checks every figure against what is still outstanding and refuses
 * anything larger, so the numbers here are a convenience rather than the
 * authority.
 */
function DeliveryPanel({ bundle, busy, onCancel, onSubmit }: PanelProps & {
  bundle: DcBundle
  onSubmit: (values: Record<string, unknown>) => Promise<void>
}) {
  const [lines, setLines] = useState(() => bundle.items.map(item => {
    const outstanding = deliveryBalance(item.qty_dispatched, item.qty_delivered)
    return {
      id: item.id,
      part: item.part_number,
      unit: item.unit,
      dispatched: item.qty_dispatched,
      alreadyDelivered: item.qty_delivered,
      // The cap is a fact about the challan: what was dispatched and not yet
      // acknowledged. It does not move as the operator types.
      outstanding,
      // A line with nothing outstanding is left blank rather than zero-filled:
      // it cannot be delivered again, and dc_movements refuses quantity = 0.
      delivering: outstanding > 0 ? String(qty(outstanding)) : '',
    }
  }))
  const [pod, setPod] = useState(bundle.document.proof_of_delivery_ref ?? '')
  const [receiver, setReceiver] = useState(bundle.document.receiver_name ?? '')
  const [when, setWhen] = useState(localDateTime())

  // Each line is measured against the outstanding it had when the panel opened,
  // not against a figure derived from what is being typed. The earlier version
  // recomputed the outstanding as `dispatched - what was typed`, so entering the
  // full 4950 of a 4950 line calculated an outstanding of zero and refused the
  // delivery with "0 NOS left" - and entering half of it was accepted, and
  // labelled as closing the challan.
  const live = lines.map(line => ({
    ...line,
    preview: deliveryPreview({ dispatched: line.dispatched, delivered: line.alreadyDelivered, entering: parseQty(line.delivering) }),
  }))
  const anyToDeliver = live.some(line => line.preview.entering > 0)
  const over = live.filter(line => line.preview.over)
  // The challan closes when every line with something outstanding has had all of
  // it acknowledged, and nothing is over.
  const closesChallan = deliveryClosesChallan(live.map(line => line.preview))
  // Proof of delivery is required by the database whenever the challan closes.
  // It is optional for a part-delivery, which leaves the rest outstanding.
  const podRequired = closesChallan

  return (
    <Card className="dc-panel">
      <h2>Confirm delivery</h2>
      <p className="muted">
        Enter what the customer took. Recording less than was dispatched leaves the challan partially
        delivered, and the rest stays outstanding for the next delivery; recording all of it closes the
        challan as delivered.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Part</th><th>Unit</th>
              <th className="num">Dispatched</th><th className="num">Already delivered</th>
              <th className="num">Outstanding</th><th className="num">Delivering now</th>
              <th className="num">Left after this</th>
            </tr>
          </thead>
          <tbody>
            {live.map((line, index) => {
              const row = lines[index]
              if (!row) return null
              return (
              <tr key={line.id}>
                <td className="table-primary">{line.part}</td>
                <td>{line.unit}</td>
                <td className="num">{qty(line.dispatched)}</td>
                <td className="num">{qty(line.alreadyDelivered)}</td>
                <td className="num">{qty(line.preview.outstanding)}</td>
                <td className="num">
                  <input
                    className="dc-qty-input"
                    value={row.delivering}
                    inputMode="decimal"
                    disabled={parseQty(row.delivering) <= 0 && line.preview.outstanding <= 0}
                    aria-label={`Quantity delivered now for ${line.part}`}
                    onChange={e => {
                      setLines(old => old.map((l, i) => i === index ? { ...l, delivering: e.target.value } : l))
                    }}
                  />
                </td>
                <td className="num">{qty(line.preview.left)}</td>
              </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {over.length > 0 && (
        <p className="error-box">
          More entered than is outstanding on{' '}
          {over.map(line => `${line.part} (${qty(line.preview.outstanding)} ${line.unit} left)`).join(', ')}.
        </p>
      )}
      <div className="field-grid">
        <Field
          label="Proof of delivery reference"
          maxLength={120}
          value={pod}
          onChange={e => setPod(e.target.value)}
          hint={podRequired ? 'Required to close this challan as delivered.' : 'Optional for a part-delivery.'}
        />
        <Field label="Received by (customer)" maxLength={120} value={receiver} onChange={e => setReceiver(e.target.value)} />
        <Field label="Delivered at" type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} />
      </div>
      <div className="inline-actions">
        <Button
          disabled={busy || !anyToDeliver || over.length > 0 || (podRequired && pod.trim() === '')}
          onClick={() => void onSubmit({
            dc_id: bundle.document.id,
            // Whether this delivery closes the challan. The database reads the
            // key as true when it is absent, so leaving it out made the
            // reference compulsory on every delivery - including a part
            // delivery, which the panel told the operator was optional and
            // which the panel let them save without one. Sending the flag
            // says what the panel means.
            //
            // It cannot be used to skip the reference on a closing delivery:
            // the database refuses to close a challan without one on the
            // strength of the quantities alone (0025), so `false` here only
            // ever means "this is a part-delivery".
            delivered: closesChallan,
            proof_of_delivery_ref: pod.trim() || null,
            receiver_name: receiver.trim() || null,
            delivered_at: when ? new Date(when).toISOString() : null,
            lines: lines.map(l => ({ dc_item_id: l.id, delivered_qty: parseQty(l.delivering) })),
          })}
        >{busy ? 'Saving...' : closesChallan ? 'Confirm and close challan' : 'Record part-delivery'}</Button>
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
    </Card>
  )
}

function MachiningPanel({ bundle, busy, organizationId, onCancel, onSubmit }: PanelProps & {
  bundle: DcBundle
  onSubmit: (values: Record<string, unknown>) => Promise<void>
}) {
  const doc = bundle.document

  // Only lines linked to an inward line need machining results. Unlinked
  // finished-stock lines are not job work and are out of scope here.
  const jobLines = bundle.items.filter(item => item.source_inward_item_id !== null)
  const coveredIds = new Set(
    bundle.machining_results.map(r => r.source_dc_item_id).filter((id): id is string => Boolean(id)),
  )

  // How much of each line is still to be machined, derived by the database:
  // accepted quantity less everything already machined against that line.
  const [unmachined, setUnmachined] = useState<Record<string, number | null>>({})
  const [unmachinedReady, setUnmachinedReady] = useState(false)

  useEffect(() => {
    if (!organizationId || jobLines.length === 0 || unmachinedReady) return
    let active = true
    Promise.all(jobLines.map(item =>
      settle(() => dcApi.inwardLineUnmachined(organizationId, item.source_inward_item_id!))
        .then(result => ({ itemId: item.id, value: result.ok ? result.value : null })),
    )).then(results => {
      if (!active) return
      const next: Record<string, number | null> = {}
      for (const r of results) next[r.itemId] = r.value
      setUnmachined(next)
      setUnmachinedReady(true)
    })
    return () => { active = false }
  }, [organizationId, jobLines.length, unmachinedReady])

  /**
   * Quantity fields are per-line (different parts machine different amounts);
   * metadata fields are form-level (the same operation, date, operator and
   * inspector apply to every line in the batch, which is the ordinary case and
   * keeps the table compact).
   */
  type QuantityLine = {
    id: string
    line_no: number
    part: string
    unit: string
    material_owner_id: string
    input: number
    covered: boolean
    accepted: string
    rejection: string
    rework: string
    scrap: string
    loss: string
  }

  const [lines, setLines] = useState<QuantityLine[]>(() => jobLines.map(item => ({
    id: item.id,
    line_no: item.line_no,
    part: item.part_number,
    unit: item.unit,
    material_owner_id: item.material_owner_id ?? doc.party_id,
    input: item.source_inward_accepted_qty ?? 0,
    covered: coveredIds.has(item.id),
    accepted: '',
    rejection: '0',
    rework: '0',
    scrap: '0',
    loss: '0',
  })))

  // Fill in the database-derived input quantity once it loads.
  useEffect(() => {
    if (!unmachinedReady || Object.keys(unmachined).length === 0) return
    setLines(old => old.map(line => ({
      ...line,
      input: unmachined[line.id] ?? line.input,
    })))
  }, [unmachined, unmachinedReady])

  // Form-level metadata shared by every line in the batch.
  const [operation, setOperation] = useState('CNC Turning')
  const [operationDate, setOperationDate] = useState(today())
  const [outputUnit, setOutputUnit] = useState(jobLines[0]?.unit ?? 'NOS')
  const [unitConversion, setUnitConversion] = useState(false)
  const [operatorName, setOperatorName] = useState('')
  const [inspectorName, setInspectorName] = useState('')
  const [rejectionReason, setRejectionReason] = useState('')
  const [remarks, setRemarks] = useState('')

  const remainingOf = (line: QuantityLine) => {
    const accounted = parseQty(line.accepted) + parseQty(line.rejection) + parseQty(line.rework) + parseQty(line.scrap) + parseQty(line.loss)
    return Math.max(0, line.input - accounted)
  }
  const isOver = (line: QuantityLine) => {
    const accounted = parseQty(line.accepted) + parseQty(line.rejection) + parseQty(line.rework) + parseQty(line.scrap) + parseQty(line.loss)
    return line.input - accounted < -0.0005
  }

  // Loss fields are only relevant when any line carries a process loss.
  const pendingQuantityLines = lines.filter(l => !l.covered)
  const anyLoss = pendingQuantityLines.some(l => parseQty(l.loss) > 0)
  const [lossReason, setLossReason] = useState('')
  const [lossApprovedBy, setLossApprovedBy] = useState('')

  const errorFor = (line: QuantityLine) => {
    if (line.covered) return null
    if (line.input <= 0) return 'No material left to machine on this line.'
    if (isOver(line)) return 'Accounts for more than the input quantity.'
    if (parseQty(line.loss) > 0 && (!lossReason.trim() || !lossApprovedBy.trim()))
      return 'Process loss needs a recorded reason and an approver.'
    return null
  }

  const allCovered = pendingQuantityLines.length === 0
  const hasErrors = pendingQuantityLines.some(l => errorFor(l))

  const updateQuantity = (index: number, key: 'accepted' | 'rejection' | 'rework' | 'scrap' | 'loss', value: string) => {
    setLines(old => old.map((line, i) => i === index ? { ...line, [key]: value } : line))
  }

  if (jobLines.length === 0) {
    return (
      <Card className="dc-panel">
        <h2>Record a machining / processing result</h2>
        <EmptyState
          title="No job-work lines on this challan"
          description="Every line on this outward DC is finished stock with no inward line behind it, so there is nothing to machine."
        />
        <div className="inline-actions">
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        </div>
      </Card>
    )
  }

  return (
    <Card className="dc-panel">
      <h2>Record a machining / processing result</h2>
      <p className="muted">
        Every job-work line on this challan needs a machining result before the batch can be saved.
        The input is what is still to be machined on each line; finished machining, rejection, rework,
        scrap and authorised loss are subtracted from it, and whatever is left is the remaining
        quantity. Fill in every line below, then submit once - no line is left behind.
      </p>

      {allCovered && (
        <p className="success-box">
          Every job-work line on this challan already has a machining result. Nothing left to record.
        </p>
      )}

      {!allCovered && (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Line</th><th className="num">Input</th>
                  <th className="num">Finished</th><th className="num">Rejection</th>
                  <th className="num">Rework</th><th className="num">Scrap</th>
                  <th className="num">Loss</th><th className="num">Remaining</th><th className="num">Status</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => {
                  const err = errorFor(line)
                  const remaining = remainingOf(line)
                  return (
                    <tr key={line.id}>
                      <td>
                        {line.covered
                          ? `Line ${line.line_no}`
                          : <strong>Line {line.line_no}</strong>}
                        <br />
                        <span className="muted">{line.part}</span>
                      </td>
                      <td className="num">{qty(line.input)} {line.unit}</td>
                      <td className="num">
                        <input
                          className="dc-qty-input"
                          value={line.accepted}
                          onChange={e => updateQuantity(index, 'accepted', e.target.value)}
                          disabled={line.covered || busy}
                        />
                      </td>
                      <td className="num">
                        <input
                          className={`dc-qty-input${err ? ' invalid' : ''}`}
                          value={line.rejection}
                          onChange={e => updateQuantity(index, 'rejection', e.target.value)}
                          disabled={line.covered || busy}
                        />
                      </td>
                      <td className="num">
                        <input
                          className="dc-qty-input"
                          value={line.rework}
                          onChange={e => updateQuantity(index, 'rework', e.target.value)}
                          disabled={line.covered || busy}
                        />
                      </td>
                      <td className="num">
                        <input
                          className="dc-qty-input"
                          value={line.scrap}
                          onChange={e => updateQuantity(index, 'scrap', e.target.value)}
                          disabled={line.covered || busy}
                        />
                      </td>
                      <td className="num">
                        <input
                          className="dc-qty-input"
                          value={line.loss}
                          onChange={e => updateQuantity(index, 'loss', e.target.value)}
                          disabled={line.covered || busy}
                        />
                      </td>
                      <td className="num" style={{ fontWeight: 600, color: remaining > 0 ? '#117b6c' : '#78928e' }}>
                        {qty(remaining)} {line.unit}
                      </td>
                      <td className="num">
                        {line.covered
                          ? <Status value="covered" label="Recorded" tone="success" />
                          : err
                            ? <span className="muted" style={{ color: '#a4372f', fontSize: '11px' }}>{err}</span>
                            : <span className="muted">Pending</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Form-level metadata shared by every line in the batch */}
          <div className="field-grid">
            <Field label="Operation" value={operation} onChange={e => setOperation(e.target.value)} disabled={busy} />
            <Field label="Operation date" type="date" value={operationDate} onChange={e => setOperationDate(e.target.value)} disabled={busy} />
            <Field label="Output unit" value={outputUnit} onChange={e => setOutputUnit(e.target.value)} disabled={busy} />
            <Field label="Operator" value={operatorName} onChange={e => setOperatorName(e.target.value)} disabled={busy} />
            <Field label="Inspector" value={inspectorName} onChange={e => setInspectorName(e.target.value)} disabled={busy} />
          </div>

          <label className="inline-control">
            <input type="checkbox" checked={unitConversion} onChange={e => setUnitConversion(e.target.checked)} disabled={busy} />
            This process converts units (e.g. raw weight to finished pieces) - do not apply the input/output equation
          </label>

          {anyLoss && (
            <div className="field-grid">
              <Field label="Loss reason" value={lossReason} onChange={e => setLossReason(e.target.value)} disabled={busy} required />
              <Field label="Approved by (user id)" value={lossApprovedBy} onChange={e => setLossApprovedBy(e.target.value)} disabled={busy} hint="Recorded in the audit trail" />
            </div>
          )}

          <Field label="Rejection reason" value={rejectionReason} onChange={e => setRejectionReason(e.target.value)} disabled={busy} />
          <TextArea label="Remarks" value={remarks} onChange={e => setRemarks(e.target.value)} disabled={busy} rows={2} />

          {hasErrors && (
            <p role="alert" className="error-box">
              Fix the lines marked above before recording. Each line must reconcile with its input
              quantity, and any process loss needs a reason and an approver.
            </p>
          )}

          <div className="inline-actions">
            <Button
              disabled={busy || !pendingQuantityLines.length || hasErrors}
              onClick={() => void onSubmit({
                dc_id: doc.id,
                lines: pendingQuantityLines.map(line => ({
                  dc_item_id: line.id,
                  party_id: doc.party_id,
                  material_owner_id: line.material_owner_id,
                  part_number: line.part,
                  operation: operation || 'CNC Turning',
                  operation_date: operationDate,
                  input_quantity: line.input,
                  input_unit: line.unit,
                  output_unit: outputUnit,
                  unit_conversion: unitConversion,
                  accepted_output_quantity: parseQty(line.accepted),
                  machining_rejection_quantity: parseQty(line.rejection),
                  rework_quantity: parseQty(line.rework),
                  scrap_quantity: parseQty(line.scrap),
                  process_loss_quantity: parseQty(line.loss),
                  remaining_quantity: remainingOf(line),
                  loss_reason: anyLoss ? (lossReason || null) : null,
                  loss_approved_by: anyLoss ? (lossApprovedBy || null) : null,
                  rejection_reason: rejectionReason || null,
                  operator_name: operatorName || null,
                  inspector_name: inspectorName || null,
                  remarks: remarks || null,
                })),
              })}
            >
              {busy ? 'Saving...' : 'Record machining result'}
            </Button>
            <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          </div>

          <p className="muted">
            {pendingQuantityLines.length} of {jobLines.length} job-work line{jobLines.length === 1 ? '' : 's'} still need a result.
          </p>
        </>
      )}
    </Card>
  )
}

function CancelPanel({ busy, onCancel, onSubmit }: PanelProps & {
  onSubmit: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  return (
    <Card className="dc-panel">
      <h2>Cancel this challan</h2>
      <p className="muted">
        Cancelling never deletes the document. It records the reason, stops it counting as a completed
        dispatch, and writes an entry to the audit trail. Cancelling a challan that has already moved
        material requires an administrator.
      </p>
      <TextArea label="Reason" value={reason} onChange={e => setReason(e.target.value)} rows={2} required />
      <div className="inline-actions">
        <Button variant="danger" disabled={busy || !reason.trim()} onClick={() => void onSubmit(reason.trim())}>
          {busy ? 'Cancelling...' : 'Confirm cancellation'}
        </Button>
        <Button variant="secondary" onClick={onCancel}>Keep it open</Button>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------------------

function Rejections({ bundle, onReturn, busy, readOnly }: {
  bundle: DcBundle
  onReturn: (rejectionId: string, quantity: number) => void
  busy: boolean
  readOnly: boolean
}) {
  const [selected, setSelected] = useState<string>('')
  const [quantity, setQuantity] = useState('')

  return (
    <Card className="no-print">
      <div className="section-header"><h2>Material rejections</h2></div>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Date</th><th>Part</th><th className="num">Rejected</th><th className="num">Returned</th><th className="num">Scrapped</th><th className="num">Still pending return</th><th>Reason</th><th>Disposition</th><th>Status</th></tr></thead>
          <tbody>
            {bundle.rejections.map(rejection => (
              <tr key={rejection.id}>
                <td>{displayDate(rejection.rejection_date)}</td>
                <td className="table-primary">{rejection.part_number}</td>
                <td className="num">{qty(rejection.quantity_rejected)}</td>
                <td className="num">{qty(rejection.quantity_returned)}</td>
                <td className="num">{qty(rejection.quantity_scrapped)}</td>
                <td className="num">
                  {qty(pendingReturn(rejection.quantity_rejected, rejection.quantity_returned, rejection.quantity_scrapped))}
                </td>
                <td>{rejection.rejection_reason ?? '—'}</td>
                <td>{DISPOSITION_LABEL[rejection.disposition] ?? rejection.disposition}</td>
                <td><Status value={rejection.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">
        Material refused at the gate and material rejected at inspection are separate records, so a
        part can appear here more than once. Return material against the record it belongs to.
      </p>
      {bundle.rejections.some(r => pendingReturn(r.quantity_rejected, r.quantity_returned, r.quantity_scrapped) > 0) && !readOnly && (
        <div className="dc-return-row">
          <SelectField
            label="Return rejected material"
            value={selected}
            onChange={e => setSelected(e.target.value)}
          >
            <option value="">Choose a rejection</option>
              {bundle.rejections
              .filter(r => pendingReturn(r.quantity_rejected, r.quantity_returned, r.quantity_scrapped) > 0)
              .map(r => (
                <option key={r.id} value={r.id}>
                  {r.part_number} — {qty(pendingReturn(r.quantity_rejected, r.quantity_returned, r.quantity_scrapped))} pending
                  {' · '}{displayDate(r.rejection_date)}{r.rejection_reason ? ` · ${r.rejection_reason}` : ''}
                </option>
              ))}
          </SelectField>
          <Field label="Quantity returned" type="number" min="0" step="0.001" value={quantity} onChange={e => setQuantity(e.target.value)} />
          <Button
            disabled={busy || !selected || parseQty(quantity) <= 0}
            onClick={() => { onReturn(selected, parseQty(quantity)); setSelected(''); setQuantity('') }}
          >Generate return DC</Button>
        </div>
      )}
    </Card>
  )
}

function MachiningResults({ bundle }: { bundle: DcBundle }) {
  const lineByItemId = useMemo(() => {
    const m = new Map<string, number>()
    for (const item of bundle.items ?? []) m.set(item.id, item.line_no)
    return m
  }, [bundle.items])
  return (
    <Card className="no-print">
      <div className="section-header"><h2>Machining and processing results</h2></div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr><th>Line</th><th>Date</th><th>Part</th><th>Operation</th><th className="num">Input</th><th className="num">Finished machining</th>
              <th className="num">Rejection</th><th className="num">Rework</th><th className="num">Scrap</th>
              <th className="num">Loss</th><th className="num">Remaining</th></tr>
          </thead>
          <tbody>
            {bundle.machining_results.map(result => (
              <tr key={result.id}>
                <td className="mono">{lineByItemId.get(result.source_dc_item_id ?? '') ?? '—'}</td>
                <td>{displayDate(result.operation_date)}</td>
                <td className="table-primary">{result.part_number}</td>
                <td>{result.operation}</td>
                <td className="num">{qty(result.input_quantity)} {result.input_unit}</td>
                <td className="num">{qty(result.accepted_output_quantity)} {result.output_unit}</td>
                <td className="num">{qty(result.machining_rejection_quantity)}</td>
                <td className="num">{qty(result.rework_quantity)}</td>
                <td className="num">{qty(result.scrap_quantity)}</td>
                <td className="num">{qty(result.process_loss_quantity)}</td>
                <td className="num">{qty(result.remaining_quantity)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

/** Re-exported so the router can import one symbol for the whole module. */
export type { DcItem }
