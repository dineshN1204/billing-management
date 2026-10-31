import { describe, expect, it } from 'vitest'
import { billReferences, referenceText } from '../lib/bill-references'
import type { BillChallanSummary } from '../lib/dc-types'

const challan = (over: Partial<BillChallanSummary> = {}): BillChallanSummary => ({
  dc_id: 'dc-1',
  dc_number: 'KI/OUT-C/2026-27/0005',
  dc_date: '2026-10-05',
  dc_type: 'outward_customer',
  dc_status: 'dispatched',
  customer_dc_numbers: ['500', '503'],
  line_count: 2,
  total_dispatched: 175,
  total_delivered: 0,
  ...over,
})

describe('the numbers a bill prints', () => {
  it('takes the customer DC numbers from the challans it pays for', () => {
    const references = billReferences({ customer_dc_reference: null }, [challan()])
    expect(references.customerDcNumbers).toEqual(['500', '503'])
    expect(references.outwardDcNumbers).toEqual(['KI/OUT-C/2026-27/0005'])
  })

  it('prints the customer number a bill carries by hand', () => {
    // A bill raised by hand - an old invoice typed in from paper - has no
    // challan behind it, so the number it quotes is typed in.
    const references = billReferences({ customer_dc_reference: '507' }, [])
    expect(references.customerDcNumbers).toEqual(['507'])
    expect(references.outwardDcNumbers).toEqual([])
  })

  it('prints the typed number and the challans\' numbers together, without repeating one', () => {
    const references = billReferences({ customer_dc_reference: '503, 507' }, [challan()])
    expect(references.customerDcNumbers).toEqual(['500', '503', '507'])
  })

  it('does not repeat a number that two challans share', () => {
    // One inward challan carried 500 and 503, and two outward challans were
    // made from it. The invoice says 500, 503 once, not twice.
    const references = billReferences({ customer_dc_reference: null }, [
      challan(),
      challan({ dc_id: 'dc-2', dc_number: 'KI/OUT-C/2026-27/0005-2' }),
    ])
    expect(references.customerDcNumbers).toEqual(['500', '503'])
    expect(references.outwardDcNumbers).toEqual(['KI/OUT-C/2026-27/0005', 'KI/OUT-C/2026-27/0005-2'])
  })

  it('has nothing to print for a bill with neither', () => {
    const references = billReferences({ customer_dc_reference: null }, [])
    expect(references.customerDcNumbers).toEqual([])
    expect(references.outwardDcNumbers).toEqual([])
    expect(referenceText(references.customerDcNumbers)).toBe('—')
  })

  it('treats an empty reference as no reference at all', () => {
    const references = billReferences({ customer_dc_reference: '   ' }, [challan({ customer_dc_numbers: [] })])
    expect(references.customerDcNumbers).toEqual([])
  })
})
