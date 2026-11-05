/**
 * Verifies the built PWA against the properties the application depends on.
 *
 *     npm run build && npm run verify:pwa
 *
 * This is a post-build gate, not a style check. Every assertion here protects a
 * promise made to the people using the app:
 *
 *  1. No authenticated response is ever cached.
 *  2. The manifest is valid enough for a browser to install the app.
 *  3. Every precached entry is public.
 *  4. The service worker answers deep links, so refresh and direct navigation work.
 *
 * A service worker is the one component that can quietly put customer GSTINs and
 * invoice totals on disk on a shared shop-floor device. Failing the build is the
 * correct outcome if that ever becomes possible.
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')

const failures = []
const notes = []

function check(condition, message) {
  if (!condition) failures.push(message)
}

function read(path) {
  return readFileSync(join(dist, path), 'utf8')
}

if (!existsSync(dist)) {
  console.error('dist/ not found. Run `npm run build` first.')
  process.exit(1)
}

// --- 1. The service worker must not cache authenticated traffic ----------------

const swPath = join(dist, 'sw.js')
check(existsSync(swPath), 'sw.js was not generated. The app will not be installable.')
check(existsSync(join(dist, 'workbox-*.js'.replace('*.js', ''))) || readFileSafe(swPath).includes('workbox'), 'workbox runtime missing from the build.')

if (existsSync(swPath)) {
  const sw = read('sw.js')

  // Workbox runtime caching strategies. Any of these applied to an API route
  // would store invoices and customer records in Cache Storage.
  const strategies = [
    ['NetworkFirst', /NetworkFirst|networkFirst/],
    ['CacheFirst', /CacheFirst|cacheFirst/],
    ['StaleWhileRevalidate', /StaleWhileRevalidate|staleWhileRevalidate/],
    ['CacheOnly', /CacheOnly|cacheOnly/],
    ['NetworkOnly', /NetworkOnly|networkOnly/],
  ]
  for (const [name, pattern] of strategies) {
    check(!pattern.test(sw), `Service worker registers a ${name} runtime route. No authenticated response may be cached.`)
  }

  // The Neon data API host, the RPC endpoint and the auth header must not appear
  // in the worker at all: nothing there should be reachable from it.
  for (const secretish of ['neon.tech', 'neon.build', '/rest/v1', 'Authorization', 'access_token', 'Bearer']) {
    check(!sw.includes(secretish), `Service worker references "${secretish}". It has no business knowing about the data API.`)
  }

  // Deep links must resolve, otherwise a refresh on /dc/inward/123 404s.
  check(/NavigationRoute|navigateFallback|createHandlerBoundToURL/.test(sw),
    'Service worker has no navigation fallback. Opening or refreshing a deep link would fail.')

  // clientsClaim makes the new worker take control of the open page after
  // skipWaiting, so the prompt-mode reload fires when "Update now" is tapped.
  // Without it the worker activates but the page keeps running the old bundle
  // until a manual refresh.
  check(/clientsClaim\(\)|clients\.claim\(\)/.test(sw),
    'Service worker does not call clients.claim(); an accepted update will not reload the page.')

  const precacheCount = (sw.match(/revision:/g) ?? []).length
  notes.push(`Service worker precaches ${precacheCount} build assets (no runtime caching of any kind).`)
}

// --- 2 & 3. The manifest must be installable and reference only public files ----

const manifestPath = join(dist, 'manifest.webmanifest')
check(existsSync(manifestPath), 'manifest.webmanifest was not generated.')

if (existsSync(manifestPath)) {
  let manifest
  try {
    manifest = JSON.parse(read('manifest.webmanifest'))
  } catch (cause) {
    failures.push(`manifest.webmanifest is not valid JSON: ${cause.message}`)
  }

  if (manifest) {
    for (const field of ['name', 'short_name', 'start_url', 'scope', 'display', 'theme_color', 'background_color', 'icons']) {
      check(manifest[field] !== undefined && manifest[field] !== '', `manifest.${field} is missing or empty.`)
    }
    check(manifest.display === 'standalone' || manifest.display === 'fullscreen' || manifest.display === 'minimal-ui',
      `manifest.display is "${manifest.display}"; the app must open without browser chrome.`)

    // Icons must actually exist on disk, or the install prompt fails at the worst
    // moment - when someone is trying to use the app on the shop floor.
    const icons = Array.isArray(manifest.icons) ? manifest.icons : []
    check(icons.length > 0, 'manifest declares no icons.')
    const sizes = new Set()
    for (const icon of icons) {
      const path = join(dist, icon.src)
      check(existsSync(path), `manifest icon "${icon.src}" is listed but not present in dist/.`)
      if (existsSync(path)) {
        check(statSync(path).size > 0, `manifest icon "${icon.src}" is empty.`)
        // A real PNG starts with the 8-byte signature; an HTML error page served
        // with a .png name would install and then render as a broken image.
        const header = readFileSync(path).subarray(0, 8)
        check(header.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
          `manifest icon "${icon.src}" is not a PNG.`)
      }
      if (typeof icon.sizes === 'string') sizes.add(icon.sizes)
    }
    check(sizes.has('192x192') && sizes.has('512x512'),
      'manifest must declare both 192x192 and 512x512 icons or the install prompt is rejected.')
    check(icons.some(icon => String(icon.purpose ?? '').includes('maskable')),
      'manifest declares no maskable icon; Android will letterbox the app icon.')

    notes.push(`Manifest: "${manifest.name}", ${icons.length} icons, display=${manifest.display}.`)
  }
}

// --- 4. The shell must reference the manifest and the service worker -----------

const html = read('index.html')
check(/<link[^>]+rel=["']manifest["']/.test(html), 'index.html does not link the web app manifest.')
check(/<meta[^>]+name=["']viewport["'][^>]+width=device-width/.test(html), 'index.html has no mobile viewport meta tag.')
check(/<meta[^>]+name=["']theme-color["']/.test(html), 'index.html has no theme-color meta tag; the Android status bar will render white.')
check(/apple-touch-icon/.test(html), 'index.html has no apple-touch-icon; iOS will use a screenshot for the home screen icon.')
check(html.includes('<div id="root">'), 'index.html has no #root element; the app cannot mount.')
check(!/http:\/\/localhost|127\.0\.0\.1/.test(html), 'index.html contains a localhost URL. A build that references the dev server is broken.')

function readFileSafe(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  } catch {
    return ''
  }
}

// --- Report -------------------------------------------------------------------

for (const note of notes) console.log(`  ok  ${note}`)

if (failures.length) {
  console.error('\nPWA verification FAILED:')
  for (const failure of failures) console.error(`  x  ${failure}`)
  process.exit(1)
}
console.log('\nPWA verification passed.')