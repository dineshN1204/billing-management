import { beforeAll, describe, expect, it } from 'vitest'
import type { TDocumentDefinitions } from 'pdfmake/interfaces'
import { buildDcDefinition } from '../lib/dc-pdf'
import { PDF_FONT_FAMILY, registerPdfFonts } from '../lib/pdf-fonts'
import type { DcBundle, DcDocument, DcItem, DcMachiningResult, DcType } from '../lib/dc-types'

/**
 * Renders the real thing.
 *
 * Every other PDF test mocks pdfmake, which is exactly how this shipped broken
 * the first time. The layout was written with weighted-star widths ("* 0.5",
 * "* 1.2"), which pdfmake 0.3 removed, and pdfmake does not reject a width it
 * does not recognise: it keeps the string, the arithmetic that positions a
 * column concatenates instead of subtracting, and the whole document aborts
 * with "unsupported number: NaN". A mock cannot see that. Neither can
 * TypeScript, because every one of those widths is a perfectly valid string.
 *
 * So these tests run the real engine and insist on PDF bytes coming back.
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

const COMPANY = { name: 'Kallazhagar Industries', gstin: '33CAOPR9297L1ZL', address: 'Coimbatore' }

const dcDocument = (overrides: Partial<DcDocument> = {}): DcDocument => ({
  id: 'dc-1', organization_id: 'org-1', dc_type: 'inward', dc_number: 'KI/IN/2026-27/0001',
  dc_date: '2026-10-01', financial_year: '2026-27', status: 'issued',
  party_id: 'p-1', party_type: 'customer', party_name: 'Customer A', party_gstin: '33AAAAA0001BCZ1',
  party_phone: null, party_email: null, party_address: '1 Test Street', party_state_code: null,
  party_pincode: null, party_contact_person: null, party_ship_to: null,
  receipt_type: 'customer_owned', movement_type: null, delivery_purpose: null, purpose: 'Machining',
  external_dc_number: 'EXT-9', external_dc_date: null, external_notes: null,
  purchase_order_no: null, job_work_order_id: null, production_order_id: null, reference_inward_dc_id: null,
  customer_order_reference: null, delivery_schedule_reference: null,
  mode_of_transport: 'Company Vehicle', transporter_name: null, transporter_gstin: null,
  vehicle_number: 'TN 01 AB 1234', driver_name: null, driver_contact: null, lr_number: null,
  docket_number: null, eway_bill_number: null, package_count: null, package_type: null,
  gross_weight: null, net_weight: null,
  dispatch_at: null, expected_arrival_at: null, actual_arrival_at: null, expected_return_at: null,
  actual_delivery_at: null, receipt_date: null, receipt_time: null,
  received_by: 'Gatekeeper', prepared_by: null, authorized_by: null, receiver_name: null,
  proof_of_delivery_ref: null, unloading_remarks: null, dispatch_remarks: null,
  remarks: null, internal_remarks: null,
  version: 1, finalized_at: '2026-10-01T10:00:00Z', cancelled_at: null, cancel_reason: null,
  created_at: '2026-10-01T09:00:00Z',
  ...overrides,
})

const dcItem = (overrides: Partial<DcItem> = {}): DcItem => ({
  id: 'i-1', dc_id: 'dc-1', line_no: 1, product_id: null, part_number: 'KI-101',
  customer_part_number: null, description: 'Shaft', drawing_number: 'DWG-9', drawing_revision: 'B',
  customer_dc_number: null,
  batch_lot_no: 'LOT-A', heat_no: null, material_grade: null, unit: 'NOS',
  supply_source: 'customer_material',
  declared_qty: 1000, received_qty: 990, shortage_qty: 10, excess_qty: 0, damaged_qty: 0,
  inspection_required: true, inspected_qty: 990, accepted_qty: 960, rejected_qty: 20, rework_qty: 0,
  pending_inspection_qty: 10, inspection_status: 'partially_accepted', inspection_date: '2026-10-02',
  rejection_reason: 'Dimensional Out of Tolerance', inspection_report_no: 'IR-1', inspection_remarks: null,
  processing_operation: null, qty_sent: 0, expected_return_qty: null, returned_qty: 0,
  accepted_return_qty: 0, rejected_return_qty: 0, scrap_qty: 0, still_at_vendor_qty: null,
  ordered_qty: null, previously_dispatched_qty: 0, qty_dispatched: 0, qty_delivered: 0,
  source_inward_item_id: null, material_owner_id: null, production_order_id: null,
  storage_location: null, item_remarks: null,
  ...overrides,
})

/**
 * A result that would survive record_machining_result: the input reconciles
 * exactly (960 + 20 + 10 + 5 + 5 = 1000) and the units match, so the fixture is
 * a record the database could really hold rather than an impossible one.
 */
