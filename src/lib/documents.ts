import { apiUrl, backendRequest } from './db'

export const bucket = 'bill-attachments'
export const presignExpirySeconds = 60

const allowed: Record<string, string[]> = {
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
}

export async function validateDocument(file: File): Promise<string> {
  const extension = file.name.split('.').pop()?.toLowerCase() || ''
  if (!allowed[file.type]?.includes(extension)) throw new Error('Choose a PDF, JPG, PNG or WEBP file.')
  if (file.size > 10 * 1024 * 1024 || file.size === 0) throw new Error('Files must be between 1 byte and 10 MB.')
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  const ascii = String.fromCharCode(...bytes)
  const matches = file.type === 'application/pdf'
    ? ascii.startsWith('%PDF-')
    : file.type === 'image/jpeg'
      ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : file.type === 'image/png'
        ? bytes[0] === 137 && ascii.slice(1, 4) === 'PNG'
        : ascii.slice(0, 4) === 'RIFF' && ascii.slice(8, 12) === 'WEBP'
  if (!matches) throw new Error('The file contents do not match its type.')
  return extension
}

export function documentPath(organizationId: string, extension: string): string {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${organizationId}/${year}/${month}/${crypto.randomUUID()}/original.${extension}`
}

export type StoredDocument = { object_path: string; content_type: string; size_bytes: number }

export async function uploadDocument(organizationId: string, file: File): Promise<StoredDocument> {
  const extension = await validateDocument(file)
  const path = documentPath(organizationId, extension)
  const form = new FormData()
  form.append('file', file, file.name.slice(0, 255))
  return backendRequest<StoredDocument>(apiUrl, `/documents/upload?organizationId=${encodeURIComponent(organizationId)}&path=${encodeURIComponent(path)}`, {
    method: 'POST',
    body: form,
  })
}

export async function signedDocumentUrl(objectPath: string): Promise<string> {
  const result = await backendRequest<{ url: string; expires_in: number }>(apiUrl, '/documents/presign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ objectPath }),
  })
  return result.url
}