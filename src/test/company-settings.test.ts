import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Guards the company details screen.
 *
 * Two failures are worth a permanent guard, because both were reported as
 * "the page is blank" and neither produced an error message:
 *
 *   - the Delivery Challan sidebar had no link to the settings screen, so the
 *     company details were unreachable from the module where the challans are
 *     raised. The billing sidebar had one, which is why it looked like the
 *     screen existed;
 *   - the card called a function that did not exist. A reference to an
 *     undefined name throws while the component renders, React unmounts the
 *     whole tree, and the screen goes white with nothing in the console that
 *     the person using it will ever see.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (relative: string) => readFileSync(join(root, relative), 'utf8')

describe('the company details screen', () => {
  it('is reachable from the Delivery Challan navigation', () => {
    const shell = read('src/components/Shell.tsx')
    const dcNav = shell.slice(shell.indexOf('const DC_NAV'), shell.indexOf('export function Shell'))
    expect(dcNav, 'the DC navigation must offer a link to the company settings').toContain("'/settings'")
  })

  it('is on the settings page', () => {
    expect(read('src/pages/Settings.tsx')).toContain('CompanyProfileCard')
  })

  it('calls nothing that does not exist', () => {
    // `normalizedGstin` was a name that was never defined; the function is
    // `normalizeGstin`. The call threw while the card rendered, and the screen
    // went blank with no message.
    const card = read('src/components/CompanyProfileCard.tsx')
    expect(card).not.toContain('normalizedGstin')
  })

  it('reads the company details from the signed-in workspace', () => {
    // The letterhead has to be current when a PDF is produced, and the session
    // already carries the company details.
    const membership = read('src/lib/membership.ts')
    expect(membership).toContain('gstin')
    expect(membership).toContain('address')
    expect(membership).toContain('phone')
    expect(membership).toContain('email')
  })
})
