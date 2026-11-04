import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Hoisted so the mock factory below can reference it before the import. */
const getSessionMock = vi.hoisted(() => vi.fn())

vi.mock('@neondatabase/neon-js', () => ({
  createClient: vi.fn(() => ({ auth: { getSession: getSessionMock } })),
  defaultDeriveNeonUrls: vi.fn(() => ({
    auth: 'https://auth.example/neondb/auth',
    dataApi: 'https://api.example/neondb/rest/v1',
  })),
  SupabaseAuthAdapter: vi.fn(),
}))

import { backendRequest, BackendRequestError } from '../lib/db'

const originalFetch = globalThis.fetch
let fetchMock: ReturnType<typeof vi.fn>

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  fetchMock = vi.fn()
  globalThis.fetch = fetchMock as unknown as typeof fetch
  getSessionMock.mockResolvedValue({ data: { session: { access_token: 'token-1' } }, error: null })
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
  getSessionMock.mockClear()
  fetchMock.mockClear()
})

describe('backendRequest', () => {
  it('sends the bearer token and returns the payload', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }, 200))
    const result = await backendRequest<{ ok: boolean }>('https://api.example/', '/path')
    expect(result).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]!
    expect(init.headers).toMatchObject({ Authorization: 'Bearer token-1' })
  })

  it('refreshes once and retries on 401 with the new token', async () => {
    getSessionMock
      .mockResolvedValueOnce({ data: { session: { access_token: 'token-1' } }, error: null })
      .mockResolvedValueOnce({ data: { session: { access_token: 'token-2' } }, error: null })
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'Sign in to continue.' }, 401))
      .mockResolvedValueOnce(jsonResponse({ ok: true }, 200))

    const result = await backendRequest<{ ok: boolean }>('https://api.example/', '/path')
    expect(result).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [, secondInit] = fetchMock.mock.calls[1]!
    expect(secondInit.headers).toMatchObject({ Authorization: 'Bearer token-2' })
    expect(getSessionMock).toHaveBeenCalledWith({ forceFetch: true })
  })

  it('does not refresh more than once on repeated 401', async () => {
    getSessionMock
      .mockResolvedValueOnce({ data: { session: { access_token: 'token-1' } }, error: null })
      .mockResolvedValueOnce({ data: { session: { access_token: 'token-2' } }, error: null })
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'Sign in to continue.' }, 401))
      .mockResolvedValueOnce(jsonResponse({ error: 'Sign in to continue.' }, 401))

    await expect(backendRequest('https://api.example/', '/path')).rejects.toMatchObject({
      status: 401,
      message: 'Sign in to continue.',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // One call for the initial token, one for the single refresh attempt.
    expect(getSessionMock).toHaveBeenCalledTimes(2)
  })

  it('throws a status-bearing error when refresh fails on 401', async () => {
    getSessionMock
      .mockResolvedValueOnce({ data: { session: { access_token: 'token-1' } }, error: null })
      .mockResolvedValueOnce({ data: { session: null }, error: null })
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Sign in to continue.' }, 401))

    await expect(backendRequest('https://api.example/', '/path')).rejects.toMatchObject({
      status: 401,
      message: 'Sign in to continue.',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws Sign in to continue with status 401 when there is no token', async () => {
    getSessionMock.mockResolvedValue({ data: { session: null }, error: null })
    await expect(backendRequest('https://api.example/', '/path')).rejects.toMatchObject({
      status: 401,
      message: 'Sign in to continue.',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('preserves the server message for non-401 failures', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Storage upload failed.' }, 500))
    await expect(backendRequest('https://api.example/', '/path')).rejects.toMatchObject({
      status: 500,
      message: 'Storage upload failed.',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('is recognised as a session rejection by isSessionRejected', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Sign in to continue.' }, 401))
    getSessionMock.mockResolvedValue({ data: { session: null }, error: null })
    const { isSessionRejected } = await import('../lib/format')
    try {
      await backendRequest('https://api.example/', '/path')
    } catch (cause) {
      expect(isSessionRejected(cause)).toBe(true)
    }
  })

  it('is a BackendRequestError instance', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'boom' }, 500))
    try {
      await backendRequest('https://api.example/', '/path')
    } catch (cause) {
      expect(cause).toBeInstanceOf(BackendRequestError)
      expect((cause as BackendRequestError).status).toBe(500)
    }
  })
})
