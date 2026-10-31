import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { attachDatabasePool } from '@neon/functions'
import { Hono } from 'hono'
import { Pool } from 'pg'
import { HttpError, UUID, corsHeaders, requireMembership, verifyToken } from '../shared/auth'

const BUCKET = 'bill-attachments'
const MAX_BYTES = 10 * 1024 * 1024
const OCR_ENDPOINT = 'https://api.ocr.space/parse/image'
const OCR_TIMEOUT_MS = 45_000
const HOURLY_JOB_LIMIT = 20

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 })
attachDatabasePool(pool)

const accessKeyId = process.env.AWS_ACCESS_KEY_ID
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  endpoint: process.env.AWS_ENDPOINT_URL_S3,
  forcePathStyle: true,
  ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
})

type Extracted = { value: string | null; confidence: number | null }
const field = (value: string | null, confidence: number | null): Extracted => ({ value, confidence })

function extract(text: string) {
  const upper = text.toUpperCase()
  const gstins = [...new Set(upper.match(/\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g) ?? [])]
  const number = text.match(/(?:invoice|bill)\s*(?:no\.?|number|#)?\s*[:#-]\s*([A-Z0-9][A-Z0-9/-]{0,62})/i)?.[1] ?? null
  const dateText = text.match(/(?:invoice|bill)\s*date\s*[:#-]?\s*(\d{1,2}[/.-]\d{1,2}[/.-]\d{4})/i)?.[1] ?? null
  let date: string | null = null
  if (dateText) {
    const [day, month, year] = dateText.split(/[/.-]/).map(Number)
    if (day && month && year) {
      const candidate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      const parsed = new Date(`${candidate}T00:00:00Z`)
      if (parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day) date = candidate
    }
  }
  const totals = [...text.matchAll(/(?:grand\s*total|amount\s*payable|net\s*amount)\s*[:₹\s]*([\d,]+(?:\.\d{1,2})?)/gi)]
  const total = totals.length === 1 ? totals[0]?.[1]?.replaceAll(',', '') ?? null : null
  return {
    bill_number: field(number, number ? 0.55 : null),
    bill_date: field(date, date ? 0.55 : null),
    customer_gstin: field(gstins.length === 1 ? gstins[0] ?? null : null, gstins.length === 1 ? 0.35 : null),
    company_name: field(null, null),
    grand_total: field(total, total ? 0.4 : null),
    item_count: 0,
  }
}

type OcrJob = {
  id: string
  organization_id: string
  file_path: string
  status: string
  created_by: string | null
}

async function failJob(jobId: string, message: string): Promise<void> {
  await pool.query(
    `update public.ocr_jobs
     set status = 'failed', error_message = $2, completed_at = now()
     where id = $1::uuid`,
    [jobId, message.slice(0, 2000)],
  )
}

const app = new Hono()

app.use('*', async (c, next) => {
  const headers = corsHeaders(c.req.header('Origin'))
  for (const [name, value] of Object.entries(headers)) c.header(name, value)
  if (c.req.method === 'OPTIONS') return c.body(null, 204)
  await next()
})

app.onError((cause, c) => {
  const status = cause instanceof HttpError ? cause.status : 500
  const message = cause instanceof HttpError ? cause.message : 'Something went wrong on the server.'
  return c.json({ error: message }, status as 400)
})

app.post('/', async c => {
  if (c.req.method !== 'POST') throw new HttpError(405, 'Method not allowed')
  const userId = await verifyToken(c.req.raw)
  const ocrApiKey = process.env.OCR_API_KEY
  if (!ocrApiKey) throw new HttpError(503, 'OCR is not configured on the server.')

  const body = (await c.req.json().catch(() => null)) as { job_id?: unknown } | null
  const jobId = typeof body?.job_id === 'string' ? body.job_id : ''
  if (!UUID.test(jobId)) throw new HttpError(400, 'Invalid job ID.')

  const { rows } = await pool.query<OcrJob>(
    'select id, organization_id, file_path, status, created_by from public.ocr_jobs where id = $1::uuid',
    [jobId],
  )
  const job = rows[0]
  if (!job) throw new HttpError(404, 'Job not found.')

  const role = await requireMembership(pool, job.organization_id, userId, { write: true })
  if (role === 'viewer' || job.created_by !== userId) throw new HttpError(403, 'You cannot process this job.')
  if (!['queued', 'failed'].includes(job.status)) throw new HttpError(409, 'This job has already been processed.')

  const { rows: rateRows } = await pool.query<{ count: string }>(
    'select count(*) from public.ocr_jobs where created_by = $1::uuid and created_at >= now() - interval \'1 hour\'',
    [userId],
  )
  if (Number(rateRows[0]?.count ?? '0') > HOURLY_JOB_LIMIT) {
    throw new HttpError(429, 'OCR limit reached. Try again in an hour.')
  }

  const locked = await pool.query(
    `update public.ocr_jobs set status = 'processing', error_message = null
     where id = $1::uuid and status = $2
     returning id`,
    [job.id, job.status],
  )
  if (locked.rowCount !== 1) throw new HttpError(409, 'The job is already processing.')

  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: job.file_path }))
    if (!object.Body) throw new Error('Document download failed or exceeds 10 MB.')
    if (typeof object.ContentLength === 'number' && object.ContentLength > MAX_BYTES) {
      throw new Error('Document download failed or exceeds 10 MB.')
    }
    const blob = await object.Body.transformToWebStream()
    const buffer = new Uint8Array(await new Response(blob).arrayBuffer())
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_BYTES) {
      throw new Error('Document download failed or exceeds 10 MB.')
    }

    const form = new FormData()
    form.append(
      'file',
      new Blob([buffer], { type: object.ContentType ?? 'application/octet-stream' }),
      job.file_path.split('/').pop() ?? 'original.pdf',
    )
    form.append('language', 'eng')
    form.append('isOverlayRequired', 'false')

    const response = await fetch(OCR_ENDPOINT, {
      method: 'POST',
      headers: { apikey: ocrApiKey },
      body: form,
      signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error('OCR provider is unavailable.')

    const result = (await response.json()) as {
      IsErroredOnProcessing?: boolean
      ParsedResults?: Array<{ ParsedText?: string }>
    }
    if (result.IsErroredOnProcessing || !result.ParsedResults?.length) {
      throw new Error('OCR could not read this file. Try a clearer scan or enter it manually.')
    }
    const text = result.ParsedResults.map(page => page.ParsedText ?? '').join('\n').slice(0, 100000)
    if (!text.trim()) throw new Error('No text was detected. Try a clearer scan or enter it manually.')

    const staging = { fields: extract(text), raw_text: text, reviewed: false }
    const saved = await pool.query(
      `update public.ocr_jobs
       set status = 'succeeded', staging = $2::jsonb, engine = 'ocr.space', confidence = null, completed_at = now()
       where id = $1::uuid and status = 'processing'`,
      [job.id, JSON.stringify(staging)],
    )
    if (saved.rowCount !== 1) throw new Error('Unable to save OCR results.')

    return c.json({ job_id: job.id, status: 'succeeded' })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'OCR processing failed.'
    await failJob(job.id, message)
    return c.json({ error: message }, 422)
  }
})

app.all('*', c => c.json({ error: 'Method not allowed' }, 405))

export default app