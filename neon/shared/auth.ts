import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'
import type { Pool } from 'pg'

export type Role = 'admin' | 'staff' | 'viewer'

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

let verification: { jwks: ReturnType<typeof createRemoteJWKSet>; issuer: string } | null = null

function verificationKeys() {
  if (!verification) {
    const jwksUrl = process.env.NEON_AUTH_JWKS_URL
    const authBaseUrl = process.env.NEON_AUTH_BASE_URL
    if (!jwksUrl || !authBaseUrl) throw new HttpError(500, 'Authentication is not configured on the server.')
    verification = { jwks: createRemoteJWKSet(new URL(jwksUrl)), issuer: new URL(authBaseUrl).origin }
  }
  return verification
}

export async function verifyToken(request: Request): Promise<string> {
  const authorization = request.headers.get('Authorization') ?? ''
  const token = authorization.replace(/^Bearer\s+/i, '').trim()
  if (!token || !/^Bearer\s+/i.test(authorization)) throw new HttpError(401, 'Sign in to continue.')
  const { jwks, issuer } = verificationKeys()
  let payload: JWTPayload
  try {
    payload = (await jwtVerify(token, jwks, { issuer })).payload
  } catch {
    throw new HttpError(401, 'Your session has expired.')
  }
  if (!payload.sub || !UUID.test(payload.sub)) throw new HttpError(401, 'Your session has expired.')
  return payload.sub
}

export async function requireMembership(
  pool: Pool,
  organizationId: string,
  userId: string,
  options: { write: boolean },
): Promise<Role> {
  if (!UUID.test(organizationId)) throw new HttpError(400, 'Invalid organization ID.')
  const { rows } = await pool.query<{ role: Role }>(
    'select role from public.memberships where organization_id = $1::uuid and user_id = $2::uuid',
    [organizationId, userId],
  )
  const role = rows[0]?.role
  if (!role) throw new HttpError(403, 'You do not have access to this organization.')
  if (options.write && role === 'viewer') throw new HttpError(403, 'You cannot modify documents in this organization.')
  return role
}

export function organizationFromObjectPath(objectPath: string): string {
  const organizationId = objectPath.split('/')[0] ?? ''
  if (!UUID.test(organizationId)) throw new HttpError(400, 'Invalid object path.')
  return organizationId
}

const SAFE_OBJECT_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

export function assertOrganizationPath(objectPath: string, organizationId: string): void {
  if (objectPath.length === 0 || objectPath.length > 512) throw new HttpError(400, 'Invalid object path.')
  if (!SAFE_OBJECT_KEY.test(objectPath)) throw new HttpError(400, 'Invalid object path.')
  if (objectPath.startsWith('/') || objectPath.includes('//')) throw new HttpError(400, 'Invalid object path.')
  if (!objectPath.startsWith(`${organizationId}/`)) {
    throw new HttpError(400, 'The object path must live inside the organization folder.')
  }
  if (objectPath.split('/').some(segment => segment === '..' || segment === '.')) {
    throw new HttpError(400, 'The object path may not contain relative segments.')
  }
}

const ALLOWED_HEADERS = 'authorization, content-type'
const ALLOWED_METHODS = 'GET, POST, OPTIONS'

export function allowedOrigins(): ReadonlySet<string> {
  return new Set(
    (process.env.WEB_ORIGIN ?? '')
      .split(',')
      .map(origin => origin.trim())
      .filter(Boolean),
  )
}

export function corsHeaders(origin: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Max-Age': '600',
  }
  if (!origin) return headers
  if (!allowedOrigins().has(origin)) throw new HttpError(403, 'This origin is not allowed to call the API.')
  return { ...headers, 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
}