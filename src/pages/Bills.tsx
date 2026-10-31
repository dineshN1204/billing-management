import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Ban, Download, Plus, Printer, RotateCw, ZoomIn, ZoomOut } from 'lucide-react'
import { Button, Card, EmptyState, Loading, PageTitle, Pagination, Status, TextArea } from '../components/ui'
import { DocumentPicker } from '../components/DocumentPicker'
import { BillPaper } from '../components/BillPaper'
import { useAuth } from '../lib/auth'
import { signedDocumentUrl, uploadDocument } from '../lib/documents'
import { displayDate, explainError, friendlyError, money } from '../lib/format'
import { billRemaining } from '../lib/calculations'
import { db } from '../lib/db'
import { dcApi } from '../lib/dc-api'
import { qty } from '../lib/dc-quantities'
import { challanPath } from '../lib/navigation'
import { firstError, settleAll } from '../lib/async'
import { billReferences } from '../lib/bill-references'
import type { BillChallanSummary } from '../lib/dc-types'
import type { Attachment, Bill, BillItem } from '../lib/types'

export function Bills() {
  const { organization } = useAuth()
  const [rows, setRows] = useState<Bill[]>([])
  const [search, setSearch] = useState('')
  const [fy, setFy] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  /**
   * Cancelled bills remain on record and stay readable to administrators
   * through the bills_select policy (deleted_at is null OR is_org_admin), so
   * this toggle lists them to an admin with the reason they were cancelled and
   * a restore button. Staff and viewers cannot read them - the policy refuses -
   * which is why the toggle itself is admin-only rather than merely hidden.
   */
  const [cancelled, setCancelled] = useState(false)
  const [restoringId, setRestoringId] = useState('')
  useEffect(() => { setPage(1) }, [search, status, fy, cancelled])
  useEffect(() => {
    if (!organization) return
    let active = true
    const timer = window.setTimeout(async () => {
      setLoading(true)
      const trimmed = search.trim()
      let query = db.from('bills').select('*', { count: 'exact' }).eq('organization_id', organization.id)
      if (cancelled) query = query.not('deleted_at', 'is', null)
      else query = query.is('deleted_at', null)
      if (trimmed) {
        const escaped = trimmed.replace(/[\\%_]/g, '\\$&')
        // A customer DC number identifies a bill only through the challans it
        // pays for, so the term is matched against the bill number OR against
        // the ids of bills reached that way. Without the second half, typing the
        // number printed on the customer's own challan into the bill list found
        // nothing even though the bill was linked to it.
        //
        // The same is true of our own challan number: the bill and the
        // challan it pays for are the same job and carry the same serial, so
        // the number on the challan finds the bill.
        const [byCustomerDc, byOurDc] = await Promise.all([
          dcApi.billsForCustomerDc(organization.id, trimmed).catch(() => []),
          dcApi.billsForDcNumber(organization.id, trimmed).catch(() => []),
        ])
        const ids = [...new Set([...byCustomerDc, ...byOurDc].map(match => match.bill_id))]
        query = ids.length
          ? query.or(`bill_number.ilike.%${escaped}%,id.in.(${ids.join(',')})`)
          : query.ilike('bill_number', `%${escaped}%`)
      }
      if (status) query = query.eq('payment_status', status as Bill['payment_status'])
      if (/^\d{4}-\d{2}$/.test(fy)) { const year = Number(fy.slice(0, 4)); query = query.gte('bill_date', `${year}-04-01`).lte('bill_date', `${year + 1}-03-31`) }
      const { data, count: total, error: queryError } = await query.order('bill_date', { ascending: false }).range((page - 1) * 20, page * 20 - 1)
      if (active) { setRows((data ?? []) as Bill[]); setCount(total ?? 0); setError(queryError ? friendlyError(queryError) : ''); setLoading(false) }
    }, search ? 250 : 0)
    return () => { active = false; window.clearTimeout(timer) }
  }, [organization, search, status, fy, page, cancelled])
  /**
   * Putting a cancelled bill back on the books. The RPC clears both the
   * deletion and the reason with it, bumps the version, and the bill
   * immediately re-joins every surface it belongs to; here it just has to leave
   * this view, so the row is dropped locally instead of refetching.
   */
  async function restore(id: string) {
    setRestoringId(id); setError('')
    try {
      const { error: rpcError } = await db.rpc('restore_bill', { target_bill_id: id })
      if (rpcError) throw rpcError
      setRows(old => old.filter(b => b.id !== id))
      setCount(total => Math.max(0, total - 1))
    } catch (cause) {
      setError(friendlyError(cause))
    } finally {
      setRestoringId('')
    }
  }
  const year = new Date().getFullYear()
  return <><PageTitle eyebrow="FINANCIAL RECORDS" title="Bills" description="Every invoice, searchable and linked to its customer." action={organization?.role !== 'viewer' && <Link className="button button-primary" to="/bills/new"><Plus size={17} /> New bill</Link>} /><Card><div className="table-toolbar"><input aria-label="Search bills" placeholder="Search bill number or customer DC..." value={search} onChange={e => setSearch(e.target.value)} /><select aria-label="Financial year" value={fy} onChange={e => setFy(e.target.value)}><option value="">All financial years</option>{Array.from({ length: 8 }, (_, i) => year + 1 - i).map(y => <option value={`${y}-${String((y + 1) % 100).padStart(2, '0')}`} key={y}>{y}-{String((y + 1) % 100).padStart(2, '0')}</option>)}</select><select aria-label="Payment status" value={status} onChange={e => setStatus(e.target.value)}><option value="">All payments</option><option value="paid">Paid</option><option value="partial">Partial</option><option value="unpaid">Unpaid</option></select>{organization?.role === 'admin' && <label className="toolbar-check"><input type="checkbox" checked={cancelled} onChange={e => setCancelled(e.target.checked)} />Show cancelled bills</label>}</div>{error && <p role="alert" className="error-box">{error}</p>}{loading ? <Loading label="Loading bills..." /> : rows.length === 0 ? <EmptyState title={cancelled ? 'No cancelled bills' : 'No bills found'} description={cancelled ? 'Bills an administrator cancelled appear here while they stay cancelled.' : 'Create your first bill or adjust the filters.'} action={organization?.role !== 'viewer' && !cancelled ? 'Create bill' : undefined} href="/bills/new" /> : <><div className="table-scroll"><table><thead><tr><th>Bill no.</th><th>Date</th><th>Customer</th>{!cancelled && <th>GSTIN</th>}<th>Total</th>{cancelled ? <><th>Cancelled for</th><th aria-label="Restore" /></> : <><th>Remaining</th><th>Payment</th></>}</tr></thead><tbody>{rows.map(b => cancelled ? <tr key={b.id}><td className="mono">{b.bill_number}</td><td>{displayDate(b.bill_date)}</td><td><Link to={`/customers/${b.customer_id}`}>{b.customer_name}</Link></td><td className="amount">{money(b.grand_total)}</td><td>{b.cancellation_reason || <span className="muted">No reason recorded</span>}</td><td><Button variant="secondary" disabled={restoringId === b.id} onClick={() => void restore(b.id)}>{restoringId === b.id ? 'Restoring...' : 'Restore'}</Button></td></tr> : <tr key={b.id}><td><Link className="table-primary" to={`/bills/${b.id}`}>{b.bill_number}</Link></td><td>{displayDate(b.bill_date)}</td><td><Link to={`/customers/${b.customer_id}`}>{b.customer_name}</Link></td><td className="mono">{b.customer_gstin || '—'}</td><td className="amount">{money(b.grand_total)}</td><td className="amount">{money(billRemaining(b))}</td><td><Status value={b.payment_status} /></td></tr>)}</tbody></table></div><Pagination page={page} count={count} size={20} onChange={setPage} /></>}</Card></>
}

