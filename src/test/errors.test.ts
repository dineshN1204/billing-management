import { describe, expect, it } from 'vitest'
import {
  describeError, explainError, friendlyError, isAlreadyBootstrapped,
  isAuthOriginRejected, isSessionRejected, needsEmailConfirmation,
} from '../lib/format'

/**
 * Regression tests for the "[object Object]" failure.
 *
 * `String(someObject)` is the literal string "[object Object]". The app used to
 * read a rejection with `error instanceof Error ? error.message : String(error)`,
 * so any failure that arrived as a plain object - which is how several of the
 * auth and transport layers report - was displayed to the user as
 * "[object Object]", and was never recognised as a lapsed session, so nothing was
 * retried and a page refresh was the only way out.
 *
 * Every case below asserts two things: a readable string, and never that literal.
 */

const FORBIDDEN = '[object Object]'

describe('describeError never leaks "[object Object]"', () => {
  it('reads a real Error', () => {
    expect(describeError(new Error('Failed to fetch'))).toBe('Failed to fetch')
  })

  it('reads a plain object that carries a message', () => {
    expect(describeError({ message: 'JWT expired' })).toBe('JWT expired')
  })

  it('reads a GoTrue-style error, which uses error_description', () => {
    expect(describeError({ error_description: 'Invalid email or password' }))
      .toBe('Invalid email or password')
    expect(describeError({ error: 'invalid_grant' })).toBe('invalid_grant')
  })

  it('reads a PostgREST error object', () => {
    const error = Object.assign(new Error('DUPLICATE_BILL: a likely duplicate already exists'), {
      code: 'PT409', details: '{"duplicates":[]}', hint: '',
    })
    expect(describeError(error)).toContain('DUPLICATE_BILL')
  })

  it('names the fields of an object with nothing readable in it', () => {
    // Better than "[object Object]": it tells a developer what came back.
    const described = describeError({ foo: 1, bar: 2 })
    expect(described).not.toBe(FORBIDDEN)
    expect(described).toMatch(/foo/)
  })

  it('falls back cleanly for values with no information at all', () => {
    expect(describeError(null, 'Nothing came back')).toBe('Nothing came back')
    expect(describeError(undefined, 'Nothing came back')).toBe('Nothing came back')
    expect(describeError({}, 'Nothing came back')).toBe('Nothing came back')
    expect(describeError([], 'Nothing came back')).toBe('Nothing came back')
  })

  it('handles strings, numbers and booleans', () => {
    expect(describeError('something broke')).toBe('something broke')
    expect(describeError(500)).toBe('500')
    expect(describeError(false)).toBe('false')
  })

  it('uses an Error name when the message is empty', () => {
    class CustomError extends Error { constructor() { super(''); this.name = 'CustomError' } }
    expect(describeError(new CustomError())).toBe('CustomError')
  })

  it('reports an HTTP status when there is no message', () => {
    expect(describeError({ status: 503 })).toMatch(/503/)
  })

  it('never returns the forbidden string for a wide spread of shapes', () => {
    const shapes: unknown[] = [
      {}, { a: 1 }, [], [1, 2], new Date(), () => 1,
      Object.create(null), { message: '' }, { code: '' },
      { nested: { deep: { value: 1 } } },
    ]
    for (const shape of shapes) {
      // `Object.create(null)` has no toString, so the label is built defensively -
      // the assertion is about describeError, not about stringifying the input.
      const label = Object.prototype.toString.call(shape)
      expect(describeError(shape, 'fallback'), label).not.toBe(FORBIDDEN)
    }
    // The null-prototype object specifically: it is the one shape where naive
    // string handling throws rather than returning "[object Object]".
    expect(describeError(Object.create(null), 'fallback')).toBe('fallback')
  })
})

describe('friendlyError and explainError stay readable', () => {
  it('maps a PostgREST duplicate even when it arrives as a plain object', () => {
    expect(friendlyError({ message: 'DUPLICATE_BILL: a likely duplicate already exists' }))
      .toBe('A possible duplicate bill already exists.')
  })

  it('still maps the DC quantity codes from a plain object', () => {
    expect(friendlyError({ message: 'QUANTITY_EXCEEDED: only 160 of KI-101 is eligible' }))
      .toBe('only 160 of KI-101 is eligible')
  })

  it('explains a session failure from a plain object', () => {
    expect(friendlyError({ code: 'bad_jwt', message: 'invalid token' }))
      .toBe('Your session has expired. Sign in again to continue.')
  })

  it('names an auth origin rejection instead of blaming the session', () => {
    // Live symptom: Neon Auth rejects a deployment domain that is not on the
    // branch's trusted list with 403 INVALID_ORIGIN before it reads the password.
    // The old generic 403 rule relabelled that as "your session has expired".
    const rejected = { status: 403, message: 'Invalid origin', code: 'INVALID_ORIGIN' }
    expect(friendlyError(rejected))
      .toBe('This site is not allowed to sign in. An administrator must add this address as a trusted domain in Neon Auth.')
    expect(friendlyError(rejected)).not.toBe('Your session has expired. Sign in again to continue.')
  })

  it('explainError keeps the real cause instead of "[object Object]"', () => {
    // explainError is the one that used to show the raw String(error) to the user.
    const explained = explainError({ message: 'Database connection refused' }, 'fallback')
    expect(explained).toBe('Database connection refused')
    expect(explained).not.toBe(FORBIDDEN)
  })

  it('explainError uses the fallback when there is genuinely nothing to say', () => {
    expect(explainError({}, 'Could not load the ledger.')).toBe('Could not load the ledger.')
    expect(explainError(null, 'Could not load the ledger.')).toBe('Could not load the ledger.')
  })
})

