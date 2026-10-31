/**
 * CSV parsing and template generation for bill import.
 *
 * The parser is written out rather than taken from a library because bill
 * spreadsheets in a manufacturing office are full of the things naive parsers
 * break on: a customer name containing a comma, a note field containing a quoted
 * "inches" measurement, and a final line with no trailing newline.
 */

/** One parsed row: the header names mapped to values. */
export type CsvRow = Record<string, string>

export type CsvParseResult = {
  rows: CsvRow[]
  headers: string[]
  /** Human-readable problems, so the user is told rather than silently getting fewer rows. */
  problems: string[]
}

/**
 * Splits one CSV line, honouring quoted fields and doubled quotes.
 *
 * Exported for testing; `parseCsv` is what callers should use.
 */
export function splitCsvLine(line: string, delimiter = ','): string[] {
  const cells: string[] = []
  let current = ''
  let quoted = false

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!

    if (quoted) {
      if (char === '"') {
        // "" inside a quoted field is a literal quote.
        if (line[index + 1] === '"') { current += '"'; index += 1 } else { quoted = false }
      } else {
        current += char
      }
      continue
    }

    if (char === '"' && current.trim() === '') { quoted = true; current = ''; continue }
    if (char === delimiter) { cells.push(current.trim()); current = ''; continue }
    current += char
  }
  cells.push(current.trim())
  return cells
}

/**
 * Normalises a header cell to a comparable key.
 *
 * "Bill No." and "bill_number" and "BILL NO " all mean the same column, and a
 * spreadsheet exported from Excel is full of capitalisation and spaces that were
 * never meant to be data.
 */
export function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** Aliases accepted for each logical field, normalised the same way. */
const FIELD_ALIASES: Record<string, string[]> = {
  bill_number: ['bill_number', 'bill_no', 'billno', 'invoice_no', 'invoice_number', 'bill'],
  bill_date: ['bill_date', 'date', 'invoice_date'],
  customer_name: ['customer_name', 'customer', 'party', 'party_name'],
  customer_gstin: ['customer_gstin', 'gstin', 'customer_gst_no', 'gst_no'],
  customer_phone: ['customer_phone', 'phone', 'mobile'],
  part_number: ['part_number', 'part_no', 'item_code', 'product_code', 'code'],
  description: ['description', 'product_name', 'item_name', 'item', 'product', 'particulars', 'narrative'],
  hsn_code: ['hsn_code', 'hsn', 'hsn_sac'],
  quantity: ['quantity', 'qty', 'nos', 'qty_nos'],
  unit: ['unit', 'uom'],
  rate: ['rate', 'price', 'unit_price', 'unit_rate'],
  discount: ['discount', 'disc', 'discount_amount'],
  gst_rate: ['gst_rate', 'gst', 'gst_percent', 'tax_rate'],
  cess_rate: ['cess_rate', 'cess', 'cess_percent'],
  payment_status: ['payment_status', 'status'],
  // What has been received against the bill. A partly paid bill needs it:
  // without a figure, "partial" is a word rather than an amount.
  amount_received: ['amount_received', 'paid_amount', 'amount_paid', 'received_amount'],
  notes: ['notes', 'note', 'remarks', 'remark'],
}

/** The columns the template offers, in order. */
export const TEMPLATE_HEADERS = [
  'bill_number', 'bill_date', 'customer_name', 'customer_gstin', 'customer_phone',
  'part_number', 'description', 'hsn_code', 'quantity', 'unit', 'rate',
  'discount', 'gst_rate', 'cess_rate', 'notes',
]

/** Maps a spreadsheet header to a logical field name, or null if unrecognised. */
export function resolveHeader(header: string): string | null {
  const key = normalizeHeader(header)
  if (key === '') return null
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    if (aliases.includes(key)) return field
  }
  return null
}