export function DocumentViewer({ attachment }: { attachment: Attachment }) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)
  useEffect(() => {
    let active = true
    void signedDocumentUrl(attachment.file_path).then(value => { if (active) setUrl(value) }).catch(cause => { if (active) setError(friendlyError(cause)) })
    return () => { active = false }
  }, [attachment.file_path])
  return <Card className="document-card"><div className="document-header"><div><h2>Original document</h2><small>{attachment.file_name}</small></div><div className="inline-actions"><Button variant="ghost" aria-label="Zoom out" onClick={() => setZoom(z => Math.max(.5, z - .25))}><ZoomOut size={17} /></Button><Button variant="ghost" aria-label="Zoom in" onClick={() => setZoom(z => Math.min(3, z + .25))}><ZoomIn size={17} /></Button>{attachment.mime_type !== 'application/pdf' && <Button variant="ghost" aria-label="Rotate image" onClick={() => setRotation(r => r + 90)}><RotateCw size={17} /></Button>}{url && <a href={url} className="button button-secondary" target="_blank" rel="noreferrer"><Download size={16} /> Open original</a>}</div></div>{error && <p role="alert" className="error-box">{error}</p>}{url ? <div className="document-canvas">{attachment.mime_type === 'application/pdf' ? <iframe title="Original bill PDF" src={`${url}#page=1&zoom=${Math.round(zoom * 100)}`} /> : <img src={url} alt={`Scanned original bill ${attachment.file_name}`} style={{ transform: `scale(${zoom}) rotate(${rotation}deg)` }} />}</div> : <Loading label="Opening document..." />}<small className="muted">Private link expires after 60 seconds. Reload the page for a new link.</small></Card>
}

export function BillDetail() {
  const { id } = useParams()
  const { organization } = useAuth()
  const navigate = useNavigate()
  const [bill, setBill] = useState<Bill | null>(null)
  const [items, setItems] = useState<BillItem[]>([])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [cancelOpen, setCancelOpen] = useState(false)
  // The challans this bill pays for, when it has been linked to any. Read
  // through an RPC rather than a nested Data API select: the chain is
  // bill -> link -> dc_documents -> dc_items, and a nested select that deep
  // returns nothing but no error when any part of it is unreachable.
  const [linkedChallans, setLinkedChallans] = useState<BillChallanSummary[]>([])
  // The customer DC numbers and our outward challan numbers this invoice
  // prints. Derived, never typed twice: a bill linked to a challan takes the
  // number from it, and a bill raised by hand can carry a typed reference.
  const references = useMemo(
    () => billReferences(bill ?? { customer_dc_reference: null }, linkedChallans),
    [bill, linkedChallans],
  )
  const [pdfBusy, setPdfBusy] = useState(false)
  useEffect(() => {
    if (!id || !organization) return
    let active = true
    void settleAll([
      () => db.from('bills').select('*').eq('id', id).eq('organization_id', organization.id).is('deleted_at', null).single(),
      () => db.from('bill_items').select('*').eq('bill_id', id).eq('organization_id', organization.id).order('line_no'),
      () => db.from('bill_attachments').select('*').eq('bill_id', id).eq('organization_id', organization.id).is('deleted_at', null),
    ]).then(([b, i, a]) => {
      if (!active) return
      const billQuery = b.ok ? b.value : null
      const billResult = billQuery?.data ?? null
      setBill(billResult as Bill | null)
      setItems((i.ok ? i.value.data ?? [] : []) as BillItem[])
      setAttachments((a.ok ? a.value.data ?? [] : []) as Attachment[])
      // The header row failing is what decides whether this page has anything to
      // show, so its error wins; a failed item or attachment read still degrades
      // that section on its own rather than hiding the whole invoice.
      setError(friendlyError(
        b.ok && billQuery?.error ? billQuery.error
          : firstError([i, a]) ?? '',
      ))
      setLoading(false)
    })
    return () => { active = false }
  }, [id, organization])
  useEffect(() => {
    if (!id || !organization) { setLinkedChallans([]); return }
    let active = true
    void dcApi.billsForBill(organization.id, id)
      .then(rows => { if (active) setLinkedChallans(rows) })
      // A bill with no linked challans is the ordinary case, so a failed read
      // leaves the section empty rather than raising on an invoice page.
      .catch(() => { if (active) setLinkedChallans([]) })
    return () => { active = false }
  }, [id, organization])
  async function addDocument(file: File) {
    if (!bill || !organization) return
    setUploading(true); setError('')
    try {
      const attachment = await uploadDocument(organization.id, file)
      const { data, error: insertError } = await db.from('bill_attachments').insert({
        organization_id: organization.id,
        bill_id: bill.id,
        file_path: attachment.object_path,
        file_name: file.name.slice(0, 255),
        mime_type: attachment.content_type,
        size_bytes: attachment.size_bytes,
      }).select().single()
      if (insertError) throw insertError
      setAttachments(old => [...old, data as Attachment])
    } catch (cause) {
      // The failure usually comes from the api function (storage misconfiguration,
      // missing bucket, rejected token), whose message is the actual cause.
      // friendlyError() folds every unmapped sentence into "the request could not
      // be completed", so explainError() keeps the raw reason visible instead.
      setError(explainError(cause, 'That document could not be attached.'))
    } finally { setUploading(false) }
  }
  /**
   * The tax invoice PDF.
   *
   * The company details come from the workspace profile, which is read live,
   * so a letterhead corrected this morning is on the invoice generated this
   * afternoon. Nothing is invented: a detail that is not on file is left off
   * the document, and the warning below says so rather than printing a blank.
   */
  async function downloadPdf() {
    if (!bill || pdfBusy) return
    setPdfBusy(true); setError('')
    try {
      const { downloadBillPdf } = await import('../lib/bill-pdf')
      await downloadBillPdf(bill, items, {
        name: organization?.name ?? 'Organization',
        gstin: organization?.gstin ?? null,
        address: organization?.address ?? null,
        phone: organization?.phone ?? null,
        email: organization?.email ?? null,
      }, references)
    } catch (cause) {
      setError(friendlyError(cause))
    } finally {
      setPdfBusy(false)
    }
  }

  if (loading) return <Loading label="Loading bill..." />
  // A failed read is not the same as a missing record. The old code returned
  // "Bill not found" for both, which told the user their record had been deleted
  // when the truth was usually a dropped connection - the reason refreshing seemed
  // to be the only fix.
  if (!bill) return <>
    {error && <p role="alert" className="error-box">{error}</p>}
    <EmptyState
      title={error ? 'This bill could not be loaded' : 'Bill not found'}
      description={error || "It may have been removed or you don't have access."}
      action="Back to bills"
      href="/bills"
    />
  </>
  return <><div className="no-print"><Link className="back-link" to="/bills"><ArrowLeft size={16} /> All bills</Link><PageTitle eyebrow="BILL RECORD" title={bill.bill_number} description={`${bill.customer_name} · ${displayDate(bill.bill_date)}`} action={<div className="inline-actions">{organization?.role !== 'viewer' && <Link className="button button-secondary" to={`/bills/${bill.id}/edit`}>Edit</Link>}<Button variant="secondary" onClick={() => window.print()}><Printer size={16} /> Print</Button><Button variant="secondary" disabled={pdfBusy} onClick={() => void downloadPdf()}><Download size={16} /> {pdfBusy ? 'Building PDF...' : 'PDF'}</Button>{organization?.role === 'admin' && <Button variant="danger" onClick={() => setCancelOpen(true)}><Ban size={16} /> Cancel bill</Button>}</div>} /></div>
      {(!organization?.gstin || !organization?.address) && (
        <p className="error-box no-print">
          This invoice has no complete company letterhead.{' '}
          {!organization?.gstin && 'The GSTIN is missing. '}
          {!organization?.address && 'The address is missing. '}
          <Link to="/settings">Add the company details</Link> before sending this invoice to a customer.
        </p>
      )}
    <BillPaper bill={bill} items={items} company={{ name: organization?.name ?? 'Organization', gstin: organization?.gstin ?? null, address: organization?.address ?? null, phone: organization?.phone ?? null, email: organization?.email ?? null }} references={references} />
    <div className="no-print documents-section"><div className="section-header"><h2>Challans this bill pays for</h2></div>{linkedChallans.length ? (
      <>
        <p className="muted">
          One bill can cover several outward challans, and one challan can be billed across several
          bills. Every row here opens the challan it belongs to.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Challan</th><th>Customer DC</th><th>Date</th>
                <th className="num">Lines</th><th className="num">Dispatched</th>
                <th className="num">Delivered</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {linkedChallans.map(challan => (
                <tr key={challan.dc_id}>
                  <td><Link className="table-primary" to={challanPath(challan.dc_id, challan.dc_type)}>{challan.dc_number}</Link></td>
                  <td className="mono">{(challan.customer_dc_numbers ?? []).join(', ') || '—'}</td>
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
      </>
    ) : (
      <p className="muted">
        No challan is linked to this bill. Raise one with <strong>Bill this challan</strong> on an
        outward delivery challan, or attach the bill from that challan's page.
      </p>
    )}</div>
    <div className="no-print documents-section"><div className="section-header"><h2>Original documents</h2>{organization?.role !== 'viewer' && <DocumentPicker compact busy={uploading} onFile={file => void addDocument(file)} onError={setError} />}</div>{error && <p role="alert" className="error-box">{error}</p>}{attachments.length ? attachments.map(a => <DocumentViewer key={a.id} attachment={a} />) : <EmptyState title="No original attached" description="Upload the scan, photograph the paper bill or attach a PDF to keep a permanent source alongside this record." />}</div>
    {cancelOpen && <CancelBillDialog bill={bill} onClose={() => setCancelOpen(false)} onCancelled={() => { setCancelOpen(false); navigate('/bills') }} />}
  </>
}

/**
 * The cancellation dialog: the one place this branch can wire a note to a
 * reason.
 *
 * Cancelling is what the workflow used to call deleting. The bill stays on the
 * books in every sense except the visible ones: the database marks it deleted,
 * records the reason and who did it, and refuses any further edit. An
 * administrator can reverse it from the bills list. The database already
 * refuses to cancel a bill whose reason is blank, so the dialog asks for one
 * before anything is sent, and the same rule applies wherever the request comes
 * from.
 */
function CancelBillDialog({ bill, onClose, onCancelled }: { bill: Bill; onClose: () => void; onCancelled: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close() }, [])
  async function submit() {
    if (busy || !reason.trim()) return
    setBusy(true); setError('')
    try {
      const { error: rpcError } = await db.rpc('soft_delete_bill', { target_bill_id: bill.id, reason: reason.trim() })
      if (rpcError) throw rpcError
      onCancelled()
    } catch (cause) {
      setError(friendlyError(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <dialog ref={ref} className="modal" onClose={onClose} aria-labelledby="cancel-bill-title">
      <form onSubmit={e => { e.preventDefault(); void submit() }}>
        <div className="modal-header">
          <div><div className="eyebrow">BILL RECORD</div><h2 id="cancel-bill-title">Cancel {bill.bill_number}</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <p className="muted">
          Cancelling never deletes the bill. It records the reason, hides it from every list, and stops it
          being edited. An administrator can restore it from the bills list with <strong>Show cancelled
          bills</strong>.
        </p>
        <TextArea
          label="Reason"
          value={reason}
          onChange={e => setReason(e.target.value)}
          rows={3}
          required
          maxLength={2000}
          autoFocus
          placeholder="Why is this invoice being cancelled?"
        />
        {error && <p role="alert" className="error-box">{error}</p>}
        <div className="modal-actions">
          <Button variant="danger" type="button" disabled={busy || !reason.trim()} onClick={() => void submit()}>{busy ? 'Cancelling...' : 'Cancel bill'}</Button>
          <Button variant="secondary" type="button" onClick={onClose}>Keep it</Button>
        </div>
      </form>
    </dialog>
  )
}
