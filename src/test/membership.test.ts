import { describe, expect, it } from 'vitest'
import { resolveMembership } from '../lib/membership'
import { isSessionRejected } from '../lib/format'

const row = { organization_id: 'org-1', role: 'admin', organizations: { name: 'Sharma Traders' } }

/** A workspace with no company details filled in yet. */
const noCompany = {
  gstin: null,
  address: null,
  phone: null,
  email: null,
  state_code: null,
}

describe('membership lookup', () => {
  it('reads the workspace from a membership row', () => {
    expect(resolveMembership(row, null)).toEqual({
      kind: 'member',
      organization: { id: 'org-1', role: 'admin', name: 'Sharma Traders', ...noCompany },
    })
  })
  it('reads the company details that print on every letterhead', () => {
    expect(resolveMembership({
      organization_id: 'org-1',
      role: 'admin',
      organizations: {
        name: 'Kallazhagar Industries',
        gstin: '33ABCDE1234F1Z5',
        address: '1 Industrial Estate',
        phone: '+91 44 1234 5678',
        email: 'accounts@kallazhagar.in',
        state_code: '33',
      },
    }, null)).toEqual({
      kind: 'member',
      organization: {
        id: 'org-1',
        role: 'admin',
        name: 'Kallazhagar Industries',
        gstin: '33ABCDE1234F1Z5',
        address: '1 Industrial Estate',
        phone: '+91 44 1234 5678',
        email: 'accounts@kallazhagar.in',
        state_code: '33',
      },
    })
  })
  it('treats an empty company field as nothing at all, not as an empty string', () => {
    const lookup = resolveMembership({
      organization_id: 'org-1',
      role: 'staff',
      organizations: { name: 'Acme', gstin: '   ', address: '' },
    }, null)
    expect(lookup.kind === 'member' && lookup.organization.gstin).toBeNull()
    expect(lookup.kind === 'member' && lookup.organization.address).toBeNull()
  })
  it('treats no rows as a genuinely new user', () => {
    expect(resolveMembership(null, null)).toEqual({ kind: 'none' })
  })
  it('never reports a failed lookup as a missing workspace', () => {
    // The data API answers with data: null for both cases, so the error has to win.
    expect(resolveMembership(null, new Error('PGRST301: JWT expired'))).toEqual({ kind: 'failed', message: 'PGRST301: JWT expired' })
    expect(resolveMembership(row, 'Failed to fetch')).toEqual({ kind: 'failed', message: 'Failed to fetch' })
  })
  it('keeps the reason detectable so the screen can offer a fresh session', () => {
    const lookup = resolveMembership(null, new Error('PGRST301'))
    expect(lookup.kind === 'failed' && isSessionRejected(lookup.message)).toBe(true)
  })
  it('falls back when an error carries no text', () => {
    expect(resolveMembership(null, new Error(''))).toEqual({ kind: 'failed', message: 'The membership lookup failed.' })
  })
  it('tolerates an incomplete row instead of crashing', () => {
    expect(resolveMembership({ role: 'admin' }, null)).toEqual({ kind: 'none' })
    expect(resolveMembership({ organization_id: 'org-9', role: 'wizard', organizations: null }, null)).toEqual({
      kind: 'member',
      organization: { id: 'org-9', role: 'viewer', name: 'Organization', ...noCompany },
    })
  })
})