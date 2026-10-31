import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { db } from './db'
import { resolveMembership } from './membership'
import { describeError } from './format'
import type { MembershipLookup, Organization } from './membership'

export type SessionUser = { id: string; email?: string | null }

/**
 * How often a still-open tab re-reads its session from the auth server.
 *
 * The SDK caches the session in memory and schedules no refresh of its own, so a
 * tab left alone keeps presenting the same bearer token until the server stops
 * accepting it. Ten minutes sits comfortably inside the lifetime of the token
 * the server issues, and the alternative - discovering the expiry through a
 * failed query - is what left both dashboards showing an error until the page
 * was reloaded by hand.
 */
const SESSION_REFRESH_MS = 10 * 60 * 1000

/**
 * `loadError` is what keeps a failed lookup honest: `organization` is null both
 * when the user has no workspace and when we simply could not read it, and only
 * the second case may be told apart from the first by `loadError` being set.
 */
export type AuthSnapshot = { user: SessionUser | null; organization: Organization | null; loadError: string | null }

type AuthState = AuthSnapshot & {
  loading: boolean
  refresh: () => Promise<AuthSnapshot>
  signOut: () => Promise<Error | null>
}
const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [organization, setOrganization] = useState<Organization | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // The SDK only emits auth state changes for *other* browser tabs, so every
  // mutation made in this tab has to call refresh() by hand. Several of those
  // can overlap (mount + INITIAL_SESSION + post-mutation), so each call claims a
  // ticket and only the newest one is allowed to commit state.
  const ticket = useRef(0)
  // Callers of refresh() need the committed outcome, which is not necessarily the
  // one they computed, so the newest snapshot is kept outside React state.
  const latest = useRef<AuthSnapshot>({ user: null, organization: null, loadError: null })

  /**
   * One automatic retry, because the usual causes are a token that is a moment past
   * its expiry and a single dropped request, and both clear on a second attempt.
   */
  async function readMembership(userId: string): Promise<MembershipLookup> {
    let failure: unknown = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 400))
      try {
        const result = await db.from('memberships').select('organization_id,role,organizations(name,gstin,address,phone,email,state_code)').eq('user_id', userId).limit(1).maybeSingle()
        return resolveMembership(result.data, result.error)
      } catch (cause) {
        failure = cause
      }
    }
    return resolveMembership(null, failure)
  }

  async function refresh(): Promise<AuthSnapshot> {
    const claim = ++ticket.current
    const commit = (next: AuthSnapshot) => {
      if (claim !== ticket.current) return
      latest.current = next
      setUser(next.user)
      setOrganization(next.organization)
      setLoadError(next.loadError)
      setLoading(false)
    }
    try {
      const session = await db.auth.getSession()
      if (claim !== ticket.current) return latest.current
      const identity = session.error ? null : session.data?.session?.user
      if (!identity) {
        commit({ user: null, organization: null, loadError: null })
        return latest.current
      }
      const nextUser: SessionUser = { id: identity.id, email: identity.email }
      const lookup = await readMembership(identity.id)
      if (claim !== ticket.current) return latest.current
      // A failed lookup leaves the workspace unknown, so the user stays signed in
      // and the app asks them to retry instead of showing the create-workspace form.
      // The raw reason is kept so the screen can still tell a dead session apart
      // from a dropped connection; it is turned into a readable line on the way out.
      if (lookup.kind === 'failed') {
        commit({ user: nextUser, organization: null, loadError: lookup.message })
        return latest.current
      }
      commit({ user: nextUser, organization: lookup.kind === 'member' ? lookup.organization : null, loadError: null })
      return latest.current
    } catch {
      commit({ user: null, organization: null, loadError: null })
      return latest.current
    }
  }

  async function signOut(): Promise<Error | null> {
    let failure: Error | null = null
    try {
      // signOut is typed as never failing, but the SDK does surface auth errors
      // here, and it may hand back a plain object rather than an Error.
      const result = (await db.auth.signOut()) as { error?: unknown }
      if (result.error) failure = result.error instanceof Error ? result.error : new Error(describeError(result.error, 'Could not sign out.'))
    } catch (cause) {
      failure = cause instanceof Error ? cause : new Error(describeError(cause, 'Could not sign out. Please try again.'))
    }
    // Always re-read the session, otherwise a rejected sign-out leaves the UI stuck.
    await refresh()
    return failure
  }

  useEffect(() => {
    void refresh()
    const { data: listener } = db.auth.onAuthStateChange(() => { void refresh() })

    // Both of these only refresh the session held by the SDK. They deliberately
    // do not go through refresh(), because nothing about the user or their
    // workspace can have changed while the tab was idle or hidden, and re-reading
    // the membership would put a second query in front of every page load.
    const keepAlive = window.setInterval(() => { void db.auth.getSession({ forceFetch: true }) }, SESSION_REFRESH_MS)
    const recheckOnReturn = () => {
      if (document.visibilityState === 'visible') void db.auth.getSession({ forceFetch: true })
    }
    document.addEventListener('visibilitychange', recheckOnReturn)

    return () => {
      window.clearInterval(keepAlive)
      document.removeEventListener('visibilitychange', recheckOnReturn)
      listener.subscription.unsubscribe()
    }
  }, [])

  return <AuthContext.Provider value={{ user, organization, loading, loadError, refresh, signOut }}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('AuthProvider is missing')
  return value
}
