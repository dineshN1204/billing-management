/**
 * The bill number, and the serial inside it.
 *
 * A bill raised from a challan carries that challan's serial: the outward
 * KI/OUT-C/2026-27/0020 is billed as 2026-27/0020 - the same job, written
 * without the challan's prefix and segment. That is what makes a search for
 * "0020" answer with the inward challan, the outward challan and the bill
 * together.
 *
 * The rule belongs to the database (migration 0037, which makes the number
 * and checks it). This file is the browser's copy of it, so the form can show
 * the number it is about to save rather than only the number it has saved.
 * The two have to agree, and the shapes below are the ones the database uses.
 *
 *   2026-27/0020          a series number: a financial year and a serial
 *   KI/OUT-C/2026-27/0020 a challan number: the serial is its last segment
 *   INV-99                a number from outside: no serial and no series
 */

const FINANCIAL_YEAR = /^\d{4}-\d{2}$/
const SERIAL = /^\d+(-\d+)?$/
const SERIES = /^\d{4}-\d{2}\/\d+(-\d+)?$/

/**
 * The serial of a number: the last segment, when it is a number and the
 * segment before it is a financial year.
 *
 *   KI/OUT-C/2026-27/0020  -> 0020
 *   2026-27/0020            -> 0020
 *   2026-27/0020-2          -> 0020-2
 *   INV-99                  -> null
 *
 * A number that holds no serial holds no place in the series: it is a number
 * from outside, and it is left as it was typed.
 */
export function numberSerial(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const parts = value.trim().split('/')
  if (parts.length < 2) return null
  const serial = (parts[parts.length - 1] ?? '').trim()
  const year = (parts[parts.length - 2] ?? '').trim()
  if (!SERIAL.test(serial)) return null
  if (!FINANCIAL_YEAR.test(year)) return null
  return serial
}

/**
 * Whether a number is one of ours.
 *
 * A series number is a financial year and a serial, and nothing else. The old
 * bill numbering - KI/2026-27/0031 - carries a prefix and a segment, and is
 * not one of ours: it names no series, so it never competes for a serial.
 */
export function isSeriesNumber(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false
  return SERIES.test(value.trim())
}

/**
 * The bill number a challan makes.
 *
 * The serial comes from the challan; the financial year comes from the bill,
 * so the number and the financial year printed beside it on the invoice can
 * never disagree. In the ordinary case - a bill raised in the same financial
 * year as the outward challan - the two are the same anyway.
 */
export function billNumberForChallan(dcNumber: string | null | undefined, financialYear: string): string | null {
  const serial = numberSerial(dcNumber)
  if (!serial) return null
  if (!FINANCIAL_YEAR.test(financialYear.trim())) return null
  return `${financialYear.trim()}/${serial}`
}

/** A challan, as far as the number needs to know about it. */
export type NumberedChallan = { dc_number: string; dc_date?: string | null }

/**
 * The challan whose serial the bill number carries.
 *
 * A bill can cover more than one outward challan - a month of deliveries
 * invoiced together - and one number cannot be two. The lowest serial is the
 * one carried, which is the order the challans are read in and the order the
 * register shows them in.
 */
export function pickNumberedChallan<T extends NumberedChallan>(challans: T[]): T | null {
  const numbered = orderBySerial(challans).filter(challan => numberSerial(challan.dc_number) !== null)
  return numbered[0] ?? null
}

/**
 * The challans, in the order their serials run.
 *
 * The order matters for one thing: the challan a bill's number names is
 * linked to the bill first, so that the database's check - that a bill in the
 * series form names a challan the bill pays for - finds that challan among
 * the links the bill already has.
 */
export function orderBySerial<T extends NumberedChallan>(challans: T[]): T[] {
  return [...challans].sort((a, b) => {
    const aSerial = numberSerial(a.dc_number)
    const bSerial = numberSerial(b.dc_number)
    if (aSerial && bSerial) return serialCompare(aSerial, bSerial)
    if (aSerial) return -1
    if (bSerial) return 1
    return 0
  })
}

/**
 * The order two serials are in.
 *
 * 0020 comes before 0021, and 0020 before 0020-2 - a second outward challan
 * made from the same inward one. The number is compared as a number rather
 * than as text, so 0100 comes after 0099.
 */
function serialCompare(a: string, b: string): number {
  const [aNumber, aSuffix] = splitSerial(a)
  const [bNumber, bSuffix] = splitSerial(b)
  if (aNumber !== bNumber) return aNumber < bNumber ? -1 : 1
  if (aSuffix === bSuffix) return 0
  return aSuffix < bSuffix ? -1 : 1
}

function splitSerial(serial: string): [number, number] {
  const [head, tail] = serial.split('-')
  return [Number(head ?? 0) || 0, Number(tail ?? 0) || 0]
}