describe('isSessionRejected recognises a lapsed session in every shape', () => {
  it('recognises the Data API wording', () => {
    expect(isSessionRejected(new Error('PGRST301'))).toBe(true)
    expect(isSessionRejected(new Error('JWT expired'))).toBe(true)
    expect(isSessionRejected(new Error('Invalid JWT signature'))).toBe(true)
    expect(isSessionRejected(new Error('Authentication required. A valid token is needed to access the resource.'))).toBe(true)
    expect(isSessionRejected(new Error('missing authentication credentials'))).toBe(true)
  })

  it('recognises it when the failure is a plain object rather than an Error', () => {
    // This is the case that made a refresh the only remedy.
    expect(isSessionRejected({ message: 'PGRST301' })).toBe(true)
    expect(isSessionRejected({ message: 'JWT expired' })).toBe(true)
    expect(isSessionRejected({ error_description: 'JWT expired', code: 'bad_jwt' })).toBe(true)
  })

  it('recognises it from a bare HTTP status', () => {
    expect(isSessionRejected({ status: 401 })).toBe(true)
    expect(isSessionRejected({ status: 403 })).toBe(true)
    expect(isSessionRejected({ status: 401, message: '' })).toBe(true)
  })

  it('does not retry an auth origin rejection as if the session had lapsed', () => {
    // Refreshing the token cannot add the domain to the trusted list, so this 403
    // must not spend a refresh and a replay on a request that will fail again.
    const rejected = { status: 403, message: 'Invalid origin', code: 'INVALID_ORIGIN' }
    expect(isSessionRejected(rejected)).toBe(false)
    expect(isAuthOriginRejected(rejected)).toBe(true)
    expect(isAuthOriginRejected({ status: 403, code: 'INVALID_ORIGIN' })).toBe(true)
    expect(isAuthOriginRejected({ status: 403, message: 'Forbidden' })).toBe(false)
  })

  it('recognises the auth library error codes', () => {
    expect(isSessionRejected({ code: 'bad_jwt' })).toBe(true)
    expect(isSessionRejected({ code: 'token_expired' })).toBe(true)
    expect(isSessionRejected({ code: 'jwt_expired' })).toBe(true)
  })

  it('recognises a malformed token', () => {
    expect(isSessionRejected(new Error('jwt malformed'))).toBe(true)
    expect(isSessionRejected({ message: 'JWT is malformed' })).toBe(true)
  })

  it('does not mistake a genuine fault for a lapsed session', () => {
    // A false positive here would burn a token refresh and retry a write that was
    // actually rejected for a business reason.
    expect(isSessionRejected(new Error('insufficient funds'))).toBe(false)
    expect(isSessionRejected({ code: '23505', message: 'duplicate key value' })).toBe(false)
    expect(isSessionRejected({ message: 'QUANTITY_EXCEEDED' })).toBe(false)
    expect(isSessionRejected({ status: 500, message: 'internal error' })).toBe(false)
    expect(isSessionRejected(null)).toBe(false)
  })
})

describe('the other error predicates survive a plain object', () => {
  it('isAlreadyBootstrapped reads a code', () => {
    expect(isAlreadyBootstrapped({ message: 'ALREADY_BOOTSTRAPPED' })).toBe(true)
    expect(isAlreadyBootstrapped({ code: 'ALREADY_BOOTSTRAPPED', message: '' })).toBe(true)
    expect(isAlreadyBootstrapped(new Error('this user already belongs to an organization'))).toBe(true)
    expect(isAlreadyBootstrapped({ message: 'something else' })).toBe(false)
  })

  it('needsEmailConfirmation reads a code or a description', () => {
    expect(needsEmailConfirmation({ code: 'email_not_confirmed', message: '' })).toBe(true)
    expect(needsEmailConfirmation({ error_description: 'Email verification required' })).toBe(true)
    expect(needsEmailConfirmation({ message: 'Failed to retrieve user session' })).toBe(true)
    expect(needsEmailConfirmation({ message: 'Invalid email or password' })).toBe(false)
  })
})