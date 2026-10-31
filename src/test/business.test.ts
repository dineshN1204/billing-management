import { describe, expect, it } from 'vitest'
import { billRemaining, calculateBill, paymentBalance } from '../lib/calculations'
import { explainError, friendlyError, isAlreadyBootstrapped, isSessionRejected, isValidGstin, financialYear, needsEmailConfirmation, normalizeGstin } from '../lib/format'

const item = { product_name: 'Shaft', unit: 'NOS', quantity: '2', rate: '100.00', discount: '10', gst_rate: '18' }

describe('business rules', () => {
  it('normalizes and validates GSTINs without inventing missing values', () => {
    expect(normalizeGstin(' 33 abcde 1234 f 1 z 5 ')).toBe('33ABCDE1234F1Z5')
    expect(isValidGstin('33 abcde 1234 f 1 z 5')).toBe(true)
    expect(isValidGstin('')).toBe(false)
  })
  it('uses April to March financial years', () => {
    expect(financialYear('2026-03-31')).toBe('2025-26')
    expect(financialYear('2026-04-01')).toBe('2026-27')
  })
  it('calculates intra-state and inter-state taxes from the discounted amount', () => {
    expect(calculateBill([item], 'intra')).toMatchObject({ subtotal: 200, discount: 10, taxable: 190, cgst: 17.1, sgst: 17.1, total: 224.2 })
    expect(calculateBill([item], 'inter')).toMatchObject({ taxable: 190, igst: 34.2, total: 224.2 })
  })
})

/**
 * What has been received against a bill.
 *
 * The same rule the database applies (migration 0038): an unpaid bill has
 * received nothing, a paid bill has received its whole total, and a partly
 * paid bill has received what has been typed into it.
 */
describe('the amount received against a bill', () => {
  it('says an unpaid bill has received nothing', () => {
    expect(paymentBalance(11800, 'unpaid', '')).toEqual({ received: 0, remaining: 11800 })
  })

  it('says a paid bill has received its whole total', () => {
    expect(paymentBalance(11800, 'paid', '')).toEqual({ received: 11800, remaining: 0 })
  })

  it('takes what has been typed for a partly paid bill', () => {
    expect(paymentBalance(11800, 'partial', '5000')).toEqual({ received: 5000, remaining: 6800 })
  })

  it('treats an empty or unreadable amount as nothing received', () => {
    expect(paymentBalance(11800, 'partial', '')).toEqual({ received: 0, remaining: 11800 })
    expect(paymentBalance(11800, 'partial', 'not a number')).toEqual({ received: 0, remaining: 11800 })
  })

  it('never reports a negative balance', () => {
    expect(paymentBalance(11800, 'partial', '20000')).toEqual({ received: 20000, remaining: 0 })
  })

  it('rounds the balance to the two decimals the money is stored in', () => {
    // The columns are numeric(14,2), so the database stores 33.33 and the
    // balance it works out is 100 - 33.33. The form has to arrive at the same
    // figure, or the number on the screen and the number on the bill differ.
    expect(paymentBalance(100, 'partial', '33.333')).toEqual({ received: 33.333, remaining: 66.67 })
  })
})

/**
 * What a bill still owes.
 *
 * The generated column is the authority. The fallback is for the moment when
 * the Data API's schema cache is older than the migration that added it: the
 * browser then reads a row without the column, and the balance is worked out
 * from the two columns it does have rather than showing a wrong zero.
 */
describe('the balance of a bill', () => {
  it('reads the balance from the database when it is there', () => {
    expect(billRemaining({ grand_total: 11800, paid_amount: 5000, remaining_amount: 6800 })).toBe(6800)
  })

  it('works the balance out when the column has not arrived yet', () => {
    expect(billRemaining({ grand_total: 11800, paid_amount: 5000 })).toBe(6800)
  })

  it('shows the whole bill as owed when the browser has neither column', () => {
    expect(billRemaining({ grand_total: 11800 })).toBe(11800)
  })

  it('never shows a negative balance', () => {
    expect(billRemaining({ grand_total: 100, paid_amount: 200 })).toBe(0)
  })
})

