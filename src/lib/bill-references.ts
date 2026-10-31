/**
 * The references a bill carries.
 *
 * A bill usually answers to the customer's own challan, not to ours: the
 * customer sends material on their challan 500, we return the finished parts on
 * our outward challan, and the invoice has to say both - the customer's number
 * so they can match it against what they sent, and our number so they can match
 * it against what they received.
 *
 * Both are read from the challans the bill is linked to. A bill that is not
 * linked to any challan (an old invoice typed in by hand) can carry a typed
 * customer reference instead, and that is the one number this module can add
 * on its own.
 *
 * The function is kept apart from the page so it can be tested without a
 * browser: "which numbers does this bill print?" is a question with one
 * answer, and it should have one implementation.
 */
import type { Bill } from './types'
import type { BillChallanSummary } from './dc-types'

export type BillReferences = {
  /** The customer's own challan numbers. */
  customerDcNumbers: string[]
  /** Our outward challan numbers this bill pays for. */
  outwardDcNumbers: string[]
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * A reference can hold more than one number.
 *
 * "500, 503" is two numbers the customer quoted, not one number with a comma
 * in it, and it has to be read as two so that it merges with the numbers a
 * challan carries instead of sitting next to them.
 */
function splitNumbers(value: string | null): string[] {
  if (!value) return []
  return value.split(/[,;/]/).map(part => part.trim()).filter(Boolean)
}

/**
 * The numbers a bill prints, in a stable order and without duplicates.
 *
 * A bill that covers three outward challans, all raised from one inward
 * challan that carried the customer's numbers 500 and 503, prints "500, 503"
 * once - not three times - and one outward number per challan.
 */
export function billReferences(bill: Pick<Bill, 'customer_dc_reference'>, challans: BillChallanSummary[]): BillReferences {
  const customer = new Set<string>()
  for (const challan of challans) {
    for (const number of challan.customer_dc_numbers ?? []) {
      const value = clean(number)
      if (value) customer.add(value)
    }
  }
  for (const number of splitNumbers(bill.customer_dc_reference)) customer.add(number)

  const outward = new Set<string>()
  for (const challan of challans) {
    const value = clean(challan.dc_number)
    if (value) outward.add(value)
  }

  return {
    customerDcNumbers: [...customer].sort((a, b) => a.localeCompare(b)),
    outwardDcNumbers: [...outward].sort((a, b) => a.localeCompare(b)),
  }
}

/**
 * The same numbers as one line of text, for the places that show a cell.
 */
export function referenceText(numbers: string[], fallback = '—'): string {
  return numbers.length ? numbers.join(', ') : fallback
}
