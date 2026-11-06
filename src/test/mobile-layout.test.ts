import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Guards the rows that used to be wider than a phone.
 *
 * The app clips stray horizontal overflow inside `.content` at 640px, which
 * hides a wide row instead of making it reachable. These assertions fail if a
 * future edit removes the local fix and leaves the clip as the only answer.
 * They check the declarations because the actual reachability is a browser
 * layout question a unit test cannot measure.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const css = readFileSync(join(root, 'src', 'style.css'), 'utf8').replace(/\r\n/g, '\n')

function rule(selector: string) {
  const at = css.indexOf(selector)
  expect(at, `${selector} is missing from style.css`).toBeGreaterThanOrEqual(0)
  return css.slice(at, css.indexOf('}', at))
}

function lastRule(selector: string) {
  const at = css.lastIndexOf(selector)
  expect(at, `${selector} is missing from style.css`).toBeGreaterThanOrEqual(0)
  return css.slice(at, css.indexOf('}', at))
}

describe('mobile rows pan or wrap instead of hiding their content', () => {
  it('makes the tab strip scrollable with non-shrinking tabs', () => {
    const tabs = rule('.tabs {')
    expect(tabs).toContain('overflow-x: auto')
    expect(tabs).toContain('overscroll-behavior-x: contain')
    expect(rule('.tabs button {')).toContain('flex: 0 0 auto')
    expect(rule('.tabs button {')).toContain('white-space: nowrap')
  })

  it('lets the topbar search shrink below the input intrinsic width', () => {
    const search = rule('.global-search,')
    expect(search).toContain('.global-search input')
    expect(search).toContain('min-width: 0')
  })

  it('wraps the pagination controls on a phone', () => {
    expect(rule('.pagination {')).toContain('flex-wrap: wrap')
    expect(rule('.pagination > div {')).toContain('width: 100%')
    expect(rule('.pagination .button {')).toContain('min-height: 40px')
  })

  it('gives stacked table action cells their own line', () => {
    // The cell keeps its label and value on one row when they fit, then gives
    // a control group (role select + Remove) the full row instead of pushing
    // it past the card edge.
    expect(lastRule('table.stack-on-mobile td {')).toContain('flex-wrap: wrap')
    expect(rule('table.stack-on-mobile td > .inline-actions {')).toContain('flex: 1 1 100%')
  })

  it('wraps form and dialog footers', () => {
    expect(rule('.form-actions,\n.modal-actions {')).toContain('flex-wrap: wrap')
  })

  it('lets the selected-party block and its actions wrap', () => {
    expect(rule('.selected-entity {')).toContain('flex-wrap: wrap')
    expect(rule('.selected-entity .button {')).toContain('margin-left: 0')
  })
})
