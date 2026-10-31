/**
 * PDF generation for delivery challans.
 *
 * pdfmake is loaded with a dynamic import so it lands in its own chunk and costs
 * nothing until someone actually asks for a PDF. The same document model also
 * drives the on-screen A4 layout, so print and download can never drift apart.
 *
 * A delivery challan is not a sales invoice. No GST amount is computed or
 * printed as though it were due; the GSTIN is shown when the party has one.
 *
 * Source note: this file is deliberately ASCII only. An em dash or a middle dot
 * written literally here has twice been re-encoded by a shell round trip and
 * corrupted the file, so the few places that need them use escapes instead.
 */
import type { Column, Content, ContentText, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces'
import { DC_TYPE_TITLE, type DcBundle, type DcItem, type DcMachiningResult } from './dc-types'
import { displayDate } from './format'
import { qty } from './dc-quantities'
import { PDF_FONT_FAMILY, registerPdfFonts } from './pdf-fonts'

type Company = {
  name: string
  gstin?: string | null
  address?: string | null
  phone?: string | null
  email?: string | null
  state_code?: string | null
}

const EM = '\u2014'
const DOT = '\u00b7'

const ink = '#1b2f38'
const muted = '#78928e'
const rule = '#d5dfe1'
const band = '#f2f6f5'

const text = (value: string | null | undefined, fallback: string = EM) =>
  (value && value.trim() ? value : fallback)

/**
 * Relative column weights, as the percentage widths pdfmake actually understands.
 *
 * The weighted-star syntax ("* 0.5", "* 1.2") was removed in pdfmake 0.3. Its
 * replacement, `isStarColumn`, recognises only null, undefined, "*" and "star",
 * so any other string is treated as a *fixed* width and kept verbatim. Nothing
 * complains: the layout then evaluates `availableWidth - "* 0.5"`, which
 * concatenates instead of subtracting, and a table column adds that string to a
 * coordinate, giving NaN. pdfkit refuses to write a NaN and aborts the whole
 * document with "unsupported number: NaN" - which is why every PDF on the site
 * failed while typecheck, lint and the mocked unit tests all stayed green.
 *
 * Percentages are the 0.3 equivalent and are kept as relative weights here so the
 * layout below still reads as proportions rather than as arbitrary literals. The
 * final column absorbs the rounding so a set of widths always totals exactly 100.
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
 * `Content`. Everything else in this file stays fully typed.
 */
const table = (widths: string[], body: TableCell[]): Content =>
  ({ table: { headerRows: 1, widths, body }, layout: 'lightHorizontalLines' }) as unknown as Content

/**
 * The three cells every table is built from: a heading, a quantity, and free text.
 *
 * Each heading and each value is centred, so a value always sits under the centre
 * of its own field name rather than drifting to one side of the column.
 *
 * The style is an array on purpose. `style: 'td num'` used to be a single string
 * here and applied **no style at all**: pdfmake resolves a string `style` as one
 * name rather than as space-separated names, so it looked up a style literally
 * called "td num", found nothing, and moved on without complaint. Those cells
 * lost `td`'s 3pt vertical padding - which is why every quantity sat 3pt above
 * the text beside it in the same row - and lost `num`'s alignment with it.
 *
 * Building headers and values through one helper is also what stops a column
 * drifting apart: a heading can end up drawn on one side of its column while the
 * value under it is drawn on the other, and nothing in pdfmake complains.
 */
const head = (text: string): ContentText => ({ text, style: 'th', alignment: 'center' })
const cell = (text: string | Content): ContentText => ({ text, style: ['td', 'num'], alignment: 'center' })
const plain = (text: string | Content): ContentText => ({ text, style: 'td', alignment: 'center' })

/**
 * One row per line.
 *
 * An inward challan is a receipt, and receiving is not accepting, so the line
 * carries the figures a party signing the document has to see: declared,
 * received, accepted and rejected. Shortage stays derivable from declared minus
 * received, and the inspection state stays on the screen and in the receipt
 * summary - neither is mandatory on the paper. An outward challan leaves with
 * the single quantity that walked out of the gate.
 */
function itemRows(items: DcItem[], kind: 'inward' | 'outward'): TableCell[] {
  const rows: TableCell[] = [
    kind === 'inward'
      ? [
        head('#'),
        head('Part number'),
        head('Customer DC'),
        head('Description'),
        head('Drawing'),
        head('Declared'),
        head('Received'),
        head('Accepted'),
        head('Rejected'),
        head('Unit'),
      ]
      : [
        head('#'),
        head('Part number'),
        head('Customer DC'),
        head('Description'),
        head('Drawing'),
        head('Quantity'),
        head('Unit'),
      ],
  ]

  for (const [index, item] of items.entries()) {
    const drawing = item.drawing_number
      ? `${item.drawing_number}${item.drawing_revision ? ` (Rev ${item.drawing_revision})` : ''}`
      : ''
    const lead = [
      plain(String(index + 1)),
      plain([
        item.part_number,
        item.customer_part_number ? { text: `Cust: ${item.customer_part_number}`, style: 'sub' } : '',
      ]),
      // Printed on an outward challan too, from the inward line the material
      // came from, so the customer can match the delivery against the challans
      // they actually sent.
      plain(item.customer_dc_number || item.source_inward_customer_dc_number || ''),
      plain(item.description ?? ''),
      plain(drawing),
    ]
    rows.push(kind === 'inward'
      ? [
        ...lead,
        cell(qty(item.declared_qty)),
        cell(qty(item.received_qty)),
        cell(qty(item.accepted_qty)),
        cell(qty(item.rejected_qty)),
        plain(item.unit),
      ]
      : [
        ...lead,
        cell(qty(item.qty_dispatched)),
        plain(item.unit),
      ])
  }
  return rows
}

function inspectionRows(items: DcItem[]): TableCell[] {
  const rows: TableCell[] = [
    [
      head('Part number'),
      head('Received'),
      head('Accepted'),
      head('Rejected'),
      head('Rework'),
      head('Pending inspection'),
    ],
  ]
  for (const item of items) {
    rows.push([
      plain(item.part_number),
      cell(qty(item.received_qty)),
      cell(qty(item.accepted_qty)),
      cell(qty(item.rejected_qty)),
      cell(qty(item.rework_qty)),
      cell(qty(item.pending_inspection_qty)),
    ])
  }
  return rows
}

/**
 * Machining / processing results, one row per recorded result.
 *
 * The quantity columns carry their own unit rather than sharing a single `Unit`
 * heading, because input and output units can legitimately differ: a result
 * recorded as a unit conversion reconciles nothing (the RPC skips the equation
 * and the table constraint skips it too), so one heading for both columns would
 * state a conversion that never happened. Rejection, rework, scrap and loss are
 * input-unit quantities, which is how the on-screen table already reads them.
 */
function machiningRows(results: DcMachiningResult[]): TableCell[] {
  const rows: TableCell[] = [
    [
      head('Line'),
      head('Part number'),
      head('Operation'),
      head('Quantity'),
      head('Finished'),
      head('Rejected'),
      head('Rework'),
      head('Scrap'),
      head('Loss'),
      head('Remaining'),
    ],
  ]

  for (const result of results) {
    rows.push([
      plain('—'),
      plain(result.part_number),
      plain(result.operation),
      cell(`${qty(result.input_quantity)} ${result.input_unit}`),
      cell(`${qty(result.accepted_output_quantity)} ${result.output_unit}`),
      cell(qty(result.machining_rejection_quantity)),
      cell(qty(result.rework_quantity)),
      cell(qty(result.scrap_quantity)),
      cell(qty(result.process_loss_quantity)),
      cell(qty(result.remaining_quantity)),
    ])
  }
  return rows
}

/**
 * One label-and-value line, omitted entirely when there is nothing to say.
 *
 * A challan is a document that gets filed and signed: a row reading
 * "Customer order —" tells the reader nothing and reads as a gap in the
 * record. Anything not recorded is left off the page rather than printed as a
 * dash.
 *
 * EM is the one exception, and it is deliberate - a caller that passes EM has
 * already checked for a value and wanted the dash, which is how the signature
 * block marks a line that is genuinely blank on the paper.
 */
function pair(label: string, value: string): Content | null {
  if (value === EM || value.trim() === '') return null
  return {
    margin: [0, 1, 0, 1],
    columns: [
      { text: label, style: 'label', width: '52%' },
      { text: value, style: 'value', width: '48%' },
    ],
  }
}

/**
 * Builds a stack of label-and-value lines, dropping the empty ones.
 *
 * `pair` returns null rather than an empty node so callers do not have to think
 * about it: a caller writing three optional fields should not also have to
 * filter, and forgetting to filter is exactly how a blank row reappears.
 */
function pairs(...rows: Array<[string, string]>): Content {
  const kept = rows
    .map(([label, value]) => pair(label, value))
    .filter((row): row is Content => row !== null)
  return kept.length === 1 ? kept[0]! : { stack: kept }
}

function transportBlock(bundle: DcBundle): Content {
  const d = bundle.document
  // Transport details hold only transport facts. Prepared by / authorized by /
  // received by live in the signature block, where each appears exactly once;
  // dispatched, packages, expected arrival and proof of delivery are gone.
  return {
    columns: [
      {
        width: '50%',
        stack: [
          pairs(
            ['Mode of transport', text(d.mode_of_transport)],
            ['Transporter', text(d.transporter_name)],
            ['Vehicle number', text(d.vehicle_number)],
          ),
        ],
      },
      {
        width: '50%',
        stack: [
          pairs(
            ['LR / docket', text(d.lr_number) === EM ? text(d.docket_number) : text(d.lr_number)],
            ['E-way bill', text(d.eway_bill_number)],
          ),
        ],
      },
    ],
  }
}

export function buildDcDefinition(bundle: DcBundle, company: Company): TDocumentDefinitions {
  const d = bundle.document
  const isInward = d.dc_type === 'inward'

  const header: Content = {
    margin: [0, 0, 0, 8],
    columns: [
      {
        width: '50%',
        stack: [
          { text: company.name, fontSize: 15, bold: true, color: ink },
          { text: company.address ?? '', style: 'body' },
          { text: company.phone ? `Phone: ${company.phone}` : '', style: 'body' },
          { text: company.email ? `Email: ${company.email}` : '', style: 'body' },
          { text: company.gstin ? `GSTIN: ${company.gstin}` : '', style: 'body' },
        ],
      },
      {
        width: '50%',
        alignment: 'right',
        stack: [
          { text: DC_TYPE_TITLE[d.dc_type], fontSize: 14, bold: true, color: ink, alignment: 'right' },
          { text: d.dc_number, fontSize: 13, bold: true, alignment: 'right', margin: [0, 2, 0, 0] },
          { text: `Date: ${displayDate(d.dc_date)}`, style: 'body', alignment: 'right' },
          { text: `Status: ${d.status.replaceAll('_', ' ')}`, style: 'body', alignment: 'right' },
          d.cancelled_at ? { text: 'CANCELLED', color: '#b3261e', bold: true, alignment: 'right' } : '',
        ],
      },
    ],
  }

  const partyHeading = isInward
    ? 'RECEIVED FROM'
    : d.dc_type === 'outward_customer' ? 'DELIVERED TO' : 'DISPATCHED TO'

  const party: Content = {
    margin: [0, 4, 0, 8],
    fillColor: band,
    stack: [
      {
        // 12pt of inner padding (16px on the print page, via the 4/3 ratio) so
        // RECEIVED FROM and the party details sit clear of the band edges, the
        // same as the highlighted block on the bill. The band itself stays full
        // width because this margin is applied to the inner stack, not the node
        // that carries fillColor.
        margin: [12, 9, 12, 9],
        stack: [
          { margin: [0, 0, 0, 4], text: partyHeading, style: 'label' },
          { text: d.party_name, fontSize: 12, bold: true, color: ink },
          d.party_gstin ? { text: `GSTIN: ${d.party_gstin}`, style: 'body' } : '',
          d.party_contact_person ? { text: `Contact: ${d.party_contact_person}`, style: 'body' } : '',
          d.party_phone ? { text: `Phone: ${d.party_phone}`, style: 'body' } : '',
          d.party_email ? { text: `Email: ${d.party_email}`, style: 'body' } : '',
          { text: d.party_ship_to ?? d.party_address ?? '', style: 'body' },
          d.party_pincode ? { text: `PIN: ${d.party_pincode}`, style: 'body' } : '',
        ],
      },
    ],
  }

  // Every customer DC number this document touches, from both directions: the
  // ones on its own lines, and the ones behind the lines it drew from. On an
  // outward challan this is what tells the customer which of their own
  // challans the delivery answers, and it is derived rather than typed so it
  // cannot disagree with the lines.
  //
  // Challans created before the per-line number existed (0026) carry theirs in
  // the header column instead, which nothing writes to any more. Falling back
  // to it here is what stops those old records printing with no customer number
  // on them at all - the data is not discarded, only no longer typed.
  const customerDcNumbers = bundle.customer_dc_numbers?.length
    ? bundle.customer_dc_numbers
    : [...new Set([
      ...bundle.items.flatMap(item =>
        [item.customer_dc_number, item.source_inward_customer_dc_number]
          .filter((value): value is string => Boolean(value && value.trim())),
      ),
      // Only when the lines themselves say nothing: an old inward challan
      // whose lines were never given a number of their own.
      ...(bundle.items.every(item => !item.customer_dc_number && !item.source_inward_customer_dc_number)
        ? [d.external_dc_number ?? '']
        : []),
    ].filter(value => value.trim() !== ''))].sort((a, b) => a.localeCompare(b))

  const references: Content = {
    margin: [0, 0, 0, 8],
    columns: [
      {
        width: '50%',
        stack: [
          pairs(
            [d.dc_type === 'inward' ? 'Customer DC no.' : 'Against customer DC', customerDcNumbers.join(', ')],
            ['Purchase order', text(d.purchase_order_no)],
          ),
        ],
      },
      {
        width: '50%',
        stack: [
          pairs(
            ['Financial year', d.financial_year],
            ['Purpose', text(d.purpose ?? d.movement_type ?? d.delivery_purpose)],
          ),
        ],
      },
    ],
  }

  const remarks: Content[] = []
  if (d.remarks) remarks.push({ text: 'Remarks', style: 'label', margin: [0, 6, 0, 2] }, { text: d.remarks, style: 'body' })
  if (d.unloading_remarks) remarks.push({ text: 'Unloading remarks', style: 'label', margin: [0, 6, 0, 2] }, { text: d.unloading_remarks, style: 'body' })
  if (d.cancel_reason) remarks.push({ text: 'Cancellation', style: 'label', margin: [0, 6, 0, 2] }, { text: d.cancel_reason, style: 'body' })

  // Inward challans state the inspection outcome explicitly, because receiving
  // and accepting are different events and a challan that blurs them is exactly
  // the record this module exists to prevent.
  const showInspection = isInward && bundle.items.some(item => item.inspection_required)
  const inspection: Content = showInspection
    ? {
      margin: [0, 8, 0, 0],
      stack: [
        { text: 'RECEIPT AND INSPECTION SUMMARY', style: 'label', margin: [0, 0, 0, 4] },
        table(share(1.2, 0.8, 0.8, 0.8, 0.8, 1.0), inspectionRows(bundle.items)),
      ],
    }
    : ''

  // Machining and processing results belong on the document itself: the customer
  // receives what survived the operation, not just the quantity that left the
  // gate. Only a customer outward challan carries them, which is the only type
  // the UI records a result against - an inward or outward-self challan with
  // stray rows is left as it was, rather than growing a table nobody filled in.
  const showMachining = d.dc_type === 'outward_customer' && bundle.machining_results.length > 0
  const machining: Content = showMachining
    ? {
      margin: [0, 8, 0, 0],
      stack: [
        { text: 'MACHINING AND PROCESSING RESULTS', style: 'label', margin: [0, 0, 0, 4] },
        table(share(0.6, 1.05, 1.05, 1.0, 0.95, 0.85, 0.75, 0.75, 0.75, 0.85), machiningRows(bundle.machining_results)),
      ],
    }
    : ''

  /**
   * One signature column: the holder's name sits above the line, the label under
   * it. The name area keeps a fixed height whether a value exists or not, so the
   * three lines stay level. The receiver's column deliberately never carries a
   * value - it is the party's own signature on the document.
   */
  const signatureColumn = (width: string, name: string | null | undefined, columnLabel: string): Column => ({
    width,
    stack: [
      { text: name && name.trim() ? name : '\u00a0', style: 'value', margin: [0, 0, 0, 6] },
      { text: '____________________________', style: 'sig' },
      { text: columnLabel, style: 'label', margin: [0, 4, 0, 0] },
    ],
  })

  const signatures: Content = {
    margin: [0, 24, 0, 0],
    columns: [
      signatureColumn('33%', d.prepared_by, 'Prepared by'),
      signatureColumn('34%', d.authorized_by, 'Authorized by'),
      signatureColumn('33%', null, isInward ? 'Received by (party)' : 'Receiver (party)'),
    ],
  }

  const delivery: Content | null =
    d.dc_type === 'outward_customer' && (d.proof_of_delivery_ref || d.receiver_name || d.actual_delivery_at)
      ? {
        margin: [0, 10, 0, 0],
        stack: [
          { text: 'DELIVERY', style: 'label', margin: [0, 0, 0, 4] },
          {
            columns: [
              {
                width: '50%',
                stack: [
                  pairs(
                    ['Dispatched at', d.dispatch_at ? new Date(d.dispatch_at).toLocaleString('en-IN') : ''],
                    ['Delivered at', d.actual_delivery_at ? new Date(d.actual_delivery_at).toLocaleString('en-IN') : ''],
                  ),
                ],
              },
              {
                width: '50%',
                stack: [
                  pairs(
                    ['Proof of delivery', text(d.proof_of_delivery_ref)],
                    ['Received by', text(d.receiver_name)],
                  ),
                ],
              },
            ],
          },
        ],
      }
      : null

  return {
    pageSize: 'A4',
    pageMargins: [36, 32, 36, 100],
    info: {
      title: `${d.dc_number} ${DOT} ${DC_TYPE_TITLE[d.dc_type]}`,
      author: company.name,
      subject: text(d.purpose ?? d.remarks, 'Material movement'),
    },
    defaultStyle: { font: PDF_FONT_FAMILY, fontSize: 9, color: ink },
    styles: {
      th: { fontSize: 8, fillColor: band, color: muted, margin: [0, 3, 0, 3] },
      td: { margin: [0, 3, 0, 3] },
      num: { alignment: 'right' },
      sub: { fontSize: 7, color: muted },
      label: { fontSize: 8, color: muted, bold: true },
      value: { fontSize: 9, color: ink },
      body: { fontSize: 9, color: ink },
      sig: { fontSize: 9, color: ink },
    },
    content: [
      header,
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 595 - 72, y2: 0, lineWidth: 1, lineColor: rule }] },
      party,
      references,
      table(
        // Ten columns on a receipt: the four quantities share the width evenly,
        // and the part, customer DC, description and drawing keep enough room for
        // a heading to stay on one line. The single-word quantity headers
        // ('Accepted' is the longest at nine characters) all share a weight, and
        // each one is given the bare minimum room a heading needs to avoid pdfmake
        // splitting it across lines.
        isInward
          ? share(0.4, 1.2, 1.3, 1.10, 0.95, 0.95, 0.95, 1.15, 0.95, 0.55)
          : share(0.4, 1.1, 1.3, 1.7, 1.0, 1.1, 0.6),
        itemRows(bundle.items, isInward ? 'inward' : 'outward'),
      ),
      inspection,
      machining,
      { margin: [0, 10, 0, 0], stack: [{ text: 'TRANSPORT DETAILS', style: 'label', margin: [0, 0, 0, 4] }, transportBlock(bundle)] },
      ...(delivery ? [delivery] : []),
      { margin: [0, 10, 0, 0], stack: remarks },
    ],
    /* The signature belongs on the document, so the footer draws it on the last
       page only; every preceding page stays content-only. The bottom margin
       above grows to hold it while the other three page margins stay the same. */
    footer: (currentPage: number, pageCount: number) =>
      currentPage === pageCount
        ? { margin: [0, 0, 0, 0], stack: [signatures, { margin: [0, 12, 0, 0], text: 'This is a material movement record, not a tax invoice.', style: 'sub' }] }
        : '',
  }
}

