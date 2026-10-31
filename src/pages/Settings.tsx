import { useCallback, useEffect, useState } from 'react'
import { Card, EmptyState, Field, Loading, PageTitle, SelectField } from '../components/ui'
import { Button } from '../components/ui'
import { CompanyProfileCard } from '../components/CompanyProfileCard'
import { useAuth } from '../lib/auth'
import { settle } from '../lib/async'
import { db } from '../lib/db'
import { displayDate, friendlyError } from '../lib/format'
import type { Role } from '../lib/types'

type Member = {
  user_id: string
  email: string | null
  role: Role
  member_since: string
  is_you: boolean
}

/**
 * The three roles the database enforces, described in the words the shop floor
 * uses. `app_private.can_write` treats admin and staff identically, and viewer
 * as read-only, so the permissions below are exactly what the backend will
 * allow - not a promise the frontend makes on its own.
 *
 * Changing a role, or removing someone, is enforced again by
 * public.set_organization_member_role and public.deactivate_organization_member.
 * Hiding these controls is a convenience, never the protection.
 */
const ROLE_INFO: Record<Role, { title: string; summary: string }> = {
  admin: {
    title: 'Company admin',
    summary: 'Everything a staff member can do, plus managing team access and DC settings. Keep this to one or two people.',
  },
  staff: {
    title: 'Staff',
    summary: 'Create and edit bills, challans, customers, products and stock. Day-to-day use for the accountant, storekeeper, production and quality staff.',
  },
  viewer: {
    title: 'Read-only',
    summary: 'Can see every record and print or export, but cannot change or save anything. Suitable for management review.',
  },
}

const ROLE_OPTIONS: Array<[Role, string]> = [
  ['staff', 'Staff · create and edit records'],
  ['viewer', 'Read-only · view, print and export only'],
  ['admin', 'Company admin · also manage access'],
]

