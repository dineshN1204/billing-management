import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'
import { Link } from 'react-router-dom'
import { JOB_STATUS_LABEL, type DcJobStatus } from '../lib/dc-types'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost' }
export function Button({ variant = 'primary', className = '', ...props }: ButtonProps) {
  return <button className={`button button-${variant} ${className}`} {...props} />
}
export function Card({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`card ${className}`} {...props} />
}
export function Field({ label, hint, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return <label className="field"><span>{label}</span><input {...props} />{hint && <small>{hint}</small>}</label>
}
export function SelectField({ label, hint, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; hint?: string; children: ReactNode }) {
  return <label className="field">{label && <span>{label}</span>}<select {...props}>{children}</select>{hint && <small>{hint}</small>}</label>
}
export function TextArea({ label, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string }) {
  return <label className="field"><span>{label}</span><textarea {...props} /></label>
}
export function EmptyState({ title, description, action, href }: { title: string; description: string; action?: string; href?: string }) {
  return <div className="empty-state"><div className="empty-mark">◎</div><h3>{title}</h3><p>{description}</p>{action && href && <Link className="button button-secondary" to={href}>{action}</Link>}</div>
}
export function PageTitle({ eyebrow, title, description, action }: { eyebrow: string; title: string; description?: string; action?: ReactNode }) {
  return <div className="page-title"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>{action && <div className="page-actions">{action}</div>}</div>
}
type StatusTone = 'success' | 'warning' | 'danger' | 'neutral' | 'info'

/**
 * A status answered two different questions, so it maps a value to a tone
 * everywhere instead of letting call-sites pick their own badge markup. Every
 * pill is the same `.status` shape; colour is the only thing that varies.
 */
const STATUS_TONE: Record<string, StatusTone> = {
  paid: 'success', verified: 'success', succeeded: 'success', delivered: 'success', accepted: 'success',
  failed: 'danger', rejected: 'danger', unpaid: 'danger', cancelled: 'neutral',
  draft: 'neutral', issued: 'neutral', dispatched: 'warning', partially_delivered: 'warning',
  not_started: 'neutral', not_required: 'neutral', queued: 'neutral',
  in_progress: 'info', processing: 'info',
}

export function Status({ value, label, tone }: { value: string; label?: string; tone?: StatusTone }) {
  // `delivered` is a completed movement, not a warning. Without it here a
  // finished outward challan renders in the same amber as `dispatched`.
  const resolved: StatusTone = tone ?? STATUS_TONE[value] ?? 'warning'
  return <span className={`status status-${resolved}`}>{label ?? value.replaceAll('_', ' ')}</span>
}
/**
 * How far the job on an inward challan has got. It sits beside `Status` rather
 * than replacing it because the two answer different questions: `Status` is the
 * receipt - the material arrived at our gate - and this is the work. Only an
 * inward challan has one, so an outward row reads as an em dash.
 *
 * It renders through `Status` so the two never disagree on shape: the job on a
 * finished inward challan used to wear its own bordered badge ("Delivered" with
 * a border), which broke the one-pill look and made "delivered" read as a
 * warning.
 */
const JOB_TONE: Record<DcJobStatus, StatusTone> = {
  not_started: 'neutral', in_progress: 'info', partially_delivered: 'warning', delivered: 'success',
}
export function JobStatus({ value }: { value: DcJobStatus | null }) {
  if (!value) return <span className="muted" title="Not a job - this challan is its own delivery">—</span>
  return <Status value={value} label={JOB_STATUS_LABEL[value]} tone={JOB_TONE[value]} />
}
export function Pagination({ page, count, size, onChange }: { page: number; count: number; size: number; onChange: (page: number) => void }) {
  const max = Math.max(1, Math.ceil(count / size))
  return <div className="pagination"><span>{count.toLocaleString('en-IN')} records · Page {page} of {max}</span><div><Button variant="secondary" disabled={page <= 1} onClick={() => onChange(page - 1)}>Previous</Button><Button variant="secondary" disabled={page >= max} onClick={() => onChange(page + 1)}>Next</Button></div></div>
}
export function Loading({ label = 'Loading...' }: { label?: string }) {
  return <div role="status" className="loading"><span className="spinner" />{label}</div>
}
