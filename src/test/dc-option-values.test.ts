import { describe, expect, it } from 'vitest'
import { optionValue } from '../lib/dc-api'

/**
 * The dropdowns offer the human labels seeded into dc_options, but
 * receipt_type, movement_type and delivery_purpose are constrained columns that
 * hold fixed slugs. Turning a label into a slug by lowercasing it and swapping
 * spaces for underscores is right often enough to be tempting and wrong exactly
 * where it matters, and the database refuses the save with a 400:
 *
 *   VALIDATION_ERROR: movement_type must be one of: subcontracting,
 *     inter_company, return_to_supplier, testing, inspection, other
 *
 * The production branch was hit on "Inter-Company Transfer" and on every receipt
 * type, because that dropdown sent the raw label with no slugification at all.
 * These are the values the database actually accepts, copied from the
 * parse_enum call lists in db/migrations/0016_dc_rpc.sql.
 */
const ALLOWED: Record<string, string[]> = {
  receipt_type: ['raw_material', 'customer_owned', 'semi_finished', 'inspection_rework', 'return_from_processing', 'other'],
  movement_type: ['subcontracting', 'inter_company', 'return_to_supplier', 'testing', 'inspection', 'other'],
  delivery_purpose: ['finished_goods', 'partially_processed', 'sample', 'customer_inspection', 'replacement', 'rework', 'other'],
}

/** The labels dc_seed_options writes, in its own order. */
const SEEDED: Record<string, string[]> = {
  receipt_type: ['Raw Material', 'Customer Owned Component', 'Semi-Finished Component', 'Return from Processing', 'For Inspection', 'For Rework'],
  movement_type: ['Subcontracting', 'Inter-Company Transfer', 'Return to Supplier', 'Testing', 'Inspection', 'Other'],
  delivery_purpose: ['Finished Goods', 'Partially Processed', 'Approved Sample', 'Customer Inspection', 'Replacement', 'Rework', 'Other'],
}

describe('DC option labels', () => {
  it('maps every seeded label to a value the database accepts', () => {
    for (const [group, allowed] of Object.entries(ALLOWED)) {
      for (const label of SEEDED[group] ?? []) {
        expect(allowed, `${group}: "${label}" maps to ${optionValue(group, label)}`).toContain(optionValue(group, label))
      }
    }
  })

  it('sends the label for the cases a plain slugification gets wrong', () => {
    expect(optionValue('movement_type', 'Inter-Company Transfer')).toBe('inter_company')
    expect(optionValue('delivery_purpose', 'Approved Sample')).toBe('sample')
    // Both of these share one column value, which no slugification produces.
    expect(optionValue('receipt_type', 'For Inspection')).toBe('inspection_rework')
    expect(optionValue('receipt_type', 'For Rework')).toBe('inspection_rework')
  })

  it('agrees with slugification where slugification is already right', () => {
    expect(optionValue('receipt_type', 'Raw Material')).toBe('raw_material')
    expect(optionValue('receipt_type', 'Semi-Finished Component')).toBe('semi_finished')
    expect(optionValue('movement_type', 'Return to Supplier')).toBe('return_to_supplier')
    expect(optionValue('delivery_purpose', 'Finished Goods')).toBe('finished_goods')
  })

  it('falls back to the plain slug for a label nobody has mapped', () => {
    // An option added in DC settings has no counterpart in the map. The value it
    // produces is what the column rejects, and saying so is better than silently
    // picking a different meaning.
    expect(optionValue('delivery_purpose', 'Something New')).toBe('something_new')
    expect(ALLOWED['delivery_purpose']).not.toContain('something_new')
  })
})