/**
 * What Vite actually hands back from a dynamic import.
 *
 * pdfmake ships a webpack UMD bundle, not ES modules, so its only export statement
 * is `module.exports = factory()`. The CommonJS interop has nothing static to read
 * a named export from, so the namespace it produces is `{ default: pdfMake }` and
 * nothing else - both in dev (esbuild pre-bundling) and in the Rollup build.
 * `@types/pdfmake` declares named exports, so TypeScript happily lets the call
 * through and the failure only shows up in the browser as
 * "pdfmake.addVirtualFileSystem is not a function".
 *
 * Reading `.default` is what puts the real pdfMake instance back in reach. The
 * `?? namespace` fallback keeps this correct if a future bundler is clever enough to
 * hoist the named exports out of the UMD wrapper after all.
 */
type PdfMake = typeof import('pdfmake')
type Interop<T> = T & { default?: T }

/**
 * Builds and downloads the PDF. pdfmake and its font file are fetched only when
 * this is called, so neither costs a byte until someone asks for a PDF.
 */
export async function downloadDcPdf(bundle: DcBundle, company: Company, filename?: string): Promise<void> {
  const pdfmakeModule = (await import('pdfmake')) as unknown as Interop<PdfMake>
  const pdfmake = (pdfmakeModule.default ?? pdfmakeModule) as PdfMake
  await registerPdfFonts(pdfmake)

  const document = buildDcDefinition(bundle, company)
  const safeName = (filename ?? bundle.document.dc_number).replace(/[\\/:*?"<>|]/g, '-')
  await pdfmake.createPdf(document).download(`${safeName}.pdf`)
}