const machiningResult = (overrides: Partial<DcMachiningResult> = {}): DcMachiningResult => ({
  id: 'm-1', source_dc_id: 'dc-1', source_dc_item_id: null, party_id: 'p-1', material_owner_id: null,
  part_number: 'KI-101', operation: 'CNC Turning', operation_date: '2026-10-05',
  input_quantity: 1000, input_unit: 'NOS', accepted_output_quantity: 960, output_unit: 'NOS',
  machining_rejection_quantity: 20, rework_quantity: 10, scrap_quantity: 5, process_loss_quantity: 5,
  remaining_quantity: 0,
  unit_conversion: false, loss_reason: 'Handling', rejection_reason: 'Bore out of tolerance',
  inspection_report: 'IR-2', operator_name: 'Ravi', inspector_name: 'Sabari', corrective_action: null,
  remarks: null,
  ...overrides,
})

const bundle = (over: Partial<DcBundle> = {}): DcBundle => ({
  document: dcDocument(), items: [dcItem()], movements: [], inspections: [],
  machining_results: [], rejections: [], ...over,
})

/** Real PDF bytes, not merely a promise that did not reject. */
const isPdf = (output: unknown): boolean =>
  output instanceof Uint8Array
  && output.length > 1000
  && String.fromCharCode(...output.subarray(0, 5)) === '%PDF-'

describe('Delivery Challan PDF, rendered by the real pdfmake', () => {
  it('produces a PDF for every challan type', async () => {
    for (const dcType of ['inward', 'outward_customer', 'material_return'] as DcType[]) {
      const buffer = await pdfmake.createPdf(buildDcDefinition(
        bundle({ document: dcDocument({ dc_type: dcType }), items: [dcItem({ inspection_required: dcType === 'inward' })] }),
        COMPANY,
      )).getBuffer()
      expect(isPdf(buffer), `${dcType} did not render a PDF`).toBe(true)
    }
  })

  it('prints the signature on the last page only', () => {
    const def = buildDcDefinition(bundle(), COMPANY)
    expect(typeof def.footer, 'a challan now carries a footer for the signature').toBe('function')
    const footer = def.footer as ((currentPage: number, pageCount: number) => unknown)
    // Pages before the last draw no signatory block or disclaimer.
    expect(footer(1, 3)).toBe('')
    expect(footer(2, 3)).toBe('')
    // The final page carries the signatures and the disclaimer together.
    const last = JSON.stringify(footer(3, 3))
    expect(last, 'signature block is missing from the footer').toContain('Prepared by')
    expect(last, 'disclaimer is missing from the footer').toContain('material movement record')
  })

  it('reserves A4 margin space for the signature instead of the body', () => {
    const def = buildDcDefinition(bundle(), COMPANY)
    // The signature moved from content into the last-page footer; the bottom
    // margin grows to hold it while left, top and right stay as they were.
    const [left, top, right, bottom] = def.pageMargins as number[]
    expect(left).toBe(36)
    expect(top).toBe(32)
    expect(right).toBe(36)
    expect(bottom, 'bottom margin did not grow to fit the signature').toBeGreaterThanOrEqual(72)
  })

  it('produces a PDF for a challan with no lines, and for a cancelled one', async () => {
    const empty = await pdfmake.createPdf(buildDcDefinition(bundle({ items: [] }), COMPANY)).getBuffer()
    expect(isPdf(empty), 'a challan with no lines did not render').toBe(true)
    const cancelled = await pdfmake.createPdf(buildDcDefinition(
      bundle({ document: dcDocument({ status: 'cancelled', cancelled_at: '2026-10-05T00:00:00Z', cancel_reason: 'Customer postponed' }) }),
      COMPANY,
    )).getBuffer()
    expect(isPdf(cancelled), 'a cancelled challan did not render').toBe(true)
  })

  it('produces a PDF when the letterhead could not be loaded', async () => {
    // DcDetail falls back to a name-only company object when the read fails.
    const buffer = await pdfmake.createPdf(buildDcDefinition(bundle(), { name: 'Organization' })).getBuffer()
    expect(isPdf(buffer)).toBe(true)
  })

  it('produces a PDF when long lines force the table across pages', async () => {
    const items = Array.from({ length: 40 }, (_, index) =>
      dcItem({ id: `i-${index}`, line_no: index + 1, part_number: `PART-${index}` }))
    const buffer = await pdfmake.createPdf(buildDcDefinition(bundle({ items }), COMPANY)).getBuffer()
    expect(isPdf(buffer)).toBe(true)
  })
})

