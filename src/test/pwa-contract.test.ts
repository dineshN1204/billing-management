import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Regression test for the PWA update flow.
 *
 * The crash was that `registerSW()` returns the update function directly, not
 * an object with an `updateServiceWorker` property, yet pwa.ts called
 * `cachedRegister.updateServiceWorker(true)` — which threw
 * `le.updateServiceWorker is not a function` every time "Update now" was tapped.
 *
 * This test guards the two parts of the fix:
 *  1. The type surface the app relies on comes from `vite-plugin-pwa/client`
 *     (not a hand-written local declaration), so it stays in sync with the
 *     plugin's real return shape.
 *  2. The generated service worker enables `clientsClaim`, which is what makes
 *     the prompt-mode reload actually happen after `skipWaiting`.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (relative: string) => readFileSync(join(root, relative), 'utf8')

describe('pwa update flow', () => {
  it('types registerSW from vite-plugin-pwa/client (not a hand-written declaration)', () => {
    const env = read('src/vite-env.d.ts')
    expect(env).toContain('vite-plugin-pwa/client')
    expect(env).not.toContain('updateServiceWorker')
  })

  it('uses the update function directly, not .updateServiceWorker', () => {
    const pwa = read('src/lib/pwa.ts')
    expect(pwa).not.toContain('cachedRegister.updateServiceWorker')
  })

  it('the generated service worker enables clientsClaim', () => {
    const sw = read('dist/sw.js')
    expect(sw).toContain('clientsClaim')
  })
})
