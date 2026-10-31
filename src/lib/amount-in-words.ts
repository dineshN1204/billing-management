/**
 * The amount on an invoice, written out in words.
 *
 * Indian tax invoices carry the total in words as well as in figures, and the
 * words are what a bank or a customer reads when they check the two against
 * each other. This writes them the way they are written on an Indian invoice:
 * rupees and paise, in the lakh-crore scale, with "Only" at the end.
 *
 * The scale is the Indian one, not the western one: 1,00,000 is one lakh and
 * 1,00,00,000 is one crore. Writing "One Hundred Thousand" on an invoice
 * issued in India would be read as an error.
 */

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
]

const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

/** 1 to 99. */
function underHundred(value: number): string {
  if (value < 20) return ONES[value] ?? ''
  const tens = Math.floor(value / 10)
  const ones = value % 10
  return [TENS[tens], ONES[ones]].filter(Boolean).join(' ')
}

/** 1 to 999. */
function underThousand(value: number): string {
  const hundreds = Math.floor(value / 100)
  const rest = value % 100
  return [hundreds ? `${ONES[hundreds]} Hundred` : '', rest ? underHundred(rest) : ''].filter(Boolean).join(' ')
}

/**
 * The whole number, in the Indian scale.
 *
 * Exported for the test and for reuse: the PDF needs the rupees part on its
 * own so it can be shown next to the paise.
 */
export function rupeesInWords(value: number): string {
  const rupees = Math.floor(Math.abs(value))
  if (!Number.isFinite(rupees) || rupees === 0) return 'Zero'

  const parts: string[] = []
  let rest = rupees

  const crore = Math.floor(rest / 10000000)
  if (crore) { parts.push(`${underThousand(crore)} Crore`); rest %= 10000000 }

  const lakh = Math.floor(rest / 100000)
  if (lakh) { parts.push(`${underHundred(lakh)} Lakh`); rest %= 100000 }

  const thousand = Math.floor(rest / 1000)
  if (thousand) { parts.push(`${underHundred(thousand)} Thousand`); rest %= 1000 }

  if (rest) parts.push(underThousand(rest))

  return parts.join(' ')
}

/**
 * The full amount, the way it is written on an invoice.
 *
 * The amount is rounded to the nearest paisa first, which is what the money
 * is: a half-rupee is not a thing that can be written on a bill, and rounding
 * it the same way the totals are rounded keeps the words and the figures in
 * agreement. Rounding after splitting the amount into rupees and paise would
 * turn 100.999 into "one hundred and one hundred paise", which is not a
 * number anybody can read.
 */
export function amountInWords(value: number): string {
  if (!Number.isFinite(value)) return ''
  const negative = value < 0
  const totalPaise = Math.round(Math.abs(value) * 100)
  const rupees = Math.floor(totalPaise / 100)
  const paise = totalPaise % 100

  const words = rupeesInWords(rupees)
  const paiseWords = paise === 0 ? 'Zero Paise' : `${underHundred(paise)} Paise`

  return `${negative ? 'Minus ' : ''}Rupees ${words} and ${paiseWords} Only`
}
