import { useEffect, useRef, useState } from 'react'
import { FileUp, ImagePlus, Trash2 } from 'lucide-react'
import { Button } from './ui'
import { NativeCamera, ViewfinderButton, CameraUnavailable } from './DocumentCapture'
import { explainError } from '../lib/format'
import { cameraSupported, normalizeCapture, PICKER_ACCEPT } from '../lib/image'

type DocumentPickerProps = {
  file?: File | null
  disabled?: boolean
  busy?: boolean
  multiple?: boolean
  compact?: boolean
  hint?: string
  onFile?: (file: File) => void
  onFiles?: (files: File[]) => void
  onRemove?: () => void
  onError: (message: string) => void
}

function readableSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} bytes`
}

/**
 * One entry point for attaching a bill document: camera, in-browser viewfinder,
 * file chooser and drag and drop. Every picked image is normalised to a real
 * JPEG so it always satisfies the extension, content type and size checks.
 */
export function DocumentPicker({ file = null, disabled, busy, multiple, compact, hint, onFile, onFiles, onRemove, onError }: DocumentPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [previewUrl, setPreviewUrl] = useState('')

  async function accept(picked: File[]) {
    if (!picked.length) return
    try {
      const prepared = await Promise.all(picked.map(normalizeCapture))
      const [head] = prepared
      if (onFiles) onFiles(prepared)
      else if (onFile && head) onFile(head)
    } catch (cause) {
      onError(explainError(cause, 'That file could not be prepared.'))
    }
  }

  // A file input ignores a re-selection of the same path unless it is reset.
  useEffect(() => {
    if (!file || !file.type.startsWith('image/')) { setPreviewUrl(''); return }
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  // Browsers navigate away when a file is dropped outside a target.
  useEffect(() => {
    if (!multiple || compact) return
    const prevent = (event: DragEvent) => event.preventDefault()
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    return () => { window.removeEventListener('dragover', prevent); window.removeEventListener('drop', prevent) }
  }, [multiple, compact])

  const actions = <div className="capture-actions">
    <NativeCamera disabled={disabled || busy} multiple={multiple} onFiles={files => void accept(files)} onError={onError} />
    <ViewfinderButton disabled={disabled || busy} onFile={captured => void accept([captured])} onError={onError} />
    <Button variant="secondary" disabled={disabled || busy} onClick={() => inputRef.current?.click()}><FileUp size={16} /> {multiple ? 'Browse files' : 'Choose file'}</Button>
    <input ref={inputRef} className="capture-hidden-input" type="file" multiple={multiple} accept={PICKER_ACCEPT} disabled={disabled || busy} onChange={event => { void accept(Array.from(event.target.files ?? [])); event.target.value = '' }} />
  </div>

  // Bills already hold their own attachment list, so the inline variant is actions only.
  if (compact) return <div className="document-picker document-picker-compact">{actions}</div>

  if (file) return <div className="document-picker"><div className="capture-preview">
    <div className="capture-preview-media">{previewUrl ? <img src={previewUrl} alt={`Selected document ${file.name}`} /> : <div className="capture-preview-fallback"><ImagePlus size={22} /></div>}</div>
    <div className="capture-preview-meta"><strong>{file.name}</strong><small>{readableSize(file.size)}</small><div className="capture-actions">{actions}{onRemove && <Button variant="ghost" disabled={disabled || busy} aria-label="Remove document" onClick={onRemove}><Trash2 size={16} /></Button>}</div></div>
  </div></div>

  return <div className="document-picker"><div className={`capture-dropzone ${dragging ? 'dragging' : ''}`} onDragOver={event => { event.preventDefault(); event.stopPropagation(); setDragging(true) }} onDragLeave={event => { event.stopPropagation(); setDragging(false) }} onDrop={event => { event.preventDefault(); event.stopPropagation(); setDragging(false); void accept(Array.from(event.dataTransfer.files)) }}>
    <div className="capture-dropzone-mark"><ImagePlus size={22} /></div>
    <p>{multiple ? 'Drop bill documents here' : 'Photograph the bill or drop a file'}</p>
    {actions}
    <small>{hint ?? 'PDF, JPG, PNG or WEBP · Max 10 MB'}</small>
  </div>{!cameraSupported() && <CameraUnavailable />}</div>
}
