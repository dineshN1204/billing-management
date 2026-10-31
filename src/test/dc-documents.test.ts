import { beforeEach, describe, expect, it, vi } from 'vitest'
import { friendlyError } from '../lib/format'
import { DC_TYPE_LABEL, DC_TYPE_TITLE, INSPECTION_STATUS_LABEL, draftFromItem, emptyItem } from '../lib/dc-types'
import { buildDcDefinition, downloadDcPdf } from '../lib/dc-pdf'
import type { DcBundle, DcDocument, DcItem, DcMachiningResult } from '../lib/dc-types'

/**
 * The document model is shared by the on-screen A4 layout, the printer and the
 * PDF, so testing it here covers PDF generation without needing a browser.
 */

/**
 * pdfmake ships a webpack UMD bundle, so the namespace a bundler hands back holds
 * the real pdfMake instance under `default` and exposes no named exports at all.
 * `@types/pdfmake` declares named exports anyway, which is why this went wrong
 * unnoticed: typecheck stayed green while the browser threw
 * "pdfmake.addVirtualFileSystem is not a function". These mocks reproduce the real
 * runtime shape exactly, so the unwrap in downloadDcPdf is covered by a test
 * rather than by a comment.
 *
 * downloadDcPdf resolves its fonts through registerPdfFonts, which writes the
 * vendored WOFF files into pdfmake's virtual file system and then declares the
 * DMSans family with addFonts - so the mock exposes both entry points.
 */
const pdf = vi.hoisted(() => {
  const download = vi.fn(async () => {})
  const addVirtualFileSystem = vi.fn()
  const addFonts = vi.fn()
  return {
    addVirtualFileSystem,
    addFonts,
    createPdf: vi.fn(() => ({ download })),
    download,
  }
})

vi.mock('pdfmake', () => ({
  default: {
    addVirtualFileSystem: pdf.addVirtualFileSystem,
    addFonts: pdf.addFonts,
    createPdf: pdf.createPdf,
  },
}))

