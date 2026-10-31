import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Guards the navigation and sign-out shell.
 *
 * These assertions are about the structure of the source rather than about
 * behaviour, because the behaviour is a layout question that no unit test can
 * answer. They exist because the reported symptom was "the logout button is only
 * there on the billing page", and the two things that caused it were structural:
 *
 *   - the Delivery Challan routes are mounted under a *second* `<Route
 *     element={<Shell />}>` in main.tsx, so anything added to Shell reaches both,
 *     but anything added to a billing page does not;
 *   - the sidebar's sign-out sits in a footer that `margin-top:auto` could push
 *     past `100vh`, because the sidebar had no overflow and the DC module has one
 *     more nav link than Billing.
 *
 * A test cannot measure pixels, but it can fail if someone deletes the pinned
 * footer rule, drops `min-height: 0`, or unmounts the DC routes from the Shell.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (relative: string) => readFileSync(join(root, relative), 'utf8')

describe('the shell is shared by both modules', () => {
  const main = read('src/main.tsx')

  it('mounts the Delivery Challan routes inside a Shell', () => {
    // If this ever fails, the DC pages have stopped using the shared shell and
    // would lose everything it provides - navigation, search, the module switcher
    // and the sign-out.
    const dcBlock = main.slice(main.indexOf('Delivery Challan module'))
    expect(dcBlock).toContain('element={<Shell />}')
  })

  it('keeps a Shell route for the billing pages too', () => {
    expect(main).toContain('element={<Shell />}')
    expect((main.match(/element=\{<Shell \/>\}/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('routes the DC entry points through that shell', () => {
    for (const route of ['/dc', '/dc/inward', '/dc/outward', '/dc/ledger', '/dc/reports']) {
      expect(main, `expected ${route} to be declared`).toContain(`path="${route}"`)
    }
  })
})

describe('the sign-out is reachable from anywhere in the app', () => {
  const shell = read('src/components/Shell.tsx')

  it('offers a sign-out in the topbar, not only in the sidebar footer', () => {
    // The topbar is always rendered. The sidebar footer is inside a drawer below
    // 850px, so relying on it alone is what made signing out awkward on a phone.
    expect(shell).toContain('topbar-signout')
    expect(shell).toContain('aria-label="Sign out"')
  })

  it('keeps the sidebar footer sign-out as well', () => {
    expect(shell).toContain('className="signout"')
  })

  it('does not hide the sign-out behind a billing-only condition', () => {
    // A sign-out wrapped in `module === 'billing'` would vanish on the DC pages -
    // exactly the bug this file is here to prevent.
    expect(shell).not.toMatch(/module === 'billing'[^}]*Sign out/)
    expect(shell).not.toMatch(/Sign out[^}]*module === 'billing'/)
  })

  it('disables it while a sign-out is in flight, so it cannot be fired twice', () => {
    expect(shell).toMatch(/className="topbar-signout"[\s\S]{0,300}?disabled=\{leaving\}/)
  })
})

describe('the sidebar footer cannot be pushed off screen', () => {
  const css = read('src/style.css')
  const rule = (selector: string) => {
    const at = css.indexOf(selector)
    expect(at, `${selector} is missing from style.css`).toBeGreaterThanOrEqual(0)
    return css.slice(at, css.indexOf('}', at))
  }

  it('makes the nav the scrolling region', () => {
    const nav = rule('.sidebar nav{')
    expect(nav).toContain('overflow-y:auto')
    expect(nav).toContain('flex:1 1 auto')
    // Load-bearing. A flex item defaults to min-height:auto, which refuses to
    // shrink below its content and reproduces the clipping even with
    // overflow-y set.
    expect(nav).toContain('min-height:0')
  })

  it('pins the footer', () => {
    const bottom = rule('.sidebar-bottom{')
    expect(bottom).toContain('flex-shrink:0')
    expect(bottom).toContain('margin-top:auto')
  })

  it('stops the sidebar itself from clipping the footer without a way to scroll', () => {
    // overflow:hidden is safe only because the nav now scrolls inside it.
    expect(rule('.sidebar{overflow')).toContain('overflow:hidden')
  })

  it('keeps the header and module switcher from being squashed', () => {
    expect(rule('.brand{flex')).toContain('flex-shrink:0')
  })

  it('reveals the sign-out label on a narrow screen', () => {
    // Below 850px the status text is hidden, so an icon-only button would have no
    // visible label and a small touch target.
    const narrow = css.slice(css.indexOf('@media (max-width: 640px)'))
    expect(narrow).toContain('.topbar-signout-label { display: inline; }')
  })
})