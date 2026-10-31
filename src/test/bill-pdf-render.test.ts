import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { TDocumentDefinitions } from 'pdfmake/interfaces'
import { buildBillDefinition } from '../lib/bill-pdf'
import { PDF_FONT_FAMILY, registerPdfFonts } from '../lib/pdf-fonts'
import type { Bill, BillItem } from '../lib/types'

/**
 * Renders the real thing.
 *
 * The challan PDF test in this project exists because every other PDF test
 * mocked pdfmake, and the mock could not see a layout pdfmake itself would
 * refuse to draw. The same reasoning applies here: the widths, the styles and
 * the real text have to be checked against the engine that will produce the
 * file, not against a promise that did not reject.
 *
 * The import is `pdfmake/build/pdfmake.js` on purpose: that is the file Vite
 * hands the browser through the package's `browser` field. Importing the bare
 * `pdfmake` specifier from Node would load the server build instead, which has
 * no `addVirtualFileSystem`.
 */
type PdfMake = typeof import('pdfmake')
type Interop<T> = T & { default?: T }

let pdfmake: PdfMake

beforeAll(async () => {
  const engine = (await import('pdfmake/build/pdfmake.js')) as unknown as Interop<PdfMake>
  pdfmake = (engine.default ?? engine) as PdfMake
  await registerPdfFonts(pdfmake)
})

const COMPANY = {
  name: 'Kallazhagar Industries',
  gstin: '33CAOPR9297L1ZL',
  address: '12 Industrial Estate, Coimbatore 641026',
  phone: '+91 422 234 5678',
  email: 'accounts@kallazhagar.in',
}

const bill = (overrides: Partial<Bill> = {}): Bill => ({
  id: 'bill-1', organization_id: 'org-1', customer_id: 'cust-1', customer_name: 'Acme Engineering',
  customer_gstin: '33AAAAA0001BCZ1', customer_phone: '+91 44 1111 2222', customer_email: 'buy@acme.in',
  customer_address: '4 Market Road, Chennai 600001',
  bill_number: '03', bill_date: '2026-10-05', place_of_supply: 'Tamil Nadu', financial_year: '2026-27',
  tax_mode: 'intra', payment_status: 'unpaid', payment_date: null, payment_method: null,
  source_type: 'manual', verification_status: 'verified', customer_dc_reference: null, notes: null,
  subtotal: 200000, discount_total: 0, taxable_amount: 200000, cgst_amount: 18000, sgst_amount: 18000,
  igst_amount: 0, tax_total: 36000, cess_amount: 0, grand_total: 236000,
  paid_amount: 0, remaining_amount: 236000,
  version: 1, cancellation_reason: null, deleted_at: null, created_at: '2026-10-05T09:00:00Z',
  ...overrides,
})

const item = (overrides: Partial<BillItem> = {}): BillItem => ({
  id: 'bi-1', line_no: 1, bill_id: 'bill-1', product_id: null, product_name: 'CNC Shaft',
  product_code: 'KI-101', hsn_code: '848310', description: 'Machined shaft', unit: 'NOS',
  quantity: 100, rate: 2000, discount: 0, gst_rate: 18,
  line_subtotal: 200000, taxable_amount: 200000, cgst_amount: 18000, sgst_amount: 18000,
  igst_amount: 0, cess_amount: 0, cess_rate: 0, line_total: 236000,
  ...overrides,
})

const REFERENCES = { customerDcNumbers: ['500', '503'], outwardDcNumbers: ['KI/OUT-C/2026-27/0005'] }

/** Real PDF bytes, not merely a promise that did not reject. */
const isPdf = (output: unknown): boolean =>
  output instanceof Uint8Array
  && output.length > 1000
  && String.fromCharCode(...output.subarray(0, 5)) === '%PDF-'

/**
 * Every string pdfkit actually draws.
 *
 * pdfkit draws a wrapped label as consecutive runs, so the runs are joined
 * before they are compared. A per-run comparison never matches a label that
 * wrapped, and a test asserting such a label is absent passes for the wrong
 * reason.
 */