describe('auth error messaging', () => {
  it('recognises a pending email confirmation from either error code', () => {
    expect(needsEmailConfirmation(Object.assign(new Error('Email verification required'), { code: 'email_not_confirmed' }))).toBe(true)
    expect(needsEmailConfirmation(new Error('Failed to retrieve user session'))).toBe(true)
  })
  it('does not mistake ordinary auth failures for a pending confirmation', () => {
    expect(needsEmailConfirmation(new Error('Invalid email or password'))).toBe(false)
    expect(needsEmailConfirmation(new Error('Connection failed'))).toBe(false)
  })
  it('still reports a readable message when no session could be started', () => {
    expect(friendlyError(new Error('No active session found'))).toBe('We could not start your session. Please try again.')
    expect(friendlyError(new Error('Something odd'))).toBe('The request could not be completed. Please try again.')
  })
  it('recognises a rejected or expired session', () => {
    expect(friendlyError(new Error('UNAUTHENTICATED: authentication required'))).toBe('Your session has expired. Sign in again to continue.')
    expect(friendlyError(new Error('JWT expired'))).toBe('Your session has expired. Sign in again to continue.')
    expect(friendlyError(new Error('Invalid JWT signature'))).toBe('Your session has expired. Sign in again to continue.')
    // The Data API reports a lapsed 15-minute access token like this.
    expect(friendlyError(new Error('PGRST301'))).toBe('Your session has expired. Sign in again to continue.')
    expect(isSessionRejected(new Error('PGRST301: JWT expired'))).toBe(true)
    expect(isSessionRejected(new Error('Failed to fetch'))).toBe(false)
    expect(isSessionRejected(new Error('connection terminated unexpectedly'))).toBe(false)
  })
  it('recognises the SDK wording for a session it could not produce a token for', () => {
    // The exact AuthRequiredError the SDK throws before it sends anything. It
    // used to fall through to the generic sentence, so finalizing a challan
    // after the session had lapsed reported "the request could not be completed"
    // with no hint that signing in again was the fix.
    const sdk = new Error('Authentication required. A valid token is needed to access the resource.')
    expect(isSessionRejected(sdk)).toBe(true)
    expect(friendlyError(sdk)).toBe('Your session has expired. Sign in again to continue.')
    // And the Data API's own 400 for a bearer token it will not take.
    const api = new Error('missing authentication credentials: required authorization bearer token in JWT format')
    expect(isSessionRejected(api)).toBe(true)
    expect(friendlyError(api)).toBe('Your session has expired. Sign in again to continue.')
  })
  it('keeps the real cause visible when no rule matches', () => {
    const cause = new Error('pg_catalog: something the app has never seen')
    expect(friendlyError(cause)).toBe('The request could not be completed. Please try again.')
    expect(explainError(cause, 'Could not save the challan.')).toBe('pg_catalog: something the app has never seen')
    expect(explainError(new Error(''), 'Could not save the challan.')).toBe('Could not save the challan.')
  })
  it('recognises a workspace that already exists', () => {
    expect(isAlreadyBootstrapped(new Error('PT409 ALREADY_BOOTSTRAPPED: user already belongs to an organization'))).toBe(true)
    expect(isAlreadyBootstrapped(new Error('VALIDATION_ERROR: org_name must be at least 2 characters'))).toBe(false)
  })
})

describe('explainable errors', () => {
  it('keeps the real cause when no friendly message exists', () => {
    expect(explainError(new Error('relation "public.memberships" does not exist'), 'fallback')).toBe('relation "public.memberships" does not exist')
    expect(explainError('JWT expired', 'fallback')).toBe('Your session has expired. Sign in again to continue.')
  })
  it('prefers the friendly message and only uses the fallback for nothing at all', () => {
    expect(explainError(new Error('Failed to fetch'), 'fallback')).toBe('Connection failed. Check your internet and try again.')
    expect(explainError(new Error(''), 'We could not create your workspace. Please try again.')).toBe('We could not create your workspace. Please try again.')
  })
})
