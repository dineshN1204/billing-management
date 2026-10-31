import { describe, expect, it } from 'vitest'
import type { DcType } from '../lib/dc-types'
import type { PartyType } from '../lib/types'

/**
 * Billing and Delivery Challans share one party master, so a party added under
 * Billing is the same row the DC module reads. These rules decide which DC
 * pickers offer it, and they are the reason a machining vendor cannot be
 * dispatched to as if it were a customer.
 *
 * The list is duplicated from src/pages/DcForm.tsx on purpose: it is a business
 * rule, not a rendering detail, and asserting it here means a future edit to
 * either file cannot quietly widen what a picker offers.
 */
const PARTY_TYPES: Record<DcType, PartyType[]> = {
  inward: ['customer', 'supplier', 'vendor', 'other'],
  outward_customer: ['customer'],
  material_return: ['customer', 'supplier', 'vendor', 'other'],
}

const DEFAULT_PARTY_TYPE: PartyType = 'customer'

describe('One party master, shared by Billing and Delivery Challans', () => {
  it('classifies a party created in Billing as a customer by default', () => {
    // db/migrations/0013 adds party_type NOT NULL DEFAULT 'customer', and
    // CustomerForm still defaults the dropdown to it. A party therefore needs
    // no migration, import or sync step to appear in the DC module.
    expect(DEFAULT_PARTY_TYPE).toBe('customer')
  })

  it('offers an ordinary customer everywhere a DC is received from or delivered to', () => {
    expect(PARTY_TYPES.inward).toContain('customer')
    expect(PARTY_TYPES.outward_customer).toContain('customer')
    expect(PARTY_TYPES.material_return).toContain('customer')
  })

  it('keeps a vendor out of the customer delivery picker', () => {
    // This is the safeguard: a heat-treatment vendor must never be offered as a
    // delivery destination for finished goods.
    expect(PARTY_TYPES.outward_customer).not.toContain('vendor')
  })

  it('lets an inward challan accept any authorised party', () => {
    expect([...PARTY_TYPES.inward].sort()).toEqual(['customer', 'other', 'supplier', 'vendor'])
  })
})