const document = (overrides: Partial<DcDocument> = {}): DcDocument => ({
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

const item = (overrides: Partial<DcItem> = {}): DcItem => ({
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
  document: document(), items: [item()], movements: [], inspections: [], machining_results: [], rejections: [], ...over,
})

const company = { name: 'Kallazhagar Industries', gstin: '33CAOPR9297L1ZL', address: 'Coimbatore' }

describe('Challan document generation', () => {
  it('produces an A4 document for an inward challan', () => {
    const definition = buildDcDefinition(bundle(), company)
    expect(definition.pageSize).toBe('A4')
    expect(Array.isArray(definition.content)).toBe(true)
  })

  it('titles each document type distinctly, so a challan is never mistaken for an invoice', () => {
    expect(DC_TYPE_TITLE.inward).toBe('INWARD DELIVERY CHALLAN')
    expect(DC_TYPE_TITLE.outward_customer).toBe('OUTWARD DELIVERY CHALLAN')
    expect(DC_TYPE_TITLE.material_return).toBe('MATERIAL RETURN CHALLAN')
    for (const title of Object.values(DC_TYPE_TITLE)) {
      expect(title).not.toMatch(/invoice/i)
    }
  })

  it('states that the document is not a tax invoice', () => {
    const def = buildDcDefinition(bundle(), company)
    const footer = JSON.stringify((def.footer as (p: number, pc: number) => unknown)(1, 1))
    expect(footer).toContain('not a tax invoice')
  })

  it('shows the inspection outcome on an inward challan', () => {
    const serialised = JSON.stringify(buildDcDefinition(bundle(), company).content)
    expect(serialised).toContain('RECEIPT AND INSPECTION SUMMARY')
    expect(serialised).toContain('960')
    expect(serialised).toContain('20')
  })

  it('keeps the external challan number separate from our own reference', () => {
    const serialised = JSON.stringify(buildDcDefinition(bundle(), company).content)
    expect(serialised).toContain('KI/IN/2026-27/0001')
    expect(serialised).toContain('EXT-9')
  })

  it('prints the GSTIN when the party has one and omits it when not', () => {
    expect(JSON.stringify(buildDcDefinition(bundle(), company).content)).toContain('33AAAAA0001BCZ1')
    const withoutGstin = bundle({ document: document({ party_gstin: null }) })
    const serialised = JSON.stringify(buildDcDefinition(withoutGstin, company).content)
    expect(serialised).not.toContain('GSTIN: 33AAAAA')
  })

  it('omits the inspection summary on an outward challan', () => {
    const outward = bundle({
      document: document({ dc_type: 'outward_customer', delivery_purpose: 'finished_goods' }),
      items: [item({ inspection_required: false })],
    })
    expect(JSON.stringify(buildDcDefinition(outward, company).content)).not.toContain('RECEIPT AND INSPECTION SUMMARY')
  })

  it('carries the machining and processing result on a customer outward challan', () => {
    // The counterpart to the test above: receiving is not processing, so the two
    // summaries are mutually exclusive rather than one being a superset.
    const outward = bundle({
      document: document({ dc_type: 'outward_customer' }),
      items: [item({ inspection_required: false })],
      machining_results: [machiningResult()],
    })
    const serialised = JSON.stringify(buildDcDefinition(outward, company).content)
    expect(serialised).toContain('MACHINING AND PROCESSING RESULTS')
    for (const heading of ['Quantity', 'Finished', 'Rejected', 'Rework', 'Scrap', 'Loss', 'Remaining']) {
      expect(serialised, `${heading} was not printed`).toContain(heading)
    }
    expect(serialised).toContain('CNC Turning')
    // The unit rides with its own quantity rather than in a shared column.
    expect(serialised).toContain('1000 NOS')
    expect(serialised).toContain('960 NOS')
    expect(serialised).not.toContain('RECEIPT AND INSPECTION SUMMARY')
  })

  it('leaves the machining summary off a challan with no results recorded', () => {
    const outward = bundle({ document: document({ dc_type: 'outward_customer' }) })
    expect(JSON.stringify(buildDcDefinition(outward, company).content))
      .not.toContain('MACHINING AND PROCESSING RESULTS')
  })

  it('leaves out the fields the challan form no longer captures', () => {
    const serialised = JSON.stringify(buildDcDefinition(bundle(), company).content)
    expect(serialised).not.toContain('Batch / lot')
    expect(serialised).not.toContain('Expected arrival')
  })

  it('prints the receipt quantities on the document', () => {
    // The party signs for what arrived and what was accepted. Shortage and the
    // inspection state are not mandatory on the paper, so they stay on the
    // screen and in the receipt summary below the item table.
    const serialised = JSON.stringify(buildDcDefinition(bundle(), company).content)
    for (const heading of ['Declared', 'Received', 'Accepted', 'Rejected']) {
      expect(serialised, `${heading} was not printed`).toContain(heading)
    }
    // The declared quantity appears nowhere else on an inward challan.
    expect(serialised, 'the declared quantity was not printed').toContain('1000')
    // Neither does a shortage heading anywhere on the document.
    expect(serialised).not.toContain('Shortage')
  })

  it('keeps an outward challan on its single quantity column', () => {
    const outward = bundle({ document: document({ dc_type: 'outward_customer' }) })
    const serialised = JSON.stringify(buildDcDefinition(outward, company).content)
    expect(serialised).toContain('Quantity')
    expect(serialised).not.toContain('Declared')
    expect(serialised).not.toContain('Shortage')
    expect(serialised).not.toContain('Inspection')
  })

  it('prints prepared by and authorized by once, at the signature block only', () => {
    const def = buildDcDefinition(bundle(), company)
    const count = (body: string, needle: string) => body.split(needle).length - 1
    const inFooter = JSON.stringify((def.footer as (p: number, pc: number) => unknown)(1, 1))
    const inBody = JSON.stringify(def.content)
    // The three signature columns live once, in the footer.
    expect(count(inFooter, 'Prepared by'), 'transport details no longer repeat the signature').toBe(1)
    expect(count(inFooter, 'Authorized by')).toBe(1)
    expect(count(inFooter, 'Received by')).toBe(1)
    // And the body carries none of them.
    expect(inBody).not.toContain('Prepared by')
    expect(inBody).not.toContain('Dispatched')
    expect(inBody).not.toContain('Packages')
    expect(inBody).not.toContain('Proof of delivery')
  })

  it('marks a cancelled challan as cancelled', () => {
    const cancelled = bundle({ document: document({ status: 'cancelled', cancelled_at: '2026-10-05T00:00:00Z', cancel_reason: 'Customer postponed' }) })
    const serialised = JSON.stringify(buildDcDefinition(cancelled, company).content)
    expect(serialised).toContain('CANCELLED')
    expect(serialised).toContain('Customer postponed')
  })

  it('includes a prepared-by, authorized-by and receiver acknowledgment block', () => {
    const def = buildDcDefinition(bundle(), company)
    const serialised = JSON.stringify((def.footer as (p: number, pc: number) => unknown)(1, 1))
    expect(serialised).toContain('Prepared by')
    expect(serialised).toContain('Authorized by')
    expect(serialised).toContain('Received by (party)')
  })

  it('carries transport details onto the document', () => {
    const serialised = JSON.stringify(buildDcDefinition(bundle(), company).content)
    expect(serialised).toContain('Company Vehicle')
    expect(serialised).toContain('TN 01 AB 1234')
  })
})

describe('Item drafts', () => {
  it('starts blank with sensible defaults', () => {
    const draft = emptyItem()
    expect(draft.part_number).toBe('')
    expect(draft.unit).toBe('NOS')
    expect(draft.supply_source).toBe('customer_material')
  })

  it('round-trips a saved item back into an editable draft', () => {
    const draft = draftFromItem(item({ part_number: 'KI-999', customer_part_number: 'C-1' }))
    expect(draft.part_number).toBe('KI-999')
    expect(draft.customer_part_number).toBe('C-1')
    expect(draft.unit).toBe('NOS')
  })
})

describe('Labels', () => {
  it('names every document type for the navigation and forms', () => {
    expect(DC_TYPE_LABEL.inward).toBe('Inward DC')
    expect(DC_TYPE_LABEL.outward_customer).toBe('Outward DC')
    expect(DC_TYPE_LABEL.material_return).toBe('Material Return DC')
  })

  it('describes every inspection status a line can carry', () => {
    for (const status of ['not_required', 'pending', 'partially_inspected', 'accepted', 'partially_accepted', 'rejected', 'rework_required'] as const) {
      expect(INSPECTION_STATUS_LABEL[status]).toBeTruthy()
    }
  })
})

describe('Delivery Challan PDF download', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reaches pdfmake through the CommonJS default export', async () => {
    await downloadDcPdf(bundle(), company)
    // registerPdfFonts writes the DMSans WOFF files into the virtual file system
    // and then declares the DMSans family - both must happen on the instance the
    // download finally uses.
    expect(pdf.addVirtualFileSystem).toHaveBeenCalledOnce()
    expect(pdf.addFonts).toHaveBeenCalledWith({
      DMSans: {
        normal: 'DMSans-Regular.woff',
        bold: 'DMSans-Bold.woff',
        italics: 'DMSans-Regular.woff',
        bolditalics: 'DMSans-Bold.woff',
      },
    })
    expect(pdf.createPdf).toHaveBeenCalledOnce()
  })

  it('registers the fonts before building the document, so DMSans resolves', async () => {
    await downloadDcPdf(bundle(), company)
    expect(pdf.addVirtualFileSystem.mock.invocationCallOrder[0])
      .toBeLessThan(pdf.createPdf.mock.invocationCallOrder[0] as number)
    expect(pdf.addFonts.mock.invocationCallOrder[0])
      .toBeLessThan(pdf.createPdf.mock.invocationCallOrder[0] as number)
  })

  it('strips path separators out of the download name', async () => {
    await downloadDcPdf(bundle(), company)
    expect(pdf.download).toHaveBeenCalledWith('KI-IN-2026-27-0001.pdf')
  })
})

describe('Delivery Challan error messages', () => {
  it('shows the server\'s own wording for a balance refusal', () => {
    const message = friendlyError(new Error('PT409: QUANTITY_EXCEEDED: cannot dispatch 500 of KI-101: only 160 is eligible for this customer'))
    expect(message).toContain('160')
    expect(message).not.toContain('could not be completed')
  })

  it('maps the other domain failures to something actionable', () => {
    expect(friendlyError(new Error('PT409: MATERIAL_NOT_ELIGIBLE'))).toMatch(/accepted material/i)
    expect(friendlyError(new Error('PT409: RETURN_EXCEEDS_SENT'))).toMatch(/vendor/i)
    expect(friendlyError(new Error('PT409: MACHINING_NOT_RECONCILED'))).toMatch(/reconcile/i)
    expect(friendlyError(new Error('PT409: DOCUMENT_CANCELLED'))).toMatch(/cancelled/i)
    expect(friendlyError(new Error('PT403: FORBIDDEN: only administrators can cancel'))).toMatch(/permission/i)
  })
})