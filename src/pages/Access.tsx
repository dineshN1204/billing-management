import { useState } from 'react'
import { BookOpen, ShieldCheck } from 'lucide-react'
import { Button, Card, Field, Loading } from '../components/ui'
import { useAuth } from '../lib/auth'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { explainError, isAlreadyBootstrapped, isSessionRejected, needsEmailConfirmation, normalizeGstin } from '../lib/format'
import { landingTarget } from '../lib/navigation'
import { db } from '../lib/db'

type SearchResult = { id: string; name: string; gstin: string | null; state_code: string | null }

export function SignIn() {
  const navigate = useNavigate()
  const location = useLocation()
  const { refresh, user, organization, loading, loadError } = useAuth()
  const [register, setRegister] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError(''); setNotice(''); setBusy(true)
    const confirmByEmail = () => setNotice('Check your email to confirm your account, then sign in.')
    try {
      const result = register ? await db.auth.signUp({ email, password }) : await db.auth.signInWithPassword({ email, password })
      if (result.error) throw result.error
      // A sign-up that returns no session user still needs email confirmation.
      if (register && !result.data?.session?.user) {
        confirmByEmail()
      } else {
        // onAuthStateChange never fires for mutations made in this tab, so the
        // session has to be read back before the app can leave this screen.
        await refresh()
        // RequireSession stored the route that was originally asked for.
        navigate(landingTarget(location.state), { replace: true })
      }
    } catch (cause) {
      if (needsEmailConfirmation(cause)) confirmByEmail()
      else setError(explainError(cause, 'Sign in failed.'))
    } finally {
      setBusy(false)
    }
  }
  if (loading) return <Boot />
  // A failed lookup is not an empty workspace: send them to the gate, which offers a retry.
  if (user) return <Navigate to={organization || loadError ? '/' : '/onboarding'} replace />
  return <main className="access-layout"><div className="access-brand"><BookOpen size={36} /><h1>Your bill book,<br />finally searchable.</h1><p>Every customer. Every invoice. One reliable place for your business records.</p><div className="access-foot"><ShieldCheck size={17} /> Private by design · Built for accurate records</div></div><Card className="access-card"><div className="eyebrow">BILLBOOK / ACCOUNT</div><h2>{register ? 'Create your account' : 'Welcome back'}</h2><p>{register ? 'Start with your business email.' : 'Sign in to your business workspace.'}</p><form onSubmit={submit}><Field label="Email address" type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} /><Field label="Password" type="password" autoComplete={register ? 'new-password' : 'current-password'} minLength={6} required value={password} onChange={event => setPassword(event.target.value)} />{error && <p role="alert" className="error-box">{error}</p>}{notice && <p role="status" className="success-box">{notice}</p>}<Button disabled={busy} type="submit">{busy ? 'Please wait...' : register ? 'Create account' : 'Sign in'}</Button></form><button className="text-link" onClick={() => { setRegister(!register); setError(''); setNotice('') }}>{register ? 'Already have an account? Sign in' : 'New here? Create an account'}</button></Card></main>
}

