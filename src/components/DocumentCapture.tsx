import { useEffect, useRef, useState } from 'react'
import { Camera, CameraOff, RefreshCw, X } from 'lucide-react'
import { Button } from './ui'
import { cameraSupported, normalizeCapture } from '../lib/image'
import { describeError } from '../lib/format'

type NativeCameraProps = {
  disabled?: boolean
  multiple?: boolean
  label?: string
  className?: string
  onFiles: (files: File[]) => void
  onError: (message: string) => void
}

/** Opens the device camera directly on phones via the `capture` hint. */
export function NativeCamera({ disabled, multiple, label = 'Take photo', className = '', onFiles, onError }: NativeCameraProps) {
  async function handle(input: HTMLInputElement) {
    const picked = Array.from(input.files ?? [])
    input.value = ''
    if (!picked.length) return
    try {
      onFiles(await Promise.all(picked.map(normalizeCapture)))
    } catch (cause) {
      onError(describeError(cause, 'That photo could not be prepared.'))
    }
  }
  return <label className={`button button-secondary upload-label ${className}`.trim()}><Camera size={16} /> {label}<input type="file" accept="image/jpeg,image/png,image/webp" multiple={multiple} disabled={disabled} onChange={event => { void handle(event.target) }} /></label>
}

function cameraMessage(cause: unknown): string {
  if (cause instanceof DOMException) {
    if (cause.name === 'NotAllowedError' || cause.name === 'SecurityError') return 'Camera access was blocked. Allow it in your browser settings, or choose a file instead.'
    if (cause.name === 'NotFoundError' || cause.name === 'OverconstrainedError') return 'No camera was found on this device. Choose a file instead.'
    if (cause.name === 'NotReadableError') return 'The camera is already in use by another app.'
  }
  return 'The camera could not be started. Choose a file instead.'
}

type ViewfinderProps = {
  onCapture: (file: File) => void
  onClose: () => void
  onError: (message: string) => void
}

/** In-browser camera for desktops, where `capture` is ignored. */
export function CameraViewfinder({ onCapture, onClose, onError }: ViewfinderProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)

  // Pinned so a parent re-render never restarts the camera stream.
  const handlers = useRef({ onClose, onError })
  handlers.current = { onClose, onError }

  useEffect(() => {
    let active = true
    void navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }).then(stream => {
      if (!active) { stream.getTracks().forEach(track => track.stop()); return }
      streamRef.current = stream
      if (videoRef.current) videoRef.current.srcObject = stream
      setReady(true)
    }).catch(cause => {
      if (!active) return
      handlers.current.onError(cameraMessage(cause))
      handlers.current.onClose()
    })
    return () => {
      active = false
      streamRef.current?.getTracks().forEach(track => track.stop())
      streamRef.current = null
    }
  }, [])

  async function shoot() {
    const video = videoRef.current
    if (!video || !ready || busy) return
    setBusy(true)
    try {
      const width = video.videoWidth || video.clientWidth
      const height = video.videoHeight || video.clientHeight
      if (!width || !height) throw new Error('The camera is not ready yet. Try again.')
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('The camera is not ready yet. Try again.')
      context.drawImage(video, 0, 0, width, height)
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.95))
      if (!blob) throw new Error('That photo could not be prepared.')
      onCapture(await normalizeCapture(new File([blob], `capture-${Date.now()}.jpg`, { type: 'image/jpeg' })))
      onClose()
    } catch (cause) {
      onError(describeError(cause, 'That photo could not be prepared.'))
    } finally {
      setBusy(false)
    }
  }

  return <div className="viewfinder" role="dialog" aria-modal="true" aria-label="Camera"><video ref={videoRef} className="viewfinder-video" autoPlay muted playsInline /><div className="viewfinder-controls"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => void shoot()} disabled={!ready || busy}>{busy ? 'Preparing...' : 'Capture'}</Button></div><button className="viewfinder-close icon-button" aria-label="Close camera" onClick={onClose}><X size={22} /></button>{!ready && <p className="viewfinder-hint"><RefreshCw size={15} /> Starting the camera...</p>}</div>
}

type ViewfinderButtonProps = { disabled?: boolean; onFile: (file: File) => void; onError: (message: string) => void }

/** Renders nothing on devices or contexts without camera access. */
export function ViewfinderButton({ disabled, onFile, onError }: ViewfinderButtonProps) {
  const [open, setOpen] = useState(false)
  if (!cameraSupported()) return null
  return <>
    <Button variant="secondary" disabled={disabled} onClick={() => setOpen(true)}><Camera size={16} /> Use camera</Button>
    {open && <CameraViewfinder onCapture={onFile} onClose={() => setOpen(false)} onError={onError} />}
  </>
}

export function CameraUnavailable() {
  return <span className="muted capture-note"><CameraOff size={14} /> No camera available on this device</span>
}