export function Settings() {
  const { organization, user, refresh } = useAuth()
  const [members, setMembers] = useState<Member[]>([])
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('staff')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [pendingUser, setPendingUser] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  const isAdmin = organization?.role === 'admin'

  const load = useCallback(async () => {
    setLoading(true)
    // list_organization_members resolves the email address, which memberships
    // does not carry. Until migration 0020 is applied this RPC is absent and the
    // members table cannot be read, so fall back to the plain membership rows and
    // say so rather than showing an empty list that looks like "no employees".
    const listed = await settle(() => db.rpc('list_organization_members', { target_organization_id: organization?.id ?? null }))
    if (listed.ok && !listed.value.error) {
      setMembers((listed.value.data ?? []) as Member[])
      setError('')
      setLoading(false)
      return
    }
    const plain = await settle(() => db.from('memberships').select('user_id,role,created_at').eq('organization_id', organization!.id))
    if (!plain.ok) { setError(friendlyError(plain.error)); setLoading(false); return }
    if (plain.value.error) { setError(friendlyError(plain.value.error)); setLoading(false); return }
    setMembers((plain.value.data ?? []).map(row => ({
      user_id: row.user_id as string,
      email: null,
      role: row.role as Role,
      member_since: row.created_at as string,
      is_you: row.user_id === user?.id,
    })))
    setError('')
    setLoading(false)
  }, [organization, user])

  useEffect(() => {
    if (!organization) return
    void load()
  }, [organization, reload, load])

  async function add(event: React.FormEvent) {
    event.preventDefault()
    if (!organization || busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const { error: addError } = await db.rpc('add_organization_member', {
        org_id: organization.id,
        member_email: email,
        member_role: role,
      })
      if (addError) {
        setError(
          addError.message.includes('already belongs') ? 'This person already has access.'
            : addError.message.includes('confirmed account') ? 'Ask them to create an account with this email address and confirm it first. Their email is never shown here.'
              : friendlyError(addError),
        )
      } else {
        setNotice(`${email} can now sign in.`)
        setEmail('')
        setReload(n => n + 1)
      }
    } catch (cause) {
      setError(friendlyError(cause))
    } finally {
      setBusy(false)
    }
  }

  async function changeRole(member: Member, next: Role) {
    if (member.role === next || busy) return
    setPendingUser(member.user_id)
    setError(''); setNotice('')
    try {
      const result = await db.rpc('set_organization_member_role', { target_user_id: member.user_id, new_role: next })
      if (result.error) {
        setError(result.error.message.includes('LAST_ADMIN')
          ? 'That is the only admin. Promote someone else to admin first, or you will not be able to manage access.'
          : friendlyError(result.error))
      } else {
        setNotice(`${member.email ?? 'That person'} is now ${next === 'admin' ? 'a company admin' : next === 'staff' ? 'staff' : 'read-only'}.`)
        setReload(n => n + 1)
      }
    } catch (cause) {
      setError(friendlyError(cause))
    } finally {
      setPendingUser(null)
    }
  }

  async function remove(member: Member) {
    if (busy) return
    const who = member.email ?? 'this person'
    if (!window.confirm(`Remove ${who} from this workspace?\n\nThey will immediately lose access to every bill, challan, customer and stock record. Records they created are kept.`)) return
    setPendingUser(member.user_id)
    setError(''); setNotice('')
    try {
      const result = await db.rpc('deactivate_organization_member', { target_user_id: member.user_id })
      if (result.error) {
        setError(result.error.message.includes('LAST_ADMIN')
          ? 'That is the only admin. Promote someone else to admin before removing access.'
          : result.error.message.includes('CANNOT_REMOVE_SELF')
            ? 'You cannot remove your own access. Ask another admin to do it.'
            : friendlyError(result.error))
      } else {
        setNotice(`${who} no longer has access.`)
        setReload(n => n + 1)
      }
    } catch (cause) {
      setError(friendlyError(cause))
    } finally {
      setPendingUser(null)
    }
  }

  return (
    <div className="settings-page">
      <PageTitle
        eyebrow="WORKSPACE"
        title="Employee access"
        description={organization?.name}
      />

      <Card className="detail-card">
        <h2>Your account</h2>
        <dl className="detail-list">
          <dt>Signed in as</dt><dd>{user?.email}</dd>
          <dt>Your role</dt><dd><strong>{ROLE_INFO[organization?.role ?? 'viewer'].title}</strong></dd>
          <dt>Organization</dt><dd>{organization?.name}</dd>
        </dl>
      </Card>

      {organization && (
        <CompanyProfileCard
          organization={organization}
          // The letterhead is read from the signed-in workspace, so the session
          // has to be re-read after a change or the page keeps showing the old
          // details until the next reload.
          onSaved={async () => { await refresh() }}
        />
      )}

      <Card className="detail-card">
        <div className="section-heading">
          <span className="section-number">{members.length}</span>
          <div>
            <h2>Who can use this system</h2>
            <p>Each person signs in with their own email address. Access is enforced by the database, not by this screen.</p>
          </div>
        </div>

        {error && <p role="alert" className="error-box">{error}</p>}
        {notice && <p role="status" className="success-box">{notice}</p>}

        {loading ? <Loading label="Loading members..." /> : members.length === 0 ? (
          <EmptyState title="No members listed" description="Add a teammate below to give them access." />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Person</th><th>Role</th><th>Added</th>{isAdmin && <th>Change access</th>}
                </tr>
              </thead>
              <tbody>
                {members.map(member => (
                  <tr key={member.user_id}>
                    <td>
                      <span className="table-primary">
                        {member.email ?? <span className="muted mono">{member.user_id.slice(0, 8)}…</span>}
                      </span>
                      {member.is_you && <span className="muted"> (you)</span>}
                    </td>
                    <td><span className={`status ${member.role === 'admin' ? 'status-success' : member.role === 'viewer' ? 'status-warning' : ''}`}>{ROLE_INFO[member.role]?.title ?? member.role}</span></td>
                    <td>{displayDate(member.member_since)}</td>
                    {isAdmin && (
                      <td>
                        <div className="inline-actions">
                          <SelectField
                            label=""
                            aria-label={`Role for ${member.email ?? member.user_id}`}
                            value={member.role}
                            disabled={pendingUser === member.user_id}
                            onChange={e => void changeRole(member, e.target.value as Role)}
                          >
                            {ROLE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                          </SelectField>
                          {!member.is_you && (
                            <Button
                              variant="danger"
                              disabled={pendingUser === member.user_id}
                              onClick={() => void remove(member)}
                            >
                              Remove
                            </Button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {members.some(member => !member.email) && (
          <p className="muted top-gap">
            Some addresses are not resolving. Apply migration <code className="mono">0020_employee_roles.sql</code> to show
            each person's email instead of their internal id.
          </p>
        )}
      </Card>

      {isAdmin && (
        <Card className="detail-card">
          <h2>Add a team member</h2>
          <p className="muted">
            The person creates their own account with this email address and confirms it, then appears here for you
            to give a role. You never need their password.
          </p>
          <form onSubmit={add} className="top-gap">
            <div className="form-grid">
              <Field
                label="Their email address"
                type="email"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="name@kallazhagar.com"
              />
              <SelectField label="Role" value={role} onChange={e => setRole(e.target.value as Role)}>
                {ROLE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </SelectField>
            </div>
            <div className="top-gap">
              <Button disabled={busy || !email.trim()}>{busy ? 'Adding...' : 'Give access'}</Button>
            </div>
          </form>
        </Card>
      )}

      <Card className="detail-card">
        <h2>What each role can do</h2>
        <dl className="detail-list">
          {(['admin', 'staff', 'viewer'] as Role[]).map(key => (
            <div key={key} style={{ display: 'contents' }}>
              <dt>{ROLE_INFO[key].title}</dt>
              <dd>{ROLE_INFO[key].summary}</dd>
            </div>
          ))}
        </dl>
        <p className="muted top-gap">
          Roles are enforced in the database on every read and every write, including the quantity columns a
          delivery challan moves. A browser cannot grant itself permission it does not have.
        </p>
      </Card>

    </div>
  )
}