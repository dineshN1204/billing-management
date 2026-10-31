export function financialYear(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  if (!year || !month || !day || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))) return '—'
  const start = month < 4 ? year - 1 : year
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}

export function today(): string {
  const date = new Date()
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 10)
}

/**
 * Now, as the `datetime-local` value a browser input expects: `YYYY-MM-DDTHH:MM`
 * in local time.
 *
 * Built the same way as today() - shifting by the offset so `toISOString` reads
 * the local clock rather than UTC. An input pre-filled with `toISOString()`
 * directly would be up to five and a half hours ahead of what the operator is
 * looking at, and the delivery timestamp is written from this field.
 */
export function localDateTime(): string {
  const date = new Date()
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 16)
}

/**
 * Formats an amount for display.
 *
 * Anything that is not a finite number renders as 0 rather than reaching
 * Intl.NumberFormat. A bill scanned by OCR can carry "1,234.50" or "Rs. 500"
 * in a field the app expects to be numeric, and Number() turns those into NaN -
 * which Intl happily formats as the literal NaN symbol. A rupee figure is
 * something a person will act on, so "₹NaN" on an invoice is not acceptable.
 */
export const money = (value: number | null | undefined) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 })
    .format(Number.isFinite(value) ? (value as number) : 0)

/**
 * A bare monetary figure with Indian digit grouping, no currency symbol.
 *
 * The PDF names the currency once in the column heading ("Rate (Rs.)") and then
 * prints every amount without a symbol, so the numbers line up. The on-screen
 * print preview does the same, so the screen, the printed page and the
 * downloaded PDF cannot drift. "₹NaN" on an invoice is not acceptable, so a
 * non-finite value becomes 0.00 - the same convention `money()` uses.
 */
export const plainAmount = (value: number | null | undefined) =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format(Number.isFinite(value) ? Number(value) : 0)

