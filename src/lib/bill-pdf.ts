/**
 * PDF generation for tax invoices.
 *
 * pdfmake is loaded with a dynamic import so it lands in its own chunk and costs
 * nothing until someone asks for a PDF - the same arrangement as the delivery
 * challan PDF.
 *
 * A bill is a tax invoice: it states the seller's details, the buyer's details,
 * the challans it answers to, the tax on every line, and the total in words as
 * well as in figures. Nothing here is invented - a company detail that is not on
 * file is left off the document rather than filled in with a guess, and the
 * screen that offers the download says so.
 *
 * Source note: this file is deliberately ASCII only. An em dash or a middle dot
 * written literally here has twice been re-encoded by a shell round trip and
 * corrupted the file, so the few places that need them use escapes instead.
 */
import type { Content, ContentText, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces'
import { amountInWords } from './amount-in-words'
import { billRemaining } from './calculations'
import type { BillReferences } from './bill-references'
import { displayDate, plainAmount } from './format'
import { PDF_FONT_FAMILY, registerPdfFonts } from './pdf-fonts'
import type { Bill, BillItem } from './types'

export type Company = {
  name: string
  gstin?: string | null
  address?: string | null
  phone?: string | null
  email?: string | null
  state_code?: string | null
}

const EM = '\u2014'

/** A label and its value, stacked label-above-value the way the challan PDF does it. */
const pairs = (rows: Array<[string, string]>): Content => ({
  stack: rows.flatMap(([label, value]) => [
    { text: label.toUpperCase(), style: 'label', margin: [0, 0, 0, 2] },
    { text: value, style: 'value', margin: [0, 0, 0, 6] },
  ]),
})

const ink = '#1b2f38'
const muted = '#78928e'
const rule = '#d5dfe1'
const band = '#f2f6f5'
const strong = '#1b5c50'

const text = (value: string | null | undefined, fallback: string = EM) =>
  (value && value.trim() ? value : fallback)

/**
 * Relative column weights, as the percentage widths pdfmake actually understands.
 *
 * The weighted-star syntax ("* 0.5") was removed in pdfmake 0.3 and is not
 * replaced here. Percentages are the equivalent, and the final column absorbs
 * the rounding so a set of widths always totals exactly 100.
 */
function share(...weights: number[]): string[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  const parts = weights.slice(0, -1).map(weight => Number(((weight / total) * 100).toFixed(4)))
  const last = Number((100 - parts.reduce((sum, part) => sum + part, 0)).toFixed(4))
  return [...parts.map(part => `${part}%`), `${last}%`]
}

/**
 * pdfmake's own types reject a table whose body cells carry the properties this
 * layout legitimately uses, so tables are assembled here and handed over as
 * `Content`.
 */
const table = (widths: string[], body: TableCell[]): Content =>
  ({ table: { headerRows: 1, widths, body }, layout: 'lightHorizontalLines' }) as unknown as Content

/** A header cell, centred in its column. */
const head = (value: string): ContentText => ({ text: value, style: 'th', alignment: 'center' })
/** A number cell, centred in its column. */
const num = (value: string | Content): ContentText => ({ text: value, style: ['td', 'num'], alignment: 'center' })
/** A text cell, centred in its column. */
const plain = (value: string | Content): ContentText => ({ text: value, style: 'td', alignment: 'center' })

/**
 * One row per bill line.
 *
 * The tax is shown as one column rather than two. Whether it is CGST and SGST
 * or IGST is stated once, in the heading of the tax summary underneath, so a
 * line does not repeat it.
 */
function itemRows(items: BillItem[], hasDiscount: boolean): TableCell[] {
  const rows: TableCell[] = [
    [
      head('#'),
      head('Description'),
      head('HSN'),
      head('Quantity'),
      head('Rate (Rs.)'),
      ...(hasDiscount ? [head('Discount (Rs.)')] : []),
      head('Taxable (Rs.)'),
      head('GST %'),
      head('Tax (Rs.)'),
      head('Amount (Rs.)'),
    ],
  ]

  for (const [index, item] of items.entries()) {
    rows.push([
      plain(String(index + 1)),
      plain([
        item.product_name,
        item.description ? { text: item.description, style: 'sub' } : '',
      ]),
      plain(item.hsn_code ?? ''),
      num(`${plainAmount(item.quantity)} ${item.unit}`),
      num(plainAmount(item.rate)),
      ...(hasDiscount ? [num(plainAmount(item.discount))] : []),
      num(plainAmount(item.taxable_amount)),
      num(`${plainAmount(item.gst_rate)}%`),
      num(plainAmount(item.cgst_amount + item.sgst_amount + item.igst_amount)),
      num(plainAmount(item.line_total)),
    ])
  }

  return rows
}

/**
 * The tax broken down by rate.
 *
 * A tax invoice has to show what each rate was applied to, which is what the
 * rate-wise summary is for. CGST and SGST are shown separately for a bill
 * within the state and IGST for a bill to another state - never both.
 */
function taxSummaryRows(items: BillItem[], taxMode: 'intra' | 'inter'): TableCell[] {
  const rates = [...new Set(items.map(item => Number(item.gst_rate)))].sort((a, b) => a - b)
  const rows: TableCell[] = [
    taxMode === 'intra'
      ? [head('GST rate'), head('Taxable (Rs.)'), head('CGST (Rs.)'), head('SGST (Rs.)')]
      : [head('GST rate'), head('Taxable (Rs.)'), head('IGST (Rs.)')],
  ]

  for (const rate of rates) {
    const lines = items.filter(item => Number(item.gst_rate) === rate)
    const taxable = lines.reduce((sum, item) => sum + Number(item.taxable_amount), 0)
    const cgst = lines.reduce((sum, item) => sum + Number(item.cgst_amount), 0)
    const sgst = lines.reduce((sum, item) => sum + Number(item.sgst_amount), 0)
    const igst = lines.reduce((sum, item) => sum + Number(item.igst_amount), 0)
    rows.push(taxMode === 'intra'
      ? [num(`${plainAmount(rate)}%`), num(plainAmount(taxable)), num(plainAmount(cgst)), num(plainAmount(sgst))]
      : [num(`${plainAmount(rate)}%`), num(plainAmount(taxable)), num(plainAmount(igst))])
  }

  return rows
}

/**
 * The totals, laid out like the on-screen preview: a label above its value, both
 * centred, in two columns - Subtotal | Taxable amount on the first row, the tax
 * split beneath it, and the Grand total spanning the full width in company green.
 *
 * Each cell is one stack of [label, value]; pdfmake draws it centred under its
 * column because the cell carries `alignment: 'center'`. The grid is built from
 * nested `columns` (one row of two cells at a time) rather than a table, so the
 * cell alignment and the spanning grand total behave exactly like the preview
 * and stay within pdfmake's own type system.
 */
function totalsGrid(bill: Bill, hasDiscount: boolean): Content[] {
  const rows: Array<[string, string]> = [
    ['Subtotal', plainAmount(bill.subtotal)],
    ...(hasDiscount ? [[`Discount`, `- ${plainAmount(bill.discount_total)}`] as [string, string]] : []),
    ['Taxable amount', plainAmount(bill.taxable_amount)],
  ]
  if (bill.tax_mode === 'intra') {
    rows.push(['CGST', plainAmount(bill.cgst_amount)] as [string, string])
    rows.push(['SGST', plainAmount(bill.sgst_amount)] as [string, string])
  } else {
    rows.push(['IGST', plainAmount(bill.igst_amount)] as [string, string])
  }
  if (Number(bill.cess_amount) > 0) {
    rows.push(['Cess', plainAmount(bill.cess_amount)] as [string, string])
  }

  const cell = (pair: [string, string]): Content => ({
    stack: [
      { text: pair[0], fontSize: 8, color: '#788c89', margin: [0, 0, 0, 2] },
      { text: pair[1], fontSize: 9, color: ink, bold: true },
    ],
    alignment: 'center',
  })

  const body: Content[] = []
  for (let i = 0; i < rows.length; i += 2) {
    const first = rows[i]!
    const second = rows[i + 1]
    // Odd count: the lonely value takes the full width, centred.
    body.push({ columns: second ? [cell(first), cell(second)] : [cell(first)] })
  }
  body.push({
    alignment: 'center',
    stack: [
      { text: 'Grand total', fontSize: 9, color: strong, margin: [0, 8, 0, 2] },
      { text: plainAmount(bill.grand_total), fontSize: 11, color: strong, bold: true },
    ],
  })

  return body
}

/**
 * Builds the whole invoice.
 *
 * Everything printed here comes from the bill, its lines, the company profile
 * and the challans it is linked to. A company detail that is not on file is
 * left off rather than guessed at.
 */
export function buildBillDefinition(
  bill: Bill,
  items: BillItem[],
  company: Company,
  references: BillReferences,
): TDocumentDefinitions {
  const hasDiscount = Number(bill.discount_total) > 0

  const header: Content = {
    margin: [0, 0, 0, 10],
    columns: [
      {
        width: '58%',
        stack: [
          { text: company.name, fontSize: 15, bold: true, color: ink },
          company.address ? { text: company.address, style: 'body' } : '',
          company.phone ? { text: `Phone: ${company.phone}`, style: 'body' } : '',
          company.email ? { text: `Email: ${company.email}`, style: 'body' } : '',
          company.gstin ? { text: `GSTIN: ${company.gstin}`, style: 'body' } : '',
        ],
      },
      {
        width: '42%',
        alignment: 'right',
        stack: [
          { text: 'TAX INVOICE', fontSize: 16, bold: true, color: ink, margin: [0, 0, 0, 4] },
          { text: `Bill No: ${bill.bill_number}`, fontSize: 12, bold: true, color: ink },
          { text: `Bill Date: ${displayDate(bill.bill_date)}`, style: 'body' },
          { text: `Financial year: ${bill.financial_year}`, style: 'body' },
        ],
      },
    ],
  }

  // Billed-to party + invoice details, under one highlighted band so the two
  // sections read as one block, exactly as the on-screen preview does.
  const billedTo: Content = {
    margin: [0, 10, 0, 0],
    fillColor: band,
    stack: [
      {
        margin: [12, 9, 12, 9],
        columns: [
          {
            width: '55%',
            stack: [
              { text: 'BILLED TO', style: 'label', margin: [0, 0, 0, 3] },
              { text: bill.customer_name, style: 'value', bold: true },
              bill.customer_address ? { text: bill.customer_address, style: 'body' } : '',
              bill.customer_gstin ? { text: `GSTIN: ${bill.customer_gstin}`, style: 'body' } : '',
              bill.customer_phone ? { text: `Phone: ${bill.customer_phone}`, style: 'body' } : '',
              bill.customer_email ? { text: `Email: ${bill.customer_email}`, style: 'body' } : '',
            ],
          },
          {
            width: '45%',
            stack: [
              { text: 'INVOICE DETAILS', style: 'label', margin: [0, 0, 0, 3] },
              pairs([
                ['Place of supply', text(bill.place_of_supply)],
                ['Tax type', bill.tax_mode === 'intra' ? 'CGST + SGST' : 'IGST'],
                ['Payment status', bill.payment_status],
                ...(bill.payment_date ? [['Payment date', displayDate(bill.payment_date)] as [string, string]] : []),
                ...(bill.payment_method ? [['Payment method', bill.payment_method] as [string, string]] : []),
                // What has been received, and what is still owed. Printed only when
                // something has been received: an unpaid invoice has nothing to
                // report, and a line reading "amount received 0.00" says less than
                // no line at all.
                ...(bill.payment_status !== 'unpaid' ? [
                  ['Amount received', plainAmount(bill.paid_amount ?? 0)] as [string, string],
                  ['Balance due', plainAmount(billRemaining(bill))] as [string, string],
                ] : []),
              ]),
            ],
          },
        ],
      },
    ],
  }

  /**
   * The challans this bill answers to.
   *
   * A job-work invoice is read against the customer's challan and against our
   * outward challan, so both numbers are printed. They are omitted entirely
   * when the bill has neither, rather than printing an empty line.
   */
  const referenceBlock: Content = (references.customerDcNumbers.length > 0 || references.outwardDcNumbers.length > 0)
    ? {
      margin: [0, 10, 0, 0],
      stack: [
        { text: 'DELIVERY CHALLANS', style: 'label', margin: [0, 0, 0, 3] },
        {
          columns: [
            ...(references.customerDcNumbers.length > 0
              ? [{
                width: references.outwardDcNumbers.length > 0 ? '50%' : '100%',
                stack: [{
                  columns: [
                    { text: 'Customer DC', style: 'label', width: '40%' },
                    { text: references.customerDcNumbers.join(', ') || EM, style: 'body', width: '60%' },
                  ],
                }],
              } as Content]
              : []),
            ...(references.outwardDcNumbers.length > 0
              ? [{
                width: references.customerDcNumbers.length > 0 ? '50%' : '100%',
                stack: [{
                  columns: [
                    { text: 'Outward DC', style: 'label', width: '40%' },
                    { text: references.outwardDcNumbers.join(', ') || EM, style: 'body', width: '60%' },
                  ],
                }],
              } as Content]
              : []),
          ],
        },
      ],
    }
    : ''

  const totals: Content = {
    margin: [0, 16, 0, 0],
    columns: [
      {
        width: '55%',
        stack: [
          { text: 'AMOUNT IN WORDS', style: 'label', margin: [0, 0, 0, 3] },
          { text: amountInWords(Number(bill.grand_total)), style: 'value' },
          bill.notes ? { text: `Notes: ${bill.notes}`, style: 'sub', margin: [0, 8, 0, 0] } : '',
        ],
      },
      {
        width: '45%',
        stack: totalsGrid(bill, hasDiscount),
      },
    ],
  }

  const signature: Content = {
    alignment: 'right',
    stack: [
      { text: `For ${company.name}`, style: 'value', margin: [0, 0, 0, 22] },
      { text: '____________________________', style: 'value' },
      { text: 'Authorised signatory', style: 'label', margin: [0, 4, 0, 0] },
    ],
  }

  return {
    pageSize: 'A4',
    pageMargins: [36, 32, 36, 96],
    info: {
      title: `Tax Invoice ${bill.bill_number}`,
      author: company.name,
      subject: text(bill.notes, `Tax invoice for ${bill.customer_name}`),
    },
    defaultStyle: { font: PDF_FONT_FAMILY, fontSize: 9, color: ink },
    styles: {
      th: { fontSize: 8, fillColor: band, color: muted, margin: [0, 4, 0, 4] },
      td: { fontSize: 9, color: ink, margin: [0, 4, 0, 4] },
      num: { alignment: 'right' },
      sub: { fontSize: 7, color: muted },
      label: { fontSize: 8, color: muted, bold: true },
      value: { fontSize: 9, color: ink },
      body: { fontSize: 9, color: ink },
    },
    /* The signature belongs to the signed document, so it prints once, on the
       last page, in the bottom margin that pageMargins reserves for it. The
       extra bottom margin (was 40pt) is the only padding change - the body
       still keeps its A4 left/right/top margins. The footer is inset by the
       page's left/right margins so the signatory lines up with the item table
       instead of starting at the page edge. */
    footer: (currentPage: number, pageCount: number) =>
      currentPage === pageCount ? { margin: [36, 0, 36, 0], stack: [signature] } : '',
    content: [
      header,
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 595 - 72, y2: 0, lineWidth: 1, lineColor: rule }] },
      billedTo,
      referenceBlock,
      { margin: [0, 8, 0, 0], table: { headerRows: 1, widths: itemTableWidths(hasDiscount), body: itemRows(items, hasDiscount) } } as unknown as Content,
      { margin: [0, 12, 0, 0], stack: [
        { text: 'TAX SUMMARY', style: 'label', margin: [0, 0, 0, 4] },
        table(
          bill.tax_mode === 'intra' ? share(1, 1.4, 1.4, 1.4) : share(1, 1.6, 1.6),
          taxSummaryRows(items, bill.tax_mode),
        ),
      ] },
      totals,
    ],
  }
}

/** Widths for the item table, with or without the discount column. */
function itemTableWidths(hasDiscount: boolean): string[] {
  return hasDiscount
    ? share(0.35, 1.8, 0.7, 0.9, 0.8, 0.8, 0.9, 0.6, 0.85, 1.0)
    : share(0.35, 2.1, 0.75, 0.95, 0.9, 1.05, 0.7, 0.95, 1.1)
}

type PdfMake = typeof import('pdfmake')
type Interop<T> = T & { default?: T }

/**
 * Builds and downloads the PDF. pdfmake and its font file are fetched only when
 * this is called, so neither costs a byte until someone asks for a PDF.
 */
export async function downloadBillPdf(
  bill: Bill,
  items: BillItem[],
  company: Company,
  references: BillReferences,
): Promise<void> {
  const pdfmakeModule = (await import('pdfmake')) as unknown as Interop<PdfMake>
  const pdfmake = pdfmakeModule.default ?? pdfmakeModule
  await registerPdfFonts(pdfmake)

  const document = buildBillDefinition(bill, items, company, references)
  const safeName = bill.bill_number.replace(/[\\/:*?"<>|]/g, '-')
  await pdfmake.createPdf(document).download(`${safeName}.pdf`)
}
