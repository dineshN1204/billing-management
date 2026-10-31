import { describe, expect, it } from 'vitest'
import { partySearch } from '../lib/dc-api'

/**
 * The party picker showed an empty list and the message "Type at least one
 * character to search." even though the workspace had five parties. The cause
 * was an early return that produced no query at all for an empty term, so the
 * list could never be populated before typing. These tests pin the rule.
 */
describe('partySearch', () => {
  it('applies no text filter to an empty term, so existing parties are listed', () => {
    expect(partySearch('')).toEqual({ name: null, gstinPrefix: null })
    expect(partySearch('   ')).toEqual({ name: null, gstinPrefix: null })
  })

  it('matches a name on a plain word', () => {
    expect(partySearch('Sunrise')).toEqual({ name: '%Sunrise%', gstinPrefix: null })
  })

  it('matches a name containing a comma without using the or=(...) grammar', () => {
    // or=(...) splits on commas, so a name must never reach it unsanitised.
    const result = partySearch('Anand, Kumar')
    expect(result.name).toBe('%Anand, Kumar%')
    expect(result.gstinPrefix).toBeNull()
  })

  it('treats a long alphanumeric term holding a digit as a GSTIN prefix', () => {
    expect(partySearch('33AAAAA0001BCZ1')).toEqual({
      name: '%33AAAAA0001BCZ1%',
      gstinPrefix: '33AAAAA0001BCZ1%',
    })
  })

  it('does not treat a long ordinary word as a GSTIN', () => {
    // The old rule was "six or more characters", which sent every long word
    // into the or=(...) branch for no reason.
    expect(partySearch('Engineering').gstinPrefix).toBeNull()
    expect(partySearch('Industries').gstinPrefix).toBeNull()
  })

  it('does not treat a short numeric term as a GSTIN', () => {
    expect(partySearch('33').gstinPrefix).toBeNull()
  })

  it('strips commas and brackets from a name that also looks like a GSTIN', () => {
    // This combination is what produced a malformed or=(...) and an empty list.
    const result = partySearch('Anand, Kumar 5')
    expect(result.name).not.toMatch(/[,()]/)
    expect(result.gstinPrefix).toBe('ANANDKUMAR5%')
  })

  it('escapes LIKE wildcards so a term cannot match everything', () => {
    expect(partySearch('100%')).toEqual({ name: '%100\\%%', gstinPrefix: null })
    expect(partySearch('a_b')).toEqual({ name: '%a\\_b%', gstinPrefix: null })
  })
})