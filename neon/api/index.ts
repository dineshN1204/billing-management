import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { attachDatabasePool } from '@neon/functions'
import { Hono } from 'hono'
import { Pool } from 'pg'
import {
  HttpError,
  UUID,
  assertOrganizationPath,
  corsHeaders,
  organizationFromObjectPath,
  requireMembership,
  verifyToken,
} from '../shared/auth'

const BUCKET = 'bill-attachments'
const MAX_BYTES = 10 * 1024 * 1024
const MULTIPART_SLACK = MAX_BYTES + 64 * 1024
const PRESIGN_EXPIRES_IN = 60

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

interface MagicBytes {
  extensions: readonly string[]
  matches: (bytes: Uint8Array, ascii: string) => boolean
}

const ALLOWED_CONTENT_TYPES: Readonly<Record<string, MagicBytes>> = {
  'application/pdf': {
    extensions: ['pdf'],
    matches: (_bytes, ascii) => ascii.startsWith('%PDF-'),
  },
  'image/jpeg': {
    extensions: ['jpg', 'jpeg'],
    matches: bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  },
  'image/png': {
    extensions: ['png'],
    matches: (bytes, ascii) => bytes[0] === 0x89 && ascii.slice(1, 4) === 'PNG',
  },
  'image/webp': {
    extensions: ['webp'],
    matches: (_bytes, ascii) => ascii.slice(0, 4) === 'RIFF' && ascii.slice(8, 12) === 'WEBP',
  },
}

function assertSupportedDocument(contentType: string, fileName: string, bytes: Uint8Array): void {
  const declared = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  const allowed = ALLOWED_CONTENT_TYPES[declared]
  if (!allowed) throw new HttpError(400, 'Only PDF, JPG, PNG and WEBP documents are accepted.')
  const extension = fileName.split('.').pop()?.toLowerCase() ?? ''
  if (!allowed.extensions.includes(extension)) {
    throw new HttpError(400, `The file extension does not match its declared type (${declared}).`)
  }
  const header = bytes.slice(0, 12)
  const ascii = String.fromCharCode(...header)
  if (!allowed.matches(header, ascii)) throw new HttpError(400, 'The file contents do not match its declared type.')
}

function assertSize(size: number): void {
  if (size === 0) throw new HttpError(400, 'Files must be between 1 byte and 10 MB.')
  if (size > MAX_BYTES) throw new HttpError(400, 'Files must be between 1 byte and 10 MB.')
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

app.get('/health', c => c.json({ ok: true }))

app.post('/documents/upload', async c => {
  const userId = await verifyToken(c.req.raw)
  const organizationId = c.req.query('organizationId') ?? ''
  if (!UUID.test(organizationId)) throw new HttpError(400, 'Invalid organization ID.')
  const objectPath = c.req.query('path') ?? ''
  assertOrganizationPath(objectPath, organizationId)
  await requireMembership(pool, organizationId, userId, { write: true })

  const contentType = c.req.header('Content-Type') ?? ''
  const isMultipart = contentType.toLowerCase().startsWith('multipart/form-data')
  const declaredLength = Number(c.req.header('Content-Length') ?? '')
  if (Number.isFinite(declaredLength) && declaredLength > (isMultipart ? MULTIPART_SLACK : MAX_BYTES)) {
    throw new HttpError(400, 'Files must be between 1 byte and 10 MB.')
  }

  let bytes: Uint8Array
  let declaredType: string
  let fileName: string

  if (isMultipart) {
    const file = (await c.req.parseBody())['file']
    if (!(file instanceof File)) throw new HttpError(400, 'Attach the document as a "file" part.')
    bytes = new Uint8Array(await file.arrayBuffer())
    declaredType = file.type
    fileName = file.name
  } else {
    bytes = new Uint8Array(await c.req.arrayBuffer())
    declaredType = contentType.split(';')[0]?.trim() ?? ''
    fileName = objectPath.split('/').pop() ?? ''
  }

  assertSize(bytes.byteLength)
  assertSupportedDocument(declaredType, fileName, bytes)
  const resolvedType = declaredType.split(';')[0]?.trim().toLowerCase() ?? ''

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: objectPath,
      Body: bytes,
      ContentType: resolvedType,
      ContentLength: bytes.byteLength,
    }),
  )

  await pool.query(
    `insert into public.storage_objects (organization_id, object_path, content_type, size_bytes)
     values ($1::uuid, $2, $3, $4)
     on conflict (organization_id, object_path)
     do update set content_type = excluded.content_type, size_bytes = excluded.size_bytes`,
    [organizationId, objectPath, resolvedType, bytes.byteLength],
  )

  return c.json(
    { object_path: objectPath, content_type: resolvedType, size_bytes: bytes.byteLength },
    201,
  )
})

app.post('/documents/presign', async c => {
  const userId = await verifyToken(c.req.raw)
  const body = (await c.req.json().catch(() => null)) as { objectPath?: unknown } | null
  const objectPath = typeof body?.objectPath === 'string' ? body.objectPath : ''
  if (!objectPath) throw new HttpError(400, 'objectPath is required.')

  const organizationId = organizationFromObjectPath(objectPath)
  assertOrganizationPath(objectPath, organizationId)
  await requireMembership(pool, organizationId, userId, { write: false })

  const { rows } = await pool.query<{ object_path: string }>(
    'select object_path from public.storage_objects where organization_id = $1::uuid and object_path = $2',
    [organizationId, objectPath],
  )
  if (!rows[0]) throw new HttpError(404, 'Document not found.')

  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: objectPath }), {
    expiresIn: PRESIGN_EXPIRES_IN,
  })

  return c.json({ url, expires_in: PRESIGN_EXPIRES_IN })
})

app.get('/documents/download/:encodedPath', async c => {
  const userId = await verifyToken(c.req.raw)
  const objectPath = c.req.param('encodedPath')
  if (!objectPath) throw new HttpError(400, 'Invalid object path.')

  const organizationId = organizationFromObjectPath(objectPath)
  assertOrganizationPath(objectPath, organizationId)
  await requireMembership(pool, organizationId, userId, { write: false })

  const { rows } = await pool.query<{ content_type: string | null; size_bytes: string | null }>(
    'select content_type, size_bytes from public.storage_objects where organization_id = $1::uuid and object_path = $2',
    [organizationId, objectPath],
  )
  const record = rows[0]
  if (!record) throw new HttpError(404, 'Document not found.')

  const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: objectPath }))
  const body = await object.Body?.transformToWebStream()
  if (!body) throw new HttpError(404, 'Document not found.')

  const headers: Record<string, string> = {
    'Content-Type': record.content_type ?? 'application/octet-stream',
    'Cache-Control': 'private, no-store',
    'Content-Disposition': `inline; filename="${(objectPath.split('/').pop() ?? 'document').replace(/["\\]/g, '')}"`,
  }
  if (record.size_bytes !== null) headers['Content-Length'] = record.size_bytes

  return new Response(body, { status: 200, headers })
})

app.notFound(c => c.json({ error: 'Not found.' }, 404))

export default app