describe('Column widths the installed pdfmake can actually parse', () => {
  /**
   * pdfmake 0.3 accepts a fixed number, "auto", "*", "star" and a percentage.
   * Anything else is silently treated as a literal width, which is the trap.
   * Scanning the built definition names the offending width instead of letting
   * the failure surface as "unsupported number: NaN" three layers into pdfkit.
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
    visit(buildDcDefinition(bundle(), COMPANY).content)
    expect(unsupported).toEqual([])
  })

  it('never names a table style that does not exist', () => {
    // 'td num' as one string is the specific trap. pdfmake resolved it by looking
    // for a style literally called "td num", found none, and applied nothing -
    // no error, just a cell with no padding and no alignment.
    const known = new Set(Object.keys(buildDcDefinition(bundle(), COMPANY).styles ?? {}))
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
    visit(buildDcDefinition(bundle(), COMPANY).content)
    expect(unknown).toEqual([])
  })
})

/**
 * Every string pdfkit actually draws, with its baseline and horizontal extent.
 *
 * A mistyped style or a forgotten `alignment` is not a crash - it is a document
 * that looks wrong on paper and passes every other check. `style: 'td num'`
 * shipped exactly that way: pdfmake treats a string `style` as ONE name, so every
 * quantity silently lost `td`'s 3pt padding and `num`'s alignment, and each number
 * sat 3pt above the text beside it in the same row. Only reading where pdfkit
 * actually draws each run can see that.
 */
type Run = { text: string; baseline: number; left: number; right: number; centre: number }

/** Every string pdfkit actually draws, with the baseline and the centre of its run. */
async function draw(definition: TDocumentDefinitions): Promise<Run[]> {
  const seed = pdfmake.createPdf(
    { content: [{ text: 'seed' }], defaultStyle: { font: PDF_FONT_FAMILY, fontSize: 9 } } as TDocumentDefinitions,
  )
  // The pdfkit document exists only once the layout has rendered, so this seed
  // render is the only way to reach the prototype whose text() records output.
  const doc = await (await seed.getStream()) as {
    widthOfString(text: string, options: { fontSize: number; fontFamily: string }): number
  }
  type TextFn = (this: unknown, text: unknown, x: number, y: number, options: { fontSize?: number }) => unknown
  const proto = Object.getPrototypeOf(doc) as { text: TextFn }
  const original = proto.text
  const runs: Array<{ text: string; x: number; y: number; fontSize: number }> = []
  proto.text = function (this: unknown, text: unknown, x: number, y: number, options: { fontSize?: number }) {
    runs.push({
      text: Array.isArray(text) ? text.join('') : String(text),
      x, y, fontSize: options?.fontSize ?? 9,
    })
    return original.call(this, text, x, y, options)
  }
  try {
    await pdfmake.createPdf(definition).getBuffer()
  } finally {
    proto.text = original
  }
  return runs.filter(run => run.text.trim()).map(run => {
    const width = doc.widthOfString(run.text, { fontSize: run.fontSize, fontFamily: PDF_FONT_FAMILY })
    return {
      text: run.text,
      baseline: Math.round(run.y * 100) / 100,
      left: run.x,
      right: run.x + width,
      centre: run.x + width / 2,
    }
  })
}

const squash = (value: string) => value.replaceAll(' ', '')

/**
 * The whole document as one string, with all whitespace removed.
 *
 * pdfkit draws a wrapped label as consecutive runs - 'Mode of transport'
 * arrives as 'Mode', 'of', 'transport' - so a per-run comparison never matches
 * a label that wrapped, and a test asserting such a label is absent passes for
 * the wrong reason. Joining first is what makes "was this printed" a question
 * about the document rather than about the line breaking.
 */
const flat = async (definition: TDocumentDefinitions) =>
  squash((await draw(definition)).map(run => run.text).join(' '))

/**
 * The runs on one baseline, as a lookup by squashed text. 'Received' and '990'
 * each appear in both the item table and the inspection summary, so every lookup
 * has to be scoped to a row rather than to the whole document.
 */
const row = (runs: Run[], baseline: number) =>
  runs.filter(run => run.baseline === baseline)

/**
 * The centre of a heading, measured across every piece it wrapped onto.
 *
 * pdfkit draws a wrapped heading as consecutive runs - 'Part number' arrives as
 * 'Part ' then 'number' - so the pieces must be re-joined before the span means
 * anything. Matching the first word alone put the "Part number" comparison 12pt
 * out, which is a wrong measurement rather than a real defect.
 */
const centreOfLabel = (runs: Run[], label: string): number | null => {
  const target = squash(label)
  // Slide the window: a heading is a run of consecutive pieces, so every start
  // position has to be tried rather than only the first one.
  for (let start = 0; start < runs.length; start++) {
    let accumulated = ''
    let right = 0
    for (let index = start; index < runs.length; index++) {
      accumulated += squash(runs[index]!.text)
      right = Math.max(right, runs[index]!.right)
      if (accumulated === target) return (runs[start]!.left + right) / 2
      if (accumulated.length > target.length) break
    }
  }
  return null
}

/**
 * The item table's header row and the value row under it, located by the '#'
 * heading rather than by a hardcoded y, which would move with any layout change.
 */
const itemTable = async () => {
  const runs = await draw(buildDcDefinition(bundle(), COMPANY))
  const header = runs.find(run => squash(run.text) === '#')
  expect(header, 'no item table header row was drawn').toBeDefined()
  const valueRows = [...new Set(runs.map(run => run.baseline))]
    .filter(baseline => baseline > header!.baseline)
  // The received quantity locates the value row: the inspection summary repeats
  // '990' further down the page, and .find() takes the first (topmost) match,
  // which is the item table's row.
  const values = valueRows.find(baseline => row(runs, baseline).some(run => squash(run.text) === '990'))
  expect(values, 'no item table value row was drawn').toBeDefined()
  return { header: row(runs, header!.baseline), values: row(runs, values!) }
}

/**
 * Table alignment, measured from the rendered output rather than read off the
 * source.
 */
describe('Only what has been recorded reaches the paper', () => {
  it('prints no field that has no value', async () => {
    // A challan is a document that gets filed and signed. A row reading
    // "Transporter —" tells the reader nothing and reads as a gap in the
    // record, so anything unrecorded is left off the page rather than printed
    // as a dash.
    const drawn = await flat(buildDcDefinition(
      bundle({
        document: dcDocument({
          purchase_order_no: null, mode_of_transport: null, transporter_name: null,
          vehicle_number: null, lr_number: null, docket_number: null, eway_bill_number: null,
        }),
        items: [dcItem({ inspection_required: false })],
      }),
      COMPANY,
    ))
    for (const label of ['Purchase order', 'Mode of transport', 'Transporter', 'Vehicle number', 'LR / docket', 'E-way bill']) {
      expect(drawn, `"${label}" was drawn with nothing beside it`).not.toContain(squash(label))
    }
  })

  it('still prints a field that does have a value', async () => {
    // The rule is not "print less": a recorded value must reach the paper.
    const drawn = await flat(buildDcDefinition(
      bundle({
        document: dcDocument({
          purchase_order_no: 'PO-7781', mode_of_transport: 'Company Vehicle',
          transporter_name: 'Kallazhagar Transport', eway_bill_number: 'EWB-5512',
        }),
      }),
      COMPANY,
    ))
    expect(drawn, 'the purchase order was dropped').toContain('PO-7781')
    expect(drawn, 'the transporter was dropped').toContain('KallazhagarTransport')
    expect(drawn, 'the e-way bill was dropped').toContain('EWB-5512')
    expect(drawn, 'the transport label was dropped along with its value').toContain(squash('E-way bill'))
  })

  it('prints no field from the four that were removed', async () => {
    // External DC no., External DC date, Customer order and Delivery schedule
    // were removed from the document. They must not come back through the
    // fallback path for an old challan.
    const drawn = await flat(buildDcDefinition(
      bundle({
        document: dcDocument({
          external_dc_number: 'EXT-9', external_dc_date: '2026-09-30',
          customer_order_reference: 'PO-REF-1', delivery_schedule_reference: 'SCHED-9',
        }),
        items: [dcItem({ customer_dc_number: 'CUST-4411' })],
      }),
      COMPANY,
    ))
    for (const label of ['External DC no.', 'External DC date', 'Customer order', 'Delivery schedule']) {
      expect(drawn, `"${label}" was drawn`).not.toContain(squash(label))
    }
    // The customer's own number is still on the paper, under the label that
    // replaced the two it used to share.
    expect(drawn, 'the customer DC label is missing').toContain(squash('Customer DC no.'))
    expect(drawn, 'the customer DC number is missing').toContain('CUST-4411')
  })

  it('keeps an old challan\'s header number when its lines carry none', async () => {
    // Challans created before the per-line number (0026) hold theirs in the
    // header column, and nothing writes to that column any more. Without this
    // fallback they would print with no customer number at all - the record
    // would lose the one identifier the customer quotes on the phone.
    const drawn = await flat(buildDcDefinition(
      bundle({
        document: dcDocument({ external_dc_number: 'EXT-9001', external_dc_date: null }),
        items: [dcItem({ customer_dc_number: null })],
      }),
      COMPANY,
    ))
    expect(drawn, 'the customer DC label is missing').toContain(squash('Customer DC no.'))
    expect(drawn, 'the old header number was lost').toContain('EXT-9001')
  })

  it('names every customer DC number a challan draws from, on an outward challan', async () => {
    const drawn = await flat(buildDcDefinition(
      bundle({
        document: dcDocument({ dc_type: 'outward_customer', external_dc_number: null }),
        customer_dc_numbers: ['CUST-4411', 'CUST-4412'],
        items: [dcItem({
          customer_dc_number: null,
          source_inward_item_id: 'si-1',
          source_inward_customer_dc_number: 'CUST-4411',
        })],
      }),
      COMPANY,
    ))
    expect(drawn, 'the outward challan does not say which customer DCs it answers')
      .toContain(squash('Against customer DC'))
    expect(drawn).toContain('CUST-4411')
    expect(drawn).toContain('CUST-4412')
  })
})

describe('Table values sit directly under their own heading', () => {
  it('omits the Batch / lot column and every batch number', async () => {
    const table = await itemTable()
    const headings = table.header.map(run => squash(run.text))
    expect(headings.some(text => text.startsWith('Batch/lot')), 'Batch / lot was drawn').toBe(false)
    expect(table.values.some(run => run.text.startsWith('LOT-')), 'a batch number was drawn').toBe(false)
  })

  it('draws the receipt quantities the document carries, with their values', async () => {
    // The party signing the document sees what arrived and what was accepted:
    // declared, received, accepted and rejected, against the unit on the row.
    // Shortage and the inspection state stay off the paper - they remain on
    // the screen and in the receipt summary below the item table.
    const table = await itemTable()
    const headings = table.header.map(run => squash(run.text))
    for (const label of ['Declared', 'Received', 'Accepted', 'Rejected', 'Unit']) {
      expect(headings, `${label} heading was not drawn`).toContain(label)
    }
    expect(headings, 'a Shortage heading was drawn').not.toContain('Shortage')
    const values = table.values.map(run => squash(run.text))
    for (const value of ['1000', '990', '960', '20', 'NOS']) {
      expect(values, `${value} was not drawn in the item row`).toContain(value)
    }
  })

  it('leaves an outward challan on its single quantity column', async () => {
    const runs = await draw(buildDcDefinition(
      bundle({ document: dcDocument({ dc_type: 'outward_customer' }) }), COMPANY,
    ))
    const header = runs.find(run => squash(run.text) === '#')
    expect(header, 'no item table header row was drawn').toBeDefined()
    const headings = row(runs, header!.baseline).map(run => squash(run.text))
    expect(headings, 'no Quantity heading was drawn').toContain('Quantity')
    expect(headings, 'a receipt-only heading was drawn').not.toContain('Shortage')
    expect(headings, 'a receipt-only heading was drawn').not.toContain('Declared')
  })

  it('centres the received quantity under its own heading', async () => {
    const table = await itemTable()
    const heading = centreOfLabel(table.header, 'Received')
    expect(heading, 'no Received heading was drawn').not.toBeNull()
    const value = table.values.find(run => squash(run.text) === '990')
    expect(value, 'no received quantity was drawn').not.toBeNull()
    expect(Math.abs(value!.centre - heading!), 'received quantity is off-centre').toBeLessThan(3)
  })

  it('prints the prepared-by name above its signature line, and the label under it', async () => {
    const runs = await draw(buildDcDefinition(
      bundle({ document: dcDocument({ prepared_by: 'Sabari', authorized_by: 'Plant Manager' }) }),
      COMPANY,
    ))

    // A wrapped label arrives as consecutive pieces - 'Prepared ' then 'by' - so
    // it is located by sliding a window over the runs, as centreOfLabel does.
    const labelSpans = (label: string): [number, number][] => {
      const target = squash(label)
      const spans: [number, number][] = []
      for (let start = 0; start < runs.length; start++) {
        let accumulated = ''
        for (let index = start; index < runs.length; index++) {
          accumulated += squash(runs[index]!.text)
          if (accumulated === target) { spans.push([start, index]); break }
          if (accumulated.length > target.length) break
        }
      }
      return spans
    }

    const spans = labelSpans('Prepared by')
    expect(spans.length, 'Prepared by must appear exactly once').toBe(1)
    const labelBaseline = runs[spans[0]![1]]!.baseline

    const value = runs.find(run => squash(run.text) === 'Sabari')
    expect(value, 'the prepared-by name was not drawn').toBeDefined()
    // Baselines grow downward: the name, then the rule, then the label.
    expect(value!.baseline, 'the name must sit above its label').toBeLessThan(labelBaseline)
    const line = runs.find(run => run.text.includes('____')
      && run.baseline > value!.baseline && run.baseline < labelBaseline)
    expect(line, 'the signature line must sit between the name and its label').toBeDefined()
  })

  it('centres the part number under its own heading', async () => {
    const table = await itemTable()
    const heading = centreOfLabel(table.header, 'Part number')
    expect(heading, 'no Part number heading was drawn').not.toBeNull()
    const value = table.values.find(run => squash(run.text) === 'KI-101')
    expect(value, 'no part number was drawn').not.toBeNull()
    expect(Math.abs(value!.centre - heading!), 'part number is off-centre').toBeLessThan(5)
  })

  it('draws every value in the item table on one baseline', async () => {
    // This is what the broken 'td num' style did: the numbers lost their 3pt
    // vertical padding and rose 3pt above the text beside them.
    const runs = await draw(buildDcDefinition(bundle(), COMPANY))
    const header = runs.find(run => squash(run.text) === '#')
    const baselines = [...new Set(runs.map(run => run.baseline))]
    const below = baselines.filter(baseline => baseline > header!.baseline)
    const firstValueRow = below.find(baseline => row(runs, baseline).some(run => squash(run.text) === 'KI-101'))
    const drawn = runs.filter(run => run.baseline === firstValueRow)

    expect(drawn.length, 'the item table value row is missing').toBeGreaterThan(4)
    // Everything in a table row shares one baseline. Nothing may float above it.
    const strays = runs.filter(run =>
      run.baseline !== firstValueRow
      && run.baseline > header!.baseline && run.baseline < firstValueRow! + 1)
    expect(strays.map(run => run.text), 'values sit on a different baseline to the rest of the row').toEqual([])
  })

  it('draws every inspection quantity on one baseline', async () => {
    const runs = await draw(buildDcDefinition(bundle(), COMPANY))
    const heading = runs.find(run => run.text.startsWith('Pending'))
    expect(heading, 'no inspection summary was drawn').toBeDefined()
    const baselines = [...new Set(runs.map(run => run.baseline))].filter(baseline => baseline > heading!.baseline)
    const rowBaseline = baselines.find(baseline => row(runs, baseline).some(run => squash(run.text) === 'KI-101'))
    expect(rowBaseline, 'no inspection value row was drawn').toBeDefined()

    const quantities = ['990', '960', '20']
    const drawn = quantities.map(value => runs.find(run => squash(run.text) === value && run.baseline === rowBaseline))
    expect(drawn.filter(Boolean).length, 'not every inspection quantity was drawn').toBe(3)
    const strays = runs.filter(run =>
      run.baseline !== rowBaseline && run.baseline > heading!.baseline && run.baseline < rowBaseline! + 1)
    expect(strays.map(run => run.text), 'inspection quantities sit on a different baseline').toEqual([])
  })
})
/**
 * The machining and processing result, which only a customer outward challan
 * carries.
 *
 * The gate is the thing worth pinning down: `loadDcBundle` fetches results by
 * `source_dc_id`, so an inward or outward-self challan can legitimately hold
 * rows, and a rule of "whenever there are results" would put a processing
 * reconciliation table on an inward receipt - a document whose whole point is
 * that receiving is not processing.
 *
 * Every assertion reads the painted output, never the definition, and none of
 * them matches a single pdfkit run: a centred heading or cell arrives as one
 * run per word ('MACHINING', 'AND', ... and '1000', 'NOS'), so each is measured
 * by squashing the words of a whole row back together. A table that is built but
 * never painted fails here exactly as it should.
 */
describe('Machining and processing results on the customer outward challan', () => {
  const outward = (over: Partial<DcBundle> = {}) => bundle({
    document: dcDocument({ dc_type: 'outward_customer' }),
    machining_results: [machiningResult()],
    ...over,
  })

  /** The first run of a heading pdfkit split across several runs, or -1. */
  const indexOfLabel = (runs: Run[], label: string): number => {
    const target = squash(label)
    for (let start = 0; start < runs.length; start++) {
      let accumulated = ''
      for (let index = start; index < runs.length; index++) {
        accumulated += squash(runs[index]!.text)
        if (accumulated === target) return start
        if (accumulated.length > target.length) break
      }
    }
    return -1
  }

  /** The section heading, as drawn. */
  const heading = (runs: Run[]): Run | undefined => {
    const start = indexOfLabel(runs, 'MACHINING AND PROCESSING RESULTS')
    return start < 0 ? undefined : runs[start]!
  }

  /** One baseline's worth of runs as a single squashed string. */
  const rowText = (runs: Run[], baseline: number): string =>
    squash(row(runs, baseline).map(run => run.text).join(''))

  /** The result row under the heading, located by its operation. */
  const resultRow = (runs: Run[]): { baseline: number; text: string } | null => {
    const top = heading(runs)
    if (!top) return null
    const baseline = [...new Set(runs.map(run => run.baseline))]
      .filter(candidate => candidate > top.baseline)
      .find(candidate => rowText(runs, candidate).includes('CNCTurning'))
    return baseline === undefined ? null : { baseline, text: rowText(runs, baseline) }
  }

  it('draws every result column the operator recorded', async () => {
    const runs = await draw(buildDcDefinition(outward(), COMPANY))
    expect(heading(runs), 'no machining results heading was drawn').toBeDefined()

    const drawn = resultRow(runs)
    expect(drawn, 'no machining value row was drawn').not.toBeNull()
    for (const expected of ['KI-101', 'CNCTurning', '1000NOS', '960NOS', '20', '10', '5']) {
      expect(drawn!.text, `${expected} was not drawn`).toContain(expected)
    }
  })

  it('renders a PDF, with and without a company letterhead', async () => {
    for (const company of [COMPANY, { name: 'Organization' }]) {
      const buffer = await pdfmake.createPdf(buildDcDefinition(outward(), company)).getBuffer()
      expect(isPdf(buffer)).toBe(true)
    }
  })

  it('draws the six outcome columns on one baseline', async () => {
    // The defect this guards is the broken `'td num'` style: the numbers lose
    // `td`'s vertical padding and rise above the text beside them, which is
    // invisible to every other check in this file. The window starts at the
    // table's own last column heading, so its headings are not counted as
    // strays - that is where the inspection baseline test starts too.
    const runs = await draw(buildDcDefinition(outward(), COMPANY))
    expect(heading(runs), 'no machining results heading was drawn').toBeDefined()
    const lastColumn = runs.find(run => squash(run.text) === 'Loss')
    expect(lastColumn, 'the machining column headings were not drawn').toBeDefined()
    const drawn = resultRow(runs)
    expect(drawn, 'no machining value row was drawn').not.toBeNull()

    const strays = runs.filter(run =>
      run.baseline !== drawn!.baseline && run.baseline > lastColumn!.baseline && run.baseline < drawn!.baseline + 1)
    expect(strays.map(run => run.text), 'machining quantities sit on a different baseline').toEqual([])
  })

  it('prints each unit beside its own quantity when a process converts units', async () => {
    // A conversion reconciles nothing, so input and output units differ on the
    // same row. One shared "Unit" heading would claim they are the same.
    const runs = await draw(buildDcDefinition(outward({
      machining_results: [machiningResult({
        input_quantity: 250, input_unit: 'KG', accepted_output_quantity: 180, output_unit: 'NOS',
        machining_rejection_quantity: 0, rework_quantity: 0, scrap_quantity: 0, process_loss_quantity: 0,
        unit_conversion: true,
      })],
    }), COMPANY))
    const drawn = resultRow(runs)
    expect(drawn, 'no machining value row was drawn').not.toBeNull()
    expect(drawn!.text, 'the input quantity did not carry its own unit').toContain('250KG')
    expect(drawn!.text, 'the accepted output did not carry its own unit').toContain('180NOS')
  })

  it('leaves the table off a challan with no results recorded', async () => {
    const serialised = JSON.stringify(buildDcDefinition(bundle({
      document: dcDocument({ dc_type: 'outward_customer' }),
    }), COMPANY).content)
    expect(serialised).not.toContain('MACHINING AND PROCESSING RESULTS')
  })

  it('leaves the table off a challan that is not a customer delivery', async () => {
    // The rows are in the bundle either way; only the type gate keeps a
    // processing reconciliation off an inward receipt or a job-work dispatch.
    for (const dcType of ['inward', 'material_return'] as DcType[]) {
      const serialised = JSON.stringify(buildDcDefinition(outward({
        document: dcDocument({ dc_type: dcType }),
      }), COMPANY).content)
      expect(serialised, `${dcType} printed a machining results table`).not.toContain('MACHINING AND PROCESSING RESULTS')
    }
  })

  it('prints one row per recorded result', async () => {
    const runs = await draw(buildDcDefinition(outward({
      machining_results: [
        machiningResult({ part_number: 'KI-201' }),
        machiningResult({ id: 'm-2', part_number: 'KI-202', operation: 'Grinding', input_quantity: 40,
          accepted_output_quantity: 40, machining_rejection_quantity: 0, rework_quantity: 0,
          scrap_quantity: 0, process_loss_quantity: 0 }),
      ],
    }), COMPANY))
    const drawn = runs.map(run => squash(run.text))
    expect(drawn, 'the first result was not drawn').toContain('KI-201')
    expect(drawn, 'the second result was not drawn').toContain('KI-202')
    expect(drawn.filter(text => text === 'MACHINING').length, 'the heading was drawn more than once').toBe(1)
  })
})