/**
 * Rejects anything that is not a plausible text file before it is parsed.
 *
 * The check counts actual control characters. An earlier version counted commas
 * as non-printable, which made a short but perfectly valid file like
 * "alpha,beta\n1,2" fail the test - a comma-heavy header row trips a length
 * ratio that was meant to detect binary data.
 */
export function looksLikeCsv(text: string): boolean {
  if (text.includes('\u0000')) return false
  const head = text.slice(0, 4000)
  if (head.length === 0) return true
  // Tab, carriage return and newline are the only control characters legitimate
  // in a CSV; anything else below U+0020 means this is binary.
  let control = 0
  for (const char of head) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) control += 1
  }
  return control / head.length < 0.01
}

/**
 * Parses CSV text into rows keyed by logical field name.
 *
 * Empty lines and rows whose every cell is blank are dropped, so a spreadsheet
 * with ten blank rows between records does not produce ten empty bills.
 */
export function parseCsv(text: string): CsvParseResult {
  const problems: string[] = []

  if (!looksLikeCsv(text)) {
    return { rows: [], headers: [], problems: ['This does not look like a CSV file. If it is an Excel workbook, save it as CSV first.'] }
  }

  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const lines = clean.split('\n')
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()

  if (lines.length === 0) return { rows: [], headers: [], problems: ['The file is empty.'] }

  const headerCells = splitCsvLine(lines[0]!)
  const headers = headerCells.map(resolveHeader)
  const known = headers.filter(Boolean).length

  if (known === 0) {
    return {
      rows: [], headers: [],
      problems: [`None of the columns were recognised. Expected at least ${['bill_number', 'bill_date', 'customer_name', 'part_number'].join(', ')}.`],
    }
  }
  if (known < headerCells.length) {
    const unknown = headerCells.filter((_, index) => headers[index] === null && headerCells[index] !== '')
    problems.push(`Ignored unrecognised column(s): ${unknown.join(', ')}`)
  }

  const rows: CsvRow[] = []
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!
    if (line.trim() === '') continue
    const cells = splitCsvLine(line)
    const row: CsvRow = {}
    headers.forEach((field, position) => {
      if (!field) return
      row[field] = (cells[position] ?? '').trim()
    })
    if (Object.values(row).every(value => value === '')) continue
    row.__line = String(index + 1)
    rows.push(row)
  }

  if (rows.length === 0) problems.push('The file has a header row but no data rows.')
  return { rows, headers: headerCells, problems }
}

/** A ready-to-fill template, including one worked example row. */
export function buildTemplateCsv(): string {
  const example = [
    'KI/26-27/0001', '2026-04-15', 'Auto Components Pvt Ltd', '33AABCA1234F1Z5', '9876543210',
    'SHAFT-001',
    // The description deliberately contains commas, so it has to be quoted. This
    // row is the first thing anyone copies, so it should demonstrate the quoting
    // rule as well as the columns - an unquoted one silently shifts every value
    // after it and produces a bill with a 220mm quantity and a 145% tax rate.
    '"CNC turned shaft, 40Cr, 220mm"', '722890', '100', 'NOS', '145.50',
    '50', '18', '', 'Sample row - delete before importing',
  ]
  return [TEMPLATE_HEADERS.join(','), example.join(',')].join('\r\n')
}

/** Turns a row's text into a finite number, or null when it is not one. */
export function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null
  const text = value.trim()
  if (text === '') return null
  // Indian sheets export "1,23,456.78"; a bare comma split would also have
  // produced a stray empty cell, so strip grouping commas and the rupee sign.
  const cleaned = text.replace(/[₹,\s]/g, '')
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

/** Reads an Indian financial year "2026-27" into its two parts. */
export function parseFinancialYear(value: string): { start: number; end: number } | null {
  const match = value.trim().match(/^(\d{4})\s*[-/]\s*(\d{2}|\d{4})$/)
  if (!match) return null
  const start = Number(match[1])
  const tail = Number(match[2])
  const end = tail > 99 ? tail : 2000 + tail
  return end === start + 1 ? { start, end } : null
}
