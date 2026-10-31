import Decimal from 'decimal.js'
import type { BillPayloadItem } from './types'

export function calculateBill(items: BillPayloadItem[], mode: 'intra' | 'inter') {
  const totals = { subtotal: 0, discount: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, total: 0 }
  const round = (value: Decimal) => value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
  const value = (input?: string) => {
    try { return new Decimal(input || 0) } catch { return new Decimal(0) }
  }
  for (const item of items) {
    const gross = round(value(item.quantity).mul(value(item.rate)))
    const discount = value(item.discount)
    const taxable = gross.minus(discount)
    const rate = value(item.gst_rate)
    const cgst = mode === 'intra' ? round(taxable.mul(rate).div(200)) : new Decimal(0)
    const sgst = cgst
    const igst = mode === 'inter' ? round(taxable.mul(rate).div(100)) : new Decimal(0)
    const cess = item.cess_amount && value(item.cess_amount).greaterThan(0) ? value(item.cess_amount) : round(taxable.mul(value(item.cess_rate)).div(100))
    totals.subtotal = round(new Decimal(totals.subtotal).plus(gross)).toNumber()
    totals.discount = round(new Decimal(totals.discount).plus(discount)).toNumber()
    totals.taxable = round(new Decimal(totals.taxable).plus(taxable)).toNumber()
    totals.cgst = round(new Decimal(totals.cgst).plus(cgst)).toNumber()
    totals.sgst = round(new Decimal(totals.sgst).plus(sgst)).toNumber()
    totals.igst = round(new Decimal(totals.igst).plus(igst)).toNumber()
    totals.cess = round(new Decimal(totals.cess).plus(cess)).toNumber()
  }
  totals.total = new Decimal(totals.taxable).plus(totals.cgst).plus(totals.sgst).plus(totals.igst).plus(totals.cess).toNumber()
  return totals
}

/**
 * What has been received against a bill, and what is still owed.
 *
 * The same rule the database applies (migration 0038): an unpaid bill has
 * received nothing, a paid bill has received its whole total, and a partly
 * paid bill has received what has been typed into it. The remaining is the
 * total less the received, and never below zero.
 *
 * The form uses this so the figure on the screen and the figure on the saved
 * bill are the same figure; the database works it out again on save.
 */
export function paymentBalance(
  total: number,
  status: 'paid' | 'partial' | 'unpaid',
  amountReceived: string | number,
) {
  const received = status === 'paid'
    ? total
    : status === 'partial'
      ? (Number.isFinite(Number(amountReceived)) ? Number(amountReceived) : 0)
      : 0
  const remaining = Math.max(0, Math.round((total - received) * 100) / 100)
  return { received, remaining }
}

/**
 * What a bill still owes.
 *
 * `remaining_amount` is a generated column in the database, so it is the
 * authority and every screen reads the same number.
 *
 * The fallback covers the moment when the Data API's schema cache is older
 * than the migration that added the column: the browser then reads a row
 * without it. Showing the whole bill as owed in that moment is the figure
 * this system showed before the column existed, and it is wrong in the way the
 * system was already wrong - a zero would be wrong in a way nobody could
 * see.
 */
export function billRemaining(bill: {
  grand_total: number
  paid_amount?: number | null
  remaining_amount?: number | null
}): number {
  if (Number.isFinite(bill.remaining_amount)) return bill.remaining_amount as number
  return Math.max(0, bill.grand_total - (bill.paid_amount ?? 0))
}