export const displayDate = (value: string) =>
  new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value.slice(0, 10)}T00:00:00Z`))

export function normalizeGstin(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export const isValidGstin = (value: string): boolean =>
  /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(normalizeGstin(value))

const GENERIC_ERROR = 'The request could not be completed. Please try again.'

/**
 * Turns anything that was thrown or returned into a readable sentence.
 *
 * Why this exists
 * ---------------
 * `String(someObject)` returns the literal text **"[object Object]"**. That is
 * what the app used to show whenever a request failed with a value that was not
 * an `Error` instance - and because the automatic session recovery keys off the
 * message, an unrecognised shape was also never recognised as a lapsed session.
 * The result was a failure that only a manual refresh could clear.
 *
 * A rejection can legitimately be any of these, and the app has to survive all
 * of them:
 *
 *   - `Error` / `DOMException`                     -> `.message`
 *   - a PostgREST error object                     -> `.message` (+ `.code`, `.details`)
 *   - a GoTrue auth error                           -> `.error_description`, `.error`, `.code`, `.status`
 *   - a plain object                               -> `.message`, or a readable summary of its keys
 *   - a `Response`                                 -> status + statusText
 *   - a string, number or boolean                  -> itself
 *   - `null` / `undefined`                         -> the caller's fallback
 *
 * The last case matters most: a request that fails with no information at all
 * must say so in plain words, never as "[object Object]".
 */
export function describeError(error: unknown, fallback = GENERIC_ERROR): string {
  if (error === null || error === undefined) return fallback

  // Error, DOMException, PostgrestError: all carry a real message.
  if (error instanceof Error) {
    const message = error.message?.trim()
    if (message) return message
    // An Error with an empty message is still something to report, by name.
    return error.name && error.name !== 'Error' ? error.name : fallback
  }

  if (typeof error === 'string') return error.trim() || fallback
  if (typeof error === 'number' || typeof error === 'boolean') return String(error)

  // A Response that was returned rather than thrown.
  if (typeof Response !== 'undefined' && error instanceof Response) {
    return `Request failed (${error.status}${error.statusText ? ` ${error.statusText}` : ''})`
  }

  if (typeof error === 'object') {
    const record = error as Record<string, unknown>

    // GoTrue / auth-js reports `error_description` (human) and `error` (slug).
    for (const key of ['message', 'error_description', 'error', 'reason', 'detail', 'details'] as const) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) {
        // PostgREST puts `CODE: text` in message and repeats the code in `code`.
        // Keeping the full message is what lets the DC and billing rules below
        // match, so it is not shortened here.
        return value.trim()
      }
    }

    // An HTTP-shaped object: `{ status: 401 }` with no message at all.
    const status = record.status ?? record.statusCode
    if (typeof status === 'number' && status >= 400) {
      const code = typeof record.code === 'string' && record.code ? ` (${record.code})` : ''
      return `Request failed (${status})${code}`
    }

    // Last resort: name the keys rather than printing "[object Object]".
    // This still tells a developer something and still reads as English.
    const keys = Object.keys(record).filter(key => key !== 'stack' && key !== 'name')
    if (keys.length > 0) return `Unexpected response from the server (${keys.slice(0, 4).join(', ')})`
    return fallback
  }

  return fallback
}

/** Every machine-readable field a rejection carries, for matching against. */
function errorFingerprint(error: unknown): string {
  const parts: string[] = [describeError(error, '')]
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>
    for (const key of ['code', 'error', 'error_description', 'name', 'status', 'statusCode']) {
      const value = record[key]
      if (typeof value === 'string' || typeof value === 'number') parts.push(String(value))
    }
  }
  return parts.join(' ').toLowerCase()
}

/**
 * Delivery Challan errors carry a machine-readable code that is worth showing
 * verbatim: "only 160 is eligible for this customer" tells a store keeper far
 * more than "something went wrong". The messages below are the ones a person
 * can act on.
 */
const DC_ERRORS: Array<[RegExp, string, string]> = [
  [/QUANTITY_EXCEEDED/, 'QUANTITY_EXCEEDED', 'That quantity is more than the eligible balance.'],
  [/INSPECTION_EXCEEDS_RECEIPT/, 'INSPECTION_EXCEEDS_RECEIPT', 'The inspection accounts for more than the quantity received.'],
  [/MACHINING_NOT_RECONCILED/, 'MACHINING_NOT_RECONCILED', 'Input does not reconcile with the outcomes recorded.'],
  [/RETURN_EXCEEDS_REJECTION/, 'RETURN_EXCEEDS_REJECTION', 'That is more than the quantity still to be returned.'],
  [/RETURN_EXCEEDS_SENT/, 'RETURN_EXCEEDS_SENT', 'That is more than the quantity still at the vendor.'],
  [/MATERIAL_NOT_ELIGIBLE/, 'MATERIAL_NOT_ELIGIBLE', 'Only accepted material can be issued for processing.'],
  [/DOCUMENT_CANCELLED/, 'DOCUMENT_CANCELLED', 'This challan is cancelled and cannot be changed.'],
  [/ALREADY_FINALIZED/, 'ALREADY_FINALIZED', 'This challan is already finalized.'],
  [/ALREADY_CANCELLED/, 'ALREADY_CANCELLED', 'This challan is already cancelled.'],
  [/DUPLICATE_NUMBER|dc_documents_org_type_number_key/, 'DUPLICATE_NUMBER', 'That document number is already in use.'],
]

/**
 * The server's own wording, when it is more useful than a generic sentence.
 * "cannot dispatch 500 of KI-101: only 160 is eligible" tells a store clerk
 * exactly what to do; "something went wrong" does not.
 */
function dcDetail(message: string, code: string): string | null {
  const at = message.indexOf(`${code}:`)
  if (at < 0) return null
  const after = message.slice(at + code.length + 1).trim().replace(/^"|"$/g, '').trim()
  return after.length > 0 ? after : null
}

export function friendlyError(error: unknown): string {
  const message = describeError(error, '')
  if (message.includes('customers_org_gstin_key')) return 'A customer with this GSTIN already exists.'
  if (message.includes('products_org_code_key')) return 'A product with this code already exists.'
  if (message.includes('DUPLICATE_BILL')) return 'A possible duplicate bill already exists.'
  if (message.includes('VERSION_CONFLICT')) return 'This record changed elsewhere. Reload it before saving.'
  for (const [pattern, code, fallback] of DC_ERRORS) {
    if (pattern.test(message)) return dcDetail(message, code) ?? fallback
  }
  if (message.includes('VALIDATION_ERROR:')) return message.split('VALIDATION_ERROR: ')[1] ?? 'Please check the form.'
  if (message.includes('FORBIDDEN') || message.includes('row-level security') || message.includes('permission denied')) return 'You do not have permission for this action.'
  if (message.includes('Failed to fetch') || message.includes('NetworkError')) return 'Connection failed. Check your internet and try again.'
  if (isAlreadyBootstrapped(error)) return 'You already have a workspace.'
  if (isSessionRejected(error)) return 'Your session has expired. Sign in again to continue.'
  if (message.includes('No active session found') || message.includes('Failed to retrieve user session')) return 'We could not start your session. Please try again.'
  return GENERIC_ERROR
}

/**
 * friendlyError() collapses every unrecognised failure into one sentence, which is
 * no help to someone deciding what to do next. Screens that can offer a retry use
 * this instead, so an unmapped failure keeps its real cause visible.
 */
export function explainError(error: unknown, fallback: string): string {
  const friendly = friendlyError(error)
  if (friendly !== GENERIC_ERROR) return friendly
  const raw = describeError(error, '')
  return raw.trim() === '' ? fallback : raw
}

/** The database refuses a second workspace; the client is simply out of date. */
export function isAlreadyBootstrapped(error: unknown): boolean {
  // The fingerprint, not just the message: the RPC returns this as a `code` and the
  // value that reaches here is a plain object, which read as "[object Object]".
  const fingerprint = errorFingerprint(error)
  return fingerprint.includes('already_bootstrapped')
    || fingerprint.includes('already belongs to an organization')
}

/**
 * Raised when the token is missing, expired or rejected, rather than merely absent.
 * PGRST301 is what the Neon Data API actually returns for a lapsed 15-minute access
 * token, and it must never be mistaken for "this user has no workspace".
 *
 * Every wording here is matched without regard to case. The SDK's own
 * AuthRequiredError reads "Authentication required. A valid token is needed to
 * access the resource." and a case-sensitive test for "authentication required"
 * missed it, so a save that failed purely because the session had lapsed was
 * reported as the same unexplained "the request could not be completed" that a
 * genuine fault produces.
 *
 * This is the function that makes a refresh unnecessary. When a lapsed session is
 * recognised, `queryWithRetry` re-reads the token and replays the request on its
 * own. When it is *not* recognised - which is what happened whenever the failure
 * arrived as a plain object and the old code read "[object Object]" out of it -
 * nothing was retried and the tab stayed broken until the user reloaded it by
 * hand.
 *
 * So this matches on the whole rejection, not just one string field: the
 * message, any GoTrue `code` / `error_description`, and an HTTP `status` of 401
 * or 403 with no usable text at all.
 */
export function isSessionRejected(error: unknown): boolean {
  // A bare 401/403 is authoritative even when nothing else says so.
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>
    const status = record.status ?? record.statusCode
    if (status === 401 || status === 403) return true
    const code = typeof record.code === 'string' ? record.code.toLowerCase() : ''
    if (code === 'bad_jwt' || code === 'no_token' || code === 'session_not_found'
      || code === 'token_expired' || code === 'jwt_expired' || code === 'unauthorized') return true
  }

  const fingerprint = errorFingerprint(error)
  return fingerprint.includes('pgrst301')
    || fingerprint.includes('unauthenticated')
    || fingerprint.includes('authentication required')
    || fingerprint.includes('a valid token is needed')
    || fingerprint.includes('missing authentication credentials')
    || fingerprint.includes('invalid jwt')
    || fingerprint.includes('bad_jwt')
    || fingerprint.includes('jwt_expired')
    || fingerprint.includes('token is expired')
    || fingerprint.includes('token expired')
    || fingerprint.includes('status:401')
    || fingerprint.includes('status: 401')
    || fingerprint.includes('401 unauthorized')
    || fingerprint.includes('jwt malformed')
    || (fingerprint.includes('jwt') && (fingerprint.includes('expired') || fingerprint.includes('invalid') || fingerprint.includes('malformed')))
}

/**
 * The auth SDK reports a pending email confirmation either as an error
 * (`email_not_confirmed` / `session_not_found`) or, for a successful sign-up
 * response, simply by omitting the session. Both mean the same thing to a user
 * who is waiting on a confirmation link.
 */
export function needsEmailConfirmation(error: unknown): boolean {
  // The fingerprint covers `.code` as well as the message, so a GoTrue rejection
  // that arrives as a plain object is recognised the same way an Error is.
  const fingerprint = errorFingerprint(error)
  if (fingerprint.includes('email_not_confirmed') || fingerprint.includes('session_not_found')) return true
  return fingerprint.includes('email verification required')
    || fingerprint.includes('failed to retrieve user session')
}
