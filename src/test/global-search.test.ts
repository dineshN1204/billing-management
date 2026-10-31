import { describe, expect, it } from 'vitest'
import { firstSearchTarget, rankDcs, type DcHit } from '../lib/global-search'
import type { DcType } from '../lib/dc-types'

/**
 * The header search found customers by name and GSTIN but had no idea what a
 * delivery challan was, so typing a DC number - the one reference printed on the
 * paper copy someone hands you - returned nothing at all, and Enter did nothing
 * because it only ever knew how to open a customer.
 *
 * A second problem followed: the challan query matches on a substring, so a
 * partial number matches a longer one too. Ranking and the Enter rule below are
 * what stop the wrong document from being the one you land on.
 */
const dc = (dc_number: string, id = dc_number, dc_type: DcType = 'inward', customer_dc_numbers: string[] | null = null): DcHit => ({
  id, dc_number, dc_type, dc_date: '2026-01-01', status: 'issued', party_name: 'Acme',
  customer_dc_numbers, matched_on: null,
})

describe('rankDcs', () => {
  it('puts the exact number first, even when a longer one also matches', () => {
    const hits = [dc('OUT-2025-00420', 'long'), dc('IN-2025-0042', 'exact'), dc('IN-2025-00421', 'other')]
    expect(rankDcs('IN-2025-0042', hits).map(h => h.id)).toEqual(['exact', 'other', 'long'])
  })

  it('ignores case and surrounding spaces on both sides', () => {
    const hits = [dc('in-2025-0042', 'lower')]
    expect(rankDcs('  IN-2025-0042  ', hits).map(h => h.id)).toEqual(['lower'])
  })

  it('ranks a prefix match above a match in the middle of the number', () => {
    const hits = [dc('X-IN-2025-0042', 'inner'), dc('IN-2025-0042-A', 'prefix')]
    expect(rankDcs('IN-2025-0042', hits).map(h => h.id)).toEqual(['prefix', 'inner'])
  })

  it('keeps the given order for an empty term', () => {
    const hits = [dc('B', 'b'), dc('A', 'a')]
    expect(rankDcs('   ', hits).map(h => h.id)).toEqual(['b', 'a'])
  })

  it('does not mutate the array it was given', () => {
    const hits = [dc('OUT-1', 'b'), dc('IN', 'a')]
    rankDcs('IN', hits)
    expect(hits.map(h => h.id)).toEqual(['b', 'a'])
  })

  it('puts the challan named by the customer\'s own DC number above a loose match', () => {
    // Someone quotes the number printed on their own paperwork. That number is
    // not ours, so it matches no dc_number at all - it can only rank through the
    // customer DC numbers the challan carries.
    const hits = [
      dc('OUT-2025-00900', 'loose'),
      dc('IN-2025-00007', 'named', 'inward', ['CUST-4411']),
    ]
    expect(rankDcs('CUST-4411', hits).map(h => h.id)).toEqual(['named', 'loose'])
  })

  it('treats a customer DC number as a prefix match too, ignoring case', () => {
    const hits = [dc('IN-1', 'loose'), dc('IN-2', 'named', 'inward', ['cust-4411'])]
    expect(rankDcs('  CUST-4411  ', hits).map(h => h.id)).toEqual(['named', 'loose'])
  })
})

describe('firstSearchTarget on Enter', () => {
  it('opens the challan whose number was typed, not a customer', () => {
    // The old handler always opened customers[0], so a DC number went nowhere.
    expect(firstSearchTarget('IN-2025-0042', {
      dcs: [dc('IN-2025-0042', 'abc')], customers: [{ id: 'cust-1' }], bills: [], products: [],
    })).toBe('/dc/inward/abc')
  })

  it('opens the exact number even when a longer one is listed first', () => {
    expect(firstSearchTarget('IN-0042', {
      dcs: [dc('IN-00420', 'long'), dc('IN-0042', 'exact')], customers: [{ id: 'cust-1' }], bills: [], products: [],
    })).toBe('/dc/inward/exact')
  })

  it('sends each challan type to its own detail route', () => {
    // One route per type: an outward challan read through the inward route
    // shows the wrong screen.
    const route = (dc_type: DcType) => firstSearchTarget('X', {
      dcs: [dc('X', 'id', dc_type)], customers: [], bills: [], products: [],
    })
    expect(route('inward')).toBe('/dc/inward/id')
    expect(route('outward_customer')).toBe('/dc/outward/id')
    expect(route('material_return')).toBe('/dc/inward/id')
  })

  it('still opens a customer when no challan matched', () => {
    expect(firstSearchTarget('Sunrise', {
      dcs: [], customers: [{ id: 'cust-1' }], bills: [{ id: 'b1' }], products: [{ id: 'p1' }],
    })).toBe('/customers/cust-1')
  })

  it('falls back to a bill, then a product, when there is nothing better', () => {
    expect(firstSearchTarget('INV', { dcs: [], customers: [], bills: [{ id: 'b1' }], products: [{ id: 'p1' }] })).toBe('/bills/b1')
    expect(firstSearchTarget('Nut', { dcs: [], customers: [], bills: [], products: [{ id: 'p1' }] })).toBe('/products/p1')
  })

  it('goes nowhere when there is no match at all', () => {
    expect(firstSearchTarget('zzz', { dcs: [], customers: [], bills: [], products: [] })).toBeNull()
  })
})
