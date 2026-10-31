const AUTH_ROUTES = ['/signin', '/onboarding']

/**
 * The route segment a challan of the given type lives under.
 *
 * Each DC type is mounted on its own route in main.tsx, so a link built from the
 * wrong type opens an unrelated screen or nothing at all. The outward challan
 * lives under /dc/outward; the old /dc/outward/customer paths still resolve as
 * aliases so bookmarks survive the rename.
 */
export function challanPath(id: string, dcType: string): string {
  if (dcType === 'outward_customer') return `/dc/outward/${id}`
  // inward and material_return are both viewed through the inward detail route.
  return `/dc/inward/${id}`
}

/**
 * Where to send a user after they authenticate. RequireSession records the route
 * they asked for in router state, so a bookmarked /bills/123 survives the detour
 * through /signin. Anything unusable falls back to /, which redirects to the
 * dashboard.
 */
export function landingTarget(state: unknown): string {
  const from = (state as { from?: unknown } | null | undefined)?.from
  if (typeof from !== 'string' || from === '' || from === '/') return '/'
  // Only same-origin paths: rejects //evil.com, https://evil.com and backslashes.
  if (!from.startsWith('/') || from.startsWith('//') || from.startsWith('/\\')) return '/'
  if (AUTH_ROUTES.some(route => from === route || from.startsWith(`${route}/`) || from.startsWith(`${route}?`))) return '/'
  return from
}
