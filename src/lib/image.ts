export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
export const CAPTURE_MAX_EDGE = 2200
export const CAPTURE_ACCEPT = 'image/jpeg,image/png,image/webp'
export const PICKER_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.heic,.heif'

const PASS_THROUGH_TYPES = new Set(['application/pdf'])

export type CaptureAttempt = { maxEdge: number; quality: number }

/**
 * Ordered ladder of JPEG re-encode attempts for a photo that cannot be stored
 * as-is. Resolution is reduced first, then quality, because a legible bill
 * photo survives compression far better than a downscaled one.
 */
export function planCaptureAttempts(longEdge: number, sizeBytes: number): CaptureAttempt[] {
  if (sizeBytes > 0 && sizeBytes <= MAX_DOCUMENT_BYTES && longEdge <= CAPTURE_MAX_EDGE) return []
  const edge = Math.max(320, Math.min(longEdge || CAPTURE_MAX_EDGE, CAPTURE_MAX_EDGE))
  return [
    { maxEdge: edge, quality: 0.85 },
    { maxEdge: edge, quality: 0.7 },
    { maxEdge: Math.round(edge * 0.72), quality: 0.7 },
    { maxEdge: Math.round(edge * 0.55), quality: 0.6 },
  ]
}

export function captureFileName(originalName: string): string {
  const stem = originalName.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '')
  return `${(stem || 'capture').slice(0, 120) || 'capture'}.jpg`
}

export function isAcceptedImage(file: File): boolean {
  return file.type === 'image/jpeg' || file.type === 'image/png' || file.type === 'image/webp'
}

export function cameraSupported(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext === true && typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function'
}

const UNREADABLE = 'This photo format could not be read. Take the photo as JPG (set the camera to "Most Compatible") or choose a file instead.'
const TOO_LARGE = 'This photo is too large to store. Move closer to the bill or choose a file instead.'

type Decoded = { bitmap: ImageBitmap | HTMLImageElement; width: number; height: number }

async function decode(file: File): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      return { bitmap, width: bitmap.width, height: bitmap.height }
    } catch {
      // Older browsers reject the orientation option; retry without it.
      try {
        const bitmap = await createImageBitmap(file)
        return { bitmap, width: bitmap.width, height: bitmap.height }
      } catch {
        throw new Error(UNREADABLE)
      }
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error(UNREADABLE))
      element.src = url
    })
    return { bitmap: image, width: image.naturalWidth, height: image.naturalHeight }
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function toJpeg(source: Decoded, name: string, attempt: CaptureAttempt): Promise<File> {
  const scale = Math.min(1, attempt.maxEdge / Math.max(source.width, source.height))
  const width = Math.max(1, Math.round(source.width * scale))
  const height = Math.max(1, Math.round(source.height * scale))
  let blob: Blob | null = null
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error(UNREADABLE)
    context.drawImage(source.bitmap, 0, 0, width, height)
    blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: attempt.quality })
  } else {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error(UNREADABLE)
    context.drawImage(source.bitmap, 0, 0, width, height)
    blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', attempt.quality))
  }
  if (!blob) throw new Error(UNREADABLE)
  return new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() })
}

/**
 * Cameras hand back formats and sizes the document pipeline rejects (HEIC from
 * iPhones, 12 MP originals over the 10 MB cap), so every photo is re-encoded as
 * a genuine JPEG whose extension matches its content type. PDFs and images that
 * already fit are passed through untouched.
 */
export async function normalizeCapture(file: File): Promise<File> {
  if (PASS_THROUGH_TYPES.has(file.type)) return file
  if (!isAcceptedImage(file) && file.type !== 'image/heic' && file.type !== 'image/heif' && file.type !== 'image/jpg' && !file.type.startsWith('image/')) return file

  const decoded = await decode(file)
  try {
    const name = captureFileName(file.name)
    const attempts = planCaptureAttempts(Math.max(decoded.width, decoded.height), file.size)
    if (attempts.length === 0 && isAcceptedImage(file)) return file
    for (const attempt of attempts) {
      const encoded = await toJpeg(decoded, name, attempt)
      if (encoded.size <= MAX_DOCUMENT_BYTES) return encoded
    }
    throw new Error(TOO_LARGE)
  } finally {
    if ('close' in decoded.bitmap) decoded.bitmap.close()
  }
}

export async function normalizeAll(files: ArrayLike<File>): Promise<File[]> {
  return Promise.all(Array.from(files).map(normalizeCapture))
}
