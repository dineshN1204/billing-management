import { createClient, defaultDeriveNeonUrls, SupabaseAuthAdapter } from '@neondatabase/neon-js'
import type { Database } from './database.types'
import { describeError, isSessionRejected } from './format'

const databaseUrl = import.meta.env.VITE_NEON_DATABASE_URL ?? import.meta.env.VITE_NEON_URL

export const databaseConfigured = Boolean(databaseUrl)
export const apiUrl = import.meta.env.VITE_NEON_API_URL ?? ''
export const processBillUrl = import.meta.env.VITE_NEON_PROCESS_BILL_URL ?? ''
export const backendConfigured = Boolean(databaseUrl && apiUrl && processBillUrl)

const urls = defaultDeriveNeonUrls(databaseUrl ?? 'https://ep-invalid.neon.build/neondb')

export const db = createClient<Database>({
  auth: { url: urls.auth, adapter: SupabaseAuthAdapter() },
  dataApi: { url: urls.dataApi, options: { global: { fetch: recoveringFetch } } },
})

/**
 * Re-reads the session from the auth server and returns the token it hands back.
 *
 * `getSession()` on its own is served from the SDK's in-memory session and is
 * only re-read from the network when the SDK decides to. `forceFetch` is what
 * actually goes back to the auth server, so this is the only call here that can
 * turn a token the Data API has already rejected into one it will accept.
 */
export async function refreshSessionToken(): Promise<string | null> {
  const { data } = await db.auth.getSession({ forceFetch: true })
  return data?.session?.access_token ?? null
}

/** One in-flight forced read shared by every request that failed at the same moment. */
let pendingRefresh: Promise<string | null> | null = null

function sharedRefresh(): Promise<string | null> {
  pendingRefresh ??= refreshSessionToken()
    .catch(() => null)
    .finally(() => { pendingRefresh = null })
  return pendingRefresh
}

/**
 * Whether the Data API turned the request away over the bearer token rather than
 * over the query itself.
 *
 * A missing or unusable JWT comes back as HTTP 400 with a fixed message rather
 * than 401, so the status alone cannot tell it apart from a genuine SQL error and
 * the body has to be read. Both are rejected in the API's auth layer, before the
 * statement reaches Postgres, which is what makes the retry safe to run against
 * the write RPCs too.
 */
function rejectedForAuth(response: Response, body: string): boolean {
  if (response.status === 401) return true
  return response.status === 400 && /authentication|jwt|bearer token/i.test(body)
}

/**
 * Every Data API call goes through here.
 *
 * The SDK injects the session token once, before the request leaves, and never
 * revisits it. A tab that has been open long enough for that token to expire
 * therefore keeps sending a token the Data API rejects, and because nothing in
 * the SDK asks for a new one the tab stays broken until it is reloaded - a full
 * page refresh worked only because remounting the app re-read the session before
 * any query was sent. Re-reading the session and replaying the single failed
 * request makes that recovery happen on its own.
 */
async function recoveringFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init)
  if (response.status !== 400 && response.status !== 401) return response
  // A clone, because the caller still has to be able to read the body of
  // whichever response is finally handed back.
  const body = await response.clone().text().catch(() => '')
  if (!rejectedForAuth(response, body)) return response
  const token = await sharedRefresh()
  if (!token) return response
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${token}`)
  return fetch(input, { ...init, headers })
}

export async function accessToken(): Promise<string | null> {
  const { data, error } = await db.auth.getSession()
  if (error || !data?.session?.access_token) return null
  return data.session.access_token
}

/**
 * A PGRST202 for a function this app knows exists.
 *
 * PostgREST resolves a function through a schema cache it builds at start-up and
 * refreshes on notification. A branch running more than one compute can end up
 * with caches of different ages, and a request served by one that predates the
 * most recent migration is told the function is not there at all. On the
 * production branch this was exactly half of all calls.
 *
 * The function is present - the migration created it and another compute says
 * so - and the statement was never reached, so repeating the call is safe and
 * lands on a compute with a fresh cache.
 */
function isMissingFromSchemaCache(cause: unknown): boolean {
  const message = describeError(cause, '')
  return message.includes('PGRST202') || message.includes('in the schema cache')
}

/**
 * Runs a Data API call and, if what failed was the session rather than the query,
 * re-reads the session and tries the same call again.
 *
 * The fetch above covers a token the server has stopped accepting. It cannot
 * cover a token the SDK never produced: when getJWTToken() comes back empty the
 * SDK throws AuthRequiredError before a request is made, so nothing downstream of
 * the fetch gets a chance to recover. A challan form left open long enough for
 * the session to lapse therefore failed on submit and stayed failed until the
 * page was reloaded by hand.
 *
 * Both of those failures are raised before the statement reaches Postgres, so
 * repeating the call cannot apply a write twice. A call that fails for any other
 * reason is re-thrown untouched and never repeated.
 */
export async function queryWithRetry<T extends { error: unknown }>(run: () => PromiseLike<T>): Promise<T> {
  const attempts = 3
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await run()
      const failure = result.error
      if (!failure || attempt >= attempts) return result
      if (isSessionRejected(failure)) await refreshSessionToken()
      else if (!isMissingFromSchemaCache(failure)) return result
    } catch (cause) {
      if (attempt >= attempts) throw cause
      if (isSessionRejected(cause)) await refreshSessionToken()
      else if (!isMissingFromSchemaCache(cause)) throw cause
    }
  }
}

export async function backendRequest<T>(base: string, path: string, init: RequestInit = {}): Promise<T> {
  const token = await accessToken()
  if (!token) throw new Error('Not authenticated')
  const response = await fetch(`${base.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  })
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null
  if (!response.ok) throw new Error(payload?.error ?? `Request failed (${response.status})`)
  return payload as T
}