async function draw(definition: TDocumentDefinitions): Promise<string[]> {
  const seed = pdfmake.createPdf(
    { content: [{ text: 'seed' }], defaultStyle: { font: PDF_FONT_FAMILY, fontSize: 9 } } as TDocumentDefinitions,
  )
  const doc = await (await seed.getStream()) as {
    widthOfString(text: string, options: { fontSize: number; fontFamily: string }): number
  }
  type TextFn = (this: unknown, text: unknown, x: number, y: number, options: { fontSize?: number }) => unknown
  const proto = Object.getPrototypeOf(doc) as { text: TextFn }
  const original = proto.text
  const runs: string[] = []
  proto.text = function (this: unknown, text: unknown) {
    runs.push(Array.isArray(text) ? text.join('') : String(text))
    return original.call(this, text, 0, 0, {})
  }
  try {
    await pdfmake.createPdf(definition).getBuffer()
  } finally {
    proto.text = original
  }
  return runs
}

/** The whole document as one string, with all whitespace removed. */
const flat = async (definition: TDocumentDefinitions) =>
  (await draw(definition)).join('').replaceAll(' ', '')

describe('Tax invoice PDF, rendered by the real pdfmake', () => {
  it('produces a PDF', async () => {
    const buffer = await pdfmake.createPdf(buildBillDefinition(bill(), [item()], COMPANY, REFERENCES)).getBuffer()
    expect(isPdf(buffer)).toBe(true)
  })

  it('produces a PDF for a bill with no items, and for one with no company details', async () => {
    const empty = await pdfmake.createPdf(buildBillDefinition(bill(), [], COMPANY, REFERENCES)).getBuffer()
    expect(isPdf(empty)).toBe(true)
    const bare = await pdfmake.createPdf(buildBillDefinition(bill(), [item()], { name: 'Organization' }, REFERENCES)).getBuffer()
    expect(isPdf(bare)).toBe(true)
  })

  it('produces a PDF for an inter-state bill', async () => {
    const inter = await pdfmake.createPdf(buildBillDefinition(
      bill({ tax_mode: 'inter', cgst_amount: 0, sgst_amount: 0, igst_amount: 36000 }),
      [item({ cgst_amount: 0, sgst_amount: 0, igst_amount: 36000 })],
      COMPANY,
      REFERENCES,
    )).getBuffer()
    expect(isPdf(inter)).toBe(true)
  })

  it('produces a PDF when long lines force the table across pages', async () => {
    const items = Array.from({ length: 40 }, (_, index) =>
      item({ id: `bi-${index}`, line_no: index + 1, product_name: `PART-${index}` }))
    const buffer = await pdfmake.createPdf(buildBillDefinition(bill(), items, COMPANY, REFERENCES)).getBuffer()
    expect(isPdf(buffer)).toBe(true)
  })

  it('prints the company letterhead', async () => {
    const drawn = await flat(buildBillDefinition(bill(), [item()], COMPANY, REFERENCES))
    expect(drawn, 'the company name is missing').toContain('KallazhagarIndustries')
    expect(drawn, 'the GSTIN is missing').toContain('33CAOPR9297L1ZL')
    expect(drawn, 'the address is missing').toContain('12IndustrialEstate')
    expect(drawn, 'the phone is missing').toContain('+914222345678')
    expect(drawn, 'the email is missing').toContain('accounts@kallazhagar.in')
  })

  it('names the bill number as a bill number, not as a bare figure', async () => {
    const drawn = await flat(buildBillDefinition(bill(), [item()], COMPANY, REFERENCES))
    expect(drawn, 'the bill number label is missing').toContain('BillNo:03')
    expect(drawn, 'the bill date label is missing').toContain('BillDate:')
    expect(drawn, 'the invoice is not marked as a tax invoice').toContain('TAXINVOICE')
  })

  it('prints the customer DC numbers and the outward challan', async () => {
    const drawn = await flat(buildBillDefinition(bill(), [item()], COMPANY, REFERENCES))
    expect(drawn, 'the customer DC label is missing').toContain('CustomerDC')
    expect(drawn, 'the first customer DC number is missing').toContain('500')
    expect(drawn, 'the second customer DC number is missing').toContain('503')
    expect(drawn, 'the outward DC label is missing').toContain('OutwardDC')
    expect(drawn, 'the outward challan number is missing').toContain('KI/OUT-C/2026-27/0005')
  })

  it('leaves the challan block off a bill that has neither', async () => {
    const drawn = await flat(buildBillDefinition(bill(), [item()], COMPANY, {
      customerDcNumbers: [], outwardDcNumbers: [],
    }))
    expect(drawn, 'a customer DC block was drawn for a bill with no numbers').not.toContain('CustomerDC')
    expect(drawn, 'an outward DC block was drawn for a bill with no challan').not.toContain('OutwardDC')
  })

  it('leaves every discount field off a bill that has no discount', async () => {
    const drawn = await flat(buildBillDefinition(bill(), [item()], COMPANY, REFERENCES))
    expect(drawn, 'a discount column or total was drawn for a bill with no discount').not.toContain('Discount')
  })

  it('prints the discount column and total when the bill has a discount', async () => {
    const drawn = await flat(buildBillDefinition(
      bill({ discount_total: 5000, taxable_amount: 195000 }),
      [item({ discount: 5000, taxable_amount: 195000 })],
      COMPANY,
      REFERENCES,
    ))
    expect(drawn, 'the discount column is missing').toContain('Discount')
    expect(drawn, 'the discount value is missing').toContain('5,000.00')
    expect(drawn.match(/Discount/g)?.length, 'the discount column and total should both be shown').toBe(2)
  })

  it('leaves out a delivery-challan reference that has no value', async () => {
    const drawn = await flat(buildBillDefinition(bill(), [item()], COMPANY, {
      customerDcNumbers: ['500'], outwardDcNumbers: [],
    }))
    expect(drawn, 'the customer DC number is missing').toContain('500')
    expect(drawn, 'an empty outward DC block was drawn').not.toContain('OutwardDC')
  })

  it('prints the signature on the last page only', () => {
    const def = buildBillDefinition(bill(), [item()], COMPANY, REFERENCES)
    expect(typeof def.footer, 'a bill now carries a footer for the signature').toBe('function')
    const footer = def.footer as ((currentPage: number, pageCount: number) => unknown)
    // Pages before the last draw no signatory line.
    expect(footer(1, 3)).toBe('')
    expect(footer(2, 3)).toBe('')
    // The final page carries the right-aligned signatory block.
    const last = JSON.stringify(footer(3, 3))
    expect(last, 'signature is missing from the footer').toContain('Authorised signatory')
    expect(last).toContain(`For ${COMPANY.name}`)
  })

  it('reserves A4 margin space for the signature instead of the body', () => {
    const def = buildBillDefinition(bill(), [item()], COMPANY, REFERENCES)
    // The signature moved from content into the last-page footer; the bottom
    // margin grows to hold it while left, top and right stay as they were.
    const [left, top, right, bottom] = def.pageMargins as number[]
    expect(left).toBe(36)
    expect(top).toBe(32)
    expect(right).toBe(36)
    expect(bottom, 'bottom margin did not grow to fit the signature').toBeGreaterThanOrEqual(72)
  })

  it('prints the total in words as well as in figures', async () => {
    const drawn = await flat(buildBillDefinition(bill(), [item()], COMPANY, REFERENCES))
    expect(drawn, 'the amount in words is missing').toContain('AMOUNTINWORDS')
    expect(drawn, 'the amount in words is wrong').toContain('RupeesTwoLakhThirtySixThousandandZeroPaiseOnly')
    expect(drawn, 'the grand total is missing').toContain('2,36,000.00')
  })

  it('prints the tax summary broken down by rate', async () => {
    const drawn = await flat(buildBillDefinition(bill(), [item()], COMPANY, REFERENCES))
    expect(drawn, 'the tax summary is missing').toContain('TAXSUMMARY')
    expect(drawn, 'the CGST is missing from the summary').toContain('18,000.00')
  })

  it('prints the buyer and the place of supply', async () => {
    const drawn = await flat(buildBillDefinition(bill(), [item()], COMPANY, REFERENCES))
    expect(drawn, 'the buyer is missing').toContain('AcmeEngineering')
    expect(drawn, 'the buyer GSTIN is missing').toContain('33AAAAA0001BCZ1')
    expect(drawn, 'the place of supply is missing').toContain('TamilNadu')
    expect(drawn, 'the signatory line is missing').toContain('Authorisedsignatory')
  })
})

describe('Column widths the installed pdfmake can actually parse', () => {
  /**
   * pdfmake 0.3 accepts a fixed number, "auto", "*", "star" and a percentage.
   * Anything else is silently treated as a literal width, which is the trap:
   * the arithmetic that positions a column concatenates instead of
   * subtracting, and the document aborts with "unsupported number: NaN".
   */
  const SUPPORTED = /^(?:auto|\*|star|\d+(?:\.\d+)?%|\d+(?:\.\d+)?)$/

  it('uses only widths pdfmake recognises, on every table and column', () => {
    const unsupported: string[] = []
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(visit); return }
      if (node === null || typeof node !== 'object') return
      const record = node as Record<string, unknown>
      const widths = Array.isArray(record.widths) ? record.widths : record.width
      for (const width of Array.isArray(widths) ? widths : [widths]) {
        if (typeof width === 'string' && !SUPPORTED.test(width)) unsupported.push(width)
      }
      Object.values(record).forEach(visit)
    }
    visit(buildBillDefinition(bill(), [item()], COMPANY, REFERENCES).content)
    expect(unsupported).toEqual([])
  })

  it('never names a table style that does not exist', () => {
    // pdfmake resolves a string `style` as ONE name, so a style written as
    // 'td num' is looked up literally, found nowhere, and applied not at all.
    const known = new Set(Object.keys(buildBillDefinition(bill(), [item()], COMPANY, REFERENCES).styles ?? {}))
    const unknown: string[] = []
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(visit); return }
      if (node === null || typeof node !== 'object') return
      const record = node as Record<string, unknown>
      const style = record.style
      for (const name of typeof style === 'string' ? [style] : Array.isArray(style) ? style : []) {
        if (typeof name === 'string' && !known.has(name)) unknown.push(name)
      }
      Object.values(record).forEach(visit)
    }
    visit(buildBillDefinition(bill(), [item()], COMPANY, REFERENCES).content)
    expect(unknown).toEqual([])
  })
})

describe('Bill PDF visual parity with the print page', () => {
  /** Walk the pdfmake definition tree collecting every object node. */
  const nodes = (root: unknown): Array<Record<string, unknown>> => {
    const out: Array<Record<string, unknown>> = []
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(walk); return }
      if (value === null || typeof value !== 'object') return
      const record = value as Record<string, unknown>
      out.push(record)
      Object.values(record).forEach(walk)
    }
    walk(root)
    return out
  }

  it('uses DM Sans and never falls back to Roboto', () => {
    const def = buildBillDefinition(bill(), [item()], COMPANY, REFERENCES)
    expect(PDF_FONT_FAMILY).toBe('DMSans')
    expect(def.defaultStyle?.font).toBe('DMSans')
  })

  it('registers only DM Sans with pdfmake (never Roboto)', async () => {
    const calls: unknown[] = []
    const spy = vi.spyOn(pdfmake, 'addFonts').mockImplementation((fonts) => { calls.push(fonts) })
    await registerPdfFonts(pdfmake)
    spy.mockRestore()
    const registered = calls[calls.length - 1] as Record<string, Record<string, string>> | undefined
    expect(registered).toBeDefined()
    expect(Object.keys(registered!)).toEqual(['DMSans'])
    const dmsans = registered!.DMSans as Record<string, string>
    expect(dmsans.normal).toMatch(/DMSans-Regular\.woff$/)
  })

  it('highlights the billed-to / invoice-details block with a #f2f6f5 band', () => {
    const def = buildBillDefinition(bill(), [item()], COMPANY, REFERENCES)
    const banded = nodes(def.content).filter(node => node.fillColor === '#f2f6f5')
    expect(banded.length, 'no highlighted party band').toBeGreaterThan(0)
  })

  it('lays the totals out as a two-column label-above-value grid', () => {
    const def = buildBillDefinition(bill(), [item()], COMPANY, REFERENCES)
    // totalsGrid is a `columns` row of two centred [label, value] stacks - not a table.
    const grid = nodes(def.content).find(node => {
      const cols = node.columns
      return Array.isArray(cols) && cols.length === 2 && cols.every(col => {
        if (!col || typeof col !== 'object') return false
        const c = col as { alignment?: unknown; stack?: unknown }
        return c.alignment === 'center' && Array.isArray(c.stack) && c.stack.length === 2
      })
    })
    expect(grid, 'totals are not a two-column label-above-value grid').toBeDefined()
  })

  it('renders the grand total in company green (#1b5c50)', async () => {
    const def = buildBillDefinition(bill(), [item()], COMPANY, REFERENCES)
    const green = nodes(def.content).filter(node => node.color === '#1b5c50')
    expect(green.length, 'no green grand-total text').toBeGreaterThan(0)
    const drawn = await flat(def)
    expect(drawn, 'the grand total figure is missing').toContain('2,36,000.00')
  })
})
