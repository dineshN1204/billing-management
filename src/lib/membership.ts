import { describeError } from './format'
import type { Role } from './types'

/**
 * The workspace, as the signed-in member sees it.
 *
 * The company fields (GSTIN, address, phone, email) are read here rather than
 * through a second query on every page: they are needed by the invoice
 * letterhead, the delivery challan PDF and the settings screen, and three
 * separate reads of the same row is three chances to show a half-loaded
 * letterhead. A missing value is null, never an empty string, so the caller
 * can tell "not filled in" from "filled in with nothing".
 */
export type Organization = {
  id: string
  name: string
  role: Role
  gstin: string | null
  address: string | null
  phone: string | null
  email: string | null
  state_code: string | null
}

const ROLES: Role[] = ['admin', 'staff', 'viewer']

/**
 * The membership lookup has three possible answers, not two. The data API returns
 * `data: null` both when the user genuinely has no membership and when the query
 * itself failed, and treating those the same is what sent returning users to the
 * create-workspace form after a dropped request or an expired token.
 */
export type MembershipLookup =
  | { kind: 'member'; organization: Organization }
  | { kind: 'none' }
  | { kind: 'failed'; message: string }

type MembershipRow = {
  organization_id: string
  role: unknown
  organizations: {
    name?: unknown
    gstin?: unknown
    address?: unknown
    phone?: unknown
    email?: unknown
    state_code?: unknown
  } | null
}

function isMembershipRow(data: unknown): data is MembershipRow {
  return typeof data === 'object' && data !== null && typeof (data as MembershipRow).organization_id === 'string'
}

/** A company field is either a non-empty string or nothing at all. */
function companyText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function describe(error: unknown): string {
  const message = describeError(error, '')
  return message.trim() === '' ? 'The membership lookup failed.' : message
}

/**
 * Turns whatever the membership query produced into an explicit outcome. Only
 * `none` may lead to the onboarding screen; `failed` must be reported as unknown.
 */
export function resolveMembership(data: unknown, error: unknown): MembershipLookup {
  if (error) return { kind: 'failed', message: describe(error) }
  if (!isMembershipRow(data)) return { kind: 'none' }
  const role = ROLES.includes(data.role as Role) ? (data.role as Role) : 'viewer'
  const linked = data.organizations?.name
  const name = typeof linked === 'string' && linked !== '' ? linked : 'Organization'
  return {
    kind: 'member',
    organization: {
      id: data.organization_id,
      role,
      name,
      gstin: companyText(data.organizations?.gstin),
      address: companyText(data.organizations?.address),
      phone: companyText(data.organizations?.phone),
      email: companyText(data.organizations?.email),
      state_code: companyText(data.organizations?.state_code),
    },
  }
}