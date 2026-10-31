import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ScanLine } from 'lucide-react'
import { BillForm } from './BillForm'
import { DocumentViewer } from './Bills'
import { DocumentPicker } from '../components/DocumentPicker'
import { Button, Card, EmptyState, Loading, PageTitle, Status } from '../components/ui'
import { useAuth } from '../lib/auth'
import { uploadDocument, validateDocument } from '../lib/documents'
import { friendlyError, money, normalizeGstin } from '../lib/format'
import { db, processBillUrl, backendRequest } from '../lib/db'
import type { Attachment, Customer, OcrJob } from '../lib/types'

/**
 * Terminal OCR job statuses - the ocr_jobs_status_check list minus the two a
 * running backend still owns. Rows outside this set are worth polling for; the
 * moment everything is terminal, polling stops.
 */
const OCR_ACTIVE_STATUSES = new Set(['queued', 'processing'])

export function Scan() {
  const { organization } = useAuth()
  const navigate = useNavigate()
  const [jobs, setJobs] = useState<OcrJob[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { if (!organization) return; void db.from('ocr_jobs').select('*').eq('organization_id', organization.id).is('deleted_at', null).order('created_at', { ascending: false }).limit(30).then(({ data }) => setJobs((data ?? []) as OcrJob[])) }, [organization])
  // A queued job used to read "Waiting for extraction" for ever: the row was
  // fetched once after upload and never asked about again, so a slow backend
  // looked like a hang (a documented gap). One interval polls exactly the rows
  // that are still moving and asks nothing once every job is terminal. The ref
  // keeps the interval from being torn down and rebuilt on every list change.
  const jobsRef = useRef(jobs)
  jobsRef.current = jobs
  useEffect(() => {
    if (!organization) return
    const timer = window.setInterval(async () => {
      const pending = jobsRef.current.filter(job => OCR_ACTIVE_STATUSES.has(job.status)).map(job => job.id)
      if (!pending.length) return
      const { data } = await db.from('ocr_jobs').select('*').eq('organization_id', organization.id).in('id', pending)
      if (!data?.length) return
      setJobs(old => old.map(job => {
        const row = data.find(d => d.id === job.id)
        return row ? row as OcrJob : job
      }))
    }, 3000)
    return () => window.clearInterval(timer)
  }, [organization])
  async function process(files: FileList | File[]) {
    if (!organization || !files.length || busy) return
    setBusy(true); setError('')
    for (const file of Array.from(files).slice(0, 20)) {
      try {
        await validateDocument(file)
        const attachment = await uploadDocument(organization.id, file)
        const { data, error: createError } = await db.from('ocr_jobs').insert({ organization_id: organization.id, file_path: attachment.object_path, status: 'queued' }).select().single()
        if (createError) throw createError
        setJobs(old => [data as OcrJob, ...old])
        let invokeError: unknown = null
        try {
          await backendRequest<{ job_id: string; status: string }>(processBillUrl, '/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ job_id: data.id }),
          })
        } catch (cause) { invokeError = cause }
        const { data: refreshed } = await db.from('ocr_jobs').select('*').eq('id', data.id).single()
        if (refreshed) setJobs(old => old.map(job => job.id === refreshed.id ? refreshed as OcrJob : job))
        if (invokeError) { setError('A document could not be processed. You can retry it below.'); continue }
        if (files.length === 1) { navigate(`/scan/review/${data.id}`); break }
      } catch (cause) { setError(friendlyError(cause)) }
    }
    setBusy(false)
  }
  async function retry(id: string) {
    setBusy(true); setError('')
    try {
      await backendRequest<{ job_id: string; status: string }>(processBillUrl, '/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: id }),
      })
    } catch { setError('OCR failed. Check the document and OCR configuration, then retry.') }
    const { data } = await db.from('ocr_jobs').select('*').eq('id', id).single()
    if (data) setJobs(old => old.map(job => job.id === id ? data as OcrJob : job))
    setBusy(false)
  }
  if (organization?.role === 'viewer') return <EmptyState title="Read-only access" description="You cannot scan documents with this role." />
  return <div className="scan-stack"><PageTitle eyebrow="DIGITIZATION" title="Scan bills" description="Photograph your paper bills or upload images and PDFs. OCR suggestions are never saved as official bills without your review." /><Card className="scan-card"><ScanLine size={40} /><h2>{busy ? 'Processing documents...' : 'Bring your bill book online'}</h2><p>Photograph a bill, or drag and drop up to 20 files at once.</p><DocumentPicker multiple busy={busy} onFiles={files => void process(files)} onError={setError} hint="PDF, JPG, PNG or WEBP · Max 10 MB per file" /></Card>{error && <p role="alert" className="error-box">{error}</p>}
    <Card className="scan-card"><div className="section-header"><h2>Recent scans</h2><span className="muted">{jobs.length} recent jobs</span></div>{jobs.length ? <div className="table-scroll"><table><thead><tr><th>Uploaded</th><th>Status</th><th>Review</th></tr></thead><tbody>{jobs.map(job => <tr key={job.id}><td className="mono">{new Date(job.created_at).toLocaleString('en-IN')}</td><td><Status value={job.status} /></td><td>{job.status === 'succeeded' ? <Link to={`/scan/review/${job.id}`} className="text-link">Review extraction →</Link> : job.status === 'failed' ? <Button variant="secondary" disabled={busy} onClick={() => void retry(job.id)}>Retry failed</Button> : job.bill_id ? <Link to={`/bills/${job.bill_id}`} className="text-link">View saved bill →</Link> : job.error_message || 'Waiting for extraction'}</td></tr>)}</tbody></table></div> : <EmptyState title="No scans yet" description="Upload an original bill to begin extracting information." />}</Card></div>
}

type Field = { value: string | null; confidence: number | null }
type StagedFields = { bill_number?: Field; bill_date?: Field; customer_gstin?: Field; company_name?: Field; grand_total?: Field }
export function ScanReview() {
  const { id } = useParams()
  const { organization } = useAuth()
  const [job, setJob] = useState<OcrJob | null>(null)
  const [matches, setMatches] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => { if (!id || !organization) return; void db.from('ocr_jobs').select('*').eq('id', id).eq('organization_id', organization.id).single().then(({ data, error: queryError }) => { setJob(data as OcrJob | null); setError(queryError ? friendlyError(queryError) : ''); setLoading(false) }) }, [id, organization])
  // The upload page navigates here the moment a document is accepted, which is
  // often while the backend is still working - the job then reads "queued" and,
  // without polling, stays there until a manual reload. This poll repeats what
  // the list page does, and stops of its own accord the moment the job lands on
  // a terminal status.
  useEffect(() => {
    if (!id || !organization?.id || !job || !OCR_ACTIVE_STATUSES.has(job.status)) return
    const timer = window.setInterval(async () => {
      const { data } = await db.from('ocr_jobs').select('*').eq('id', id).eq('organization_id', organization.id).single()
      if (data) setJob(data as OcrJob)
    }, 3000)
    return () => window.clearInterval(timer)
  }, [id, organization, job?.status])
  const fields = job?.staging?.fields as StagedFields | undefined
  const gstin = fields?.customer_gstin?.value
  const company = fields?.company_name?.value
  useEffect(() => {
    if (!organization || (!gstin && !company)) return
    let active = true
    const request = db.from('customers').select('*').eq('organization_id', organization.id).is('deleted_at', null)
    void (gstin ? request.eq('gstin', normalizeGstin(gstin)) : request.ilike('name', company ?? '')).limit(5).then(({ data }) => { if (active) setMatches((data ?? []) as Customer[]) })
    return () => { active = false }
  }, [gstin, company, organization])
  if (loading) return <Loading label="Loading extraction..." />
  if (!job) return <EmptyState title="Scan not found" description="This scan is missing or inaccessible." />
  if (job.status === 'imported' && job.bill_id) return <EmptyState title="Already saved" description="This scan has been verified and linked to an official bill." action="View bill" href={`/bills/${job.bill_id}`} />
  if (job.status !== 'succeeded') return <><PageTitle eyebrow="OCR REVIEW" title="Extraction unavailable" /><p role="alert" className="error-box">{error || job.error_message || `The scan is ${job.status}.`}</p><Link className="button button-secondary" to="/scan">Back to scans</Link></>
  const attachment: Attachment = { id: job.id, bill_id: '', file_path: job.file_path, file_name: job.file_path.split('/').pop() || 'Original bill', mime_type: job.file_path.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg' }
  const confidence = (value?: Field) => !value?.value ? 'Needs verification' : value.confidence == null ? 'Needs verification' : `${Math.round(value.confidence * 100)}% · ${value.confidence < .85 ? 'Verify' : 'High confidence'}`
  return <><PageTitle eyebrow="HUMAN VERIFICATION" title="Review scanned bill" description="Compare every suggested value with the original. Missing items and customers must be supplied by you." /><div className="review-layout"><aside className="review-document"><DocumentViewer attachment={attachment} /><Card className="review-signals"><h2>Extraction signals</h2>{([['Bill number', fields?.bill_number], ['Bill date', fields?.bill_date], ['GSTIN', fields?.customer_gstin], ['Grand total', fields?.grand_total]] as Array<[string, Field | undefined]>).map(([label, value]) => <div className="signal" key={label}><span>{label}</span><strong>{value?.value || 'Not detected'}</strong><small>{confidence(value)}</small></div>)}<p className="muted">OCR confidence is conservative. The total is a reference, not a trusted calculation.</p>{matches.length > 0 && <div className="match-list"><h3>Possible customer match</h3>{matches.map(customer => <div key={customer.id}><strong>{customer.name}</strong><small>{customer.gstin}</small></div>)}</div>}</Card></aside><div className="review-form"><BillForm source="ocr" ocrJobId={job.id} existingAttachment={{ file_path: job.file_path, file_name: attachment.file_name, mime_type: attachment.mime_type || 'application/pdf', size_bytes: 0 }} initial={{ bill_number: fields?.bill_number?.value || '', bill_date: fields?.bill_date?.value || '', customer_id: matches.length === 1 ? matches[0]?.id : '', items: [] }} />{fields?.grand_total?.value && <Card className="review-signals"><p>Extracted grand total (verify against your item calculation): <strong>{money(Number(fields.grand_total.value))}</strong></p></Card>}</div></div></>
}