export function Onboarding() {
  const { refresh, signOut, user, organization, loading, loadError } = useAuth()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [gstin, setGstin] = useState('')
  const [busy, setBusy] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [error, setError] = useState('')
  const [signOutError, setSignOutError] = useState('')
  const [mode, setMode] = useState<'create' | 'join'>('create')
  const [joinGstin, setJoinGstin] = useState('')
  const [joinName, setJoinName] = useState('')
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<SearchResult | null>(null)
  const [joiningId, setJoiningId] = useState<string | null>(null)
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const { error: resultError } = await db.rpc('bootstrap_organization', { org_name: name.trim(), org_gstin: gstin ? normalizeGstin(gstin) : null })
      if (resultError && !isAlreadyBootstrapped(resultError)) {
        setError(explainError(resultError, 'We could not create your workspace. Please try again.'))
        return
      }
      // A workspace that already exists is not a failure worth shouting about: this
      // client simply did not know about it. Read it back and only leave this screen
      // once the membership is actually visible.
      const snapshot = await refresh()
      if (snapshot.organization) navigate('/', { replace: true })
      else setError(snapshot.loadError ? explainError(snapshot.loadError, 'Your workspace exists but could not be loaded. Try again in a moment.') : 'Your workspace exists but could not be loaded. Try again in a moment.')
    } catch (cause) {
      // A thrown call is still a failed attempt, and its raw reason is the only clue.
      setError(explainError(cause, 'We could not create your workspace. Please try again.'))
    } finally {
      setBusy(false)
    }
  }
  async function search(event: React.FormEvent) {
    event.preventDefault(); setError(''); setSelected(null); setResults(null); setSearching(true)
    try {
      const { data, error } = await db.rpc('search_organizations', {
        p_gstin: joinGstin.trim() ? normalizeGstin(joinGstin) : null,
        p_name: joinName.trim() || null,
      })
      if (error) throw error
      setResults(data ?? [])
    } catch (cause) {
      setError(explainError(cause, 'We could not search for companies. Please try again.'))
    } finally {
      setSearching(false)
    }
  }
  async function join(orgId: string) {
    setJoiningId(orgId); setError('')
    try {
      const { error: resultError } = await db.rpc('join_organization', { p_org_id: orgId })
      if (resultError && !isAlreadyBootstrapped(resultError)) {
        setError(explainError(resultError, 'We could not join this company. Please try again.'))
        return
      }
      // Same re-read pattern as the create path: only leave this screen once
      // the membership is actually visible.
      const snapshot = await refresh()
      if (snapshot.organization) navigate('/', { replace: true })
      else setError(snapshot.loadError ? explainError(snapshot.loadError, 'Your workspace exists but could not be loaded. Try again in a moment.') : 'Your workspace exists but could not be loaded. Try again in a moment.')
    } catch (cause) {
      setError(explainError(cause, 'We could not join this company. Please try again.'))
    } finally {
      setJoiningId(null)
    }
  }
  async function retry() { setRetrying(true); await refresh(); setRetrying(false) }
  async function leave() {
    setLeaving(true); setSignOutError('')
    const failure = await signOut()
    // On success the provider drops the user and this screen unmounts.
    if (failure) { setSignOutError(explainError(failure, 'Could not sign out. Please try again.')); setLeaving(false) }
  }
  if (loading) return <Boot />
  if (!user) return <Navigate to="/signin" replace />
  if (organization) return <Navigate to="/" replace />
  if (loadError) return <LoadWorkspaceError message={loadError} busy={retrying} onRetry={() => { void retry() }} />
  return <main className="setup-layout"><Card className="access-card"><div className="eyebrow">ONE-TIME SETUP</div><h1>Set up your workspace</h1><p>Create the organization that owns your records, or join one that already exists.</p><div className="tabs" role="group" aria-label="Workspace setup"><button type="button" aria-pressed={mode === 'create'} className={mode === 'create' ? 'active' : ''} onClick={() => { setMode('create'); setError('') }}>Create new company</button><button type="button" aria-pressed={mode === 'join'} className={mode === 'join' ? 'active' : ''} onClick={() => { setMode('join'); setError(''); setResults(null); setSelected(null) }}>Join existing company</button></div>{mode === 'create'
    ? <form onSubmit={submit}><Field label="Business name" required minLength={2} maxLength={120} value={name} onChange={e => setName(e.target.value)} /><Field label="Business GSTIN (optional)" value={gstin} onChange={e => setGstin(e.target.value)} />{error && <p role="alert" className="error-box">{error}</p>}<Button type="submit" disabled={busy}>{busy ? 'Creating...' : 'Create workspace'}</Button></form>
    : <>
        <form onSubmit={search}><Field label="Business GSTIN" placeholder="e.g. 27AAPFU0939F1ZV" value={joinGstin} onChange={e => setJoinGstin(e.target.value)} /><Field label="Company name (optional)" value={joinName} onChange={e => setJoinName(e.target.value)} />{error && <p role="alert" className="error-box">{error}</p>}<Button type="submit" disabled={searching || joiningId !== null}>{searching ? 'Searching...' : 'Search companies'}</Button></form>
        {results !== null && (results.length === 0
          ? <p className="muted top-gap">No company found with that GSTIN. Double-check the number, or create a new company.</p>
          : <div className="choices top-gap">{results.map(result => (
              <button key={result.id} type="button" onClick={() => { setSelected(result); setError('') }}>
                <strong>{result.name}</strong>
                <small>{[result.gstin, result.state_code].filter(Boolean).join(' · ') || 'No GSTIN'}</small>
              </button>
            ))}</div>)}
        {selected && <div className="selected-entity"><div><strong>Join {selected.name}?</strong><small>You will join as read-only. An admin can change your role later.</small></div><Button type="button" disabled={joiningId !== null} onClick={() => void join(selected.id)}>{joiningId === selected.id ? 'Joining...' : 'Confirm join'}</Button><Button variant="ghost" type="button" disabled={joiningId !== null} onClick={() => setSelected(null)}>Cancel</Button></div>}
      </>}
<div className="divider" /><p className="muted">Signed in as {user.email}</p>{signOutError && <p role="alert" className="error-box">{signOutError}</p>}<Button variant="ghost" disabled={leaving} onClick={() => void leave()}>{leaving ? 'Signing out...' : 'Sign out'}</Button></Card></main>
}

/**
 * Shown when the account is signed in but the workspace could not be read. This is
 * deliberately not the create-workspace form: offering that to a user who already
 * has a workspace is what turned a dropped request into a second one.
 */
export function LoadWorkspaceError({ message, busy, onRetry }: { message: string | null; busy: boolean; onRetry: () => void }) {
  const { signOut } = useAuth()
  const [leaving, setLeaving] = useState(false)
  const [signOutError, setSignOutError] = useState('')
  // A lapsed access token cannot be retried away, so the way forward is a fresh
  // session rather than another attempt at the same request.
  const expired = message !== null && isSessionRejected(message)
  const detail = message ? explainError(message, 'We could not reach the server to read your workspace. Please try again.') : ''
  async function leave() {
    setLeaving(true); setSignOutError('')
    const failure = await signOut()
    if (failure) { setSignOutError(explainError(failure, 'Could not sign out. Please try again.')); setLeaving(false) }
  }
  return <main className="setup-layout"><Card className="access-card"><div className="eyebrow">WORKSPACE</div><h1>{expired ? 'Your session has expired' : 'We could not load your workspace'}</h1><p>{expired ? 'Sign in again and you will go straight back to your workspace.' : 'Your account is fine. We could not read your workspace just now, so we stopped here instead of showing the setup form.'}</p>{detail && <p role="alert" className="error-box">{detail}</p>}{expired
    ? <Button type="button" disabled={leaving} onClick={() => void leave()}>{leaving ? 'Signing out...' : 'Sign in again'}</Button>
    : <Button type="button" disabled={busy} onClick={onRetry}>{busy ? 'Trying again...' : 'Try again'}</Button>}<div className="divider" />{expired
    ? <Button variant="secondary" disabled={busy} onClick={onRetry}>{busy ? 'Trying again...' : 'Try again'}</Button>
    : <Button variant="ghost" disabled={leaving} onClick={() => void leave()}>{leaving ? 'Signing out...' : 'Sign out'}</Button>}{signOutError && <p role="alert" className="error-box">{signOutError}</p>}</Card></main>
}

export function Boot() { return <div className="boot"><Loading label="Opening your workspace..." /></div> }
