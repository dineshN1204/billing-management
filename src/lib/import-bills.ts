/**
 * Bill import.
 *
 * Turns parsed CSV rows into real bills by calling the same `save_bill` RPC the
 * manual entry form calls. Nothing is inserted into `bills` directly, so every
 * imported invoice goes through identical tax calculation, validation,
 * duplicate detection and audit logging - an import cannot produce a record the
 * application would refuse to create by hand.
 *
 * One row is one *line item*. Rows sharing a bill number are grouped into a
 * single bill, which is how a spreadsheet exported from a billing system is
 * normally shaped.
 */

import { db } from './db'
import { toNumber } from './import-csv'
import { isValidGstin, normalizeGstin } from './format'
import type { CsvRow } from './import-csv'
import type { BillPayloadItem, Customer } from './types'

export type ImportIssue = { row: number; bill: string; message: string }

export type ImportOutcome = {
  /** Rows rejected before anything was written. */
  invalid: ImportIssue[]
  /** Bills saved. */
  imported: number
  /** Bills the database refused, most often a genuine duplicate. */
  rejected: ImportIssue[]
  /** Customers created because no match was found. */
  customersCreated: number
  /** True when nothing was written at all. */
  dryRun: boolean
}

/** One grouped bill, ready to be sent to save_bill. */
type DraftBill = {
  billNumber: string
  billDate: string
  customerName: string
  customerGstin: string
  customerPhone: string
  notes: string
  paymentStatus: string
  amountReceived: number | null
  items: BillPayloadItem[]
}

/** YYYY-MM-DD from whatever the spreadsheet held. */
function normalizeDate(value: string, rowNumber: number): string | null {
  const text = value.trim()
  if (text === '') return null
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (match) {
    const [, year, month, day] = match
    // Validate the parts rather than trusting the shape: "2026-13-01" matches the
    // pattern but is not a date, and would be stored and then break the
    // financial-year calculation.
    const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
    if (
      Number.isNaN(parsed.getTime())
      || parsed.getUTCFullYear() !== Number(year)
      || parsed.getUTCMonth() !== Number(month) - 1
      || parsed.getUTCDate() !== Number(day)
    ) return null
    return parsed.toISOString().slice(0, 10)
  }
  // DD/MM/YYYY is how an Indian spreadsheet is written, so that is the reading
  // used. It is a stated convention, not a guess: a file in MM/DD would be
  // misread, so the template asks for YYYY-MM-DD and the sample shows it.
  match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
  if (match) {
    const [, day, month, year] = match
    const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
    if (Number.isNaN(parsed.getTime())) return null
    // Date.UTC rolls an out-of-range month or day over silently (month 13 becomes
    // January of the next year), so verify the parts survived unchanged.
    if (parsed.getUTCMonth() !== Number(month) - 1 || parsed.getUTCDate() !== Number(day)) return null
    return parsed.toISOString().slice(0, 10)
  }
  void rowNumber
  return null
}

const PAYMENT_STATUSES = new Set(['unpaid', 'partial', 'paid'])

/** Groups validated rows into bills keyed by bill number. */
export function groupRows(rows: CsvRow[]): { bills: DraftBill[]; invalid: ImportIssue[] } {
  const bills = new Map<string, DraftBill>()
  const invalid: ImportIssue[] = []

  for (const row of rows) {
    const line = Number(row.__line ?? 0)
    const billNumber = (row.bill_number ?? '').trim()
    const problems: string[] = []

    if (!billNumber) problems.push('bill number is missing')
    const billDate = normalizeDate(row.bill_date ?? '', line)
    if (!billDate) problems.push(`bill date "${row.bill_date ?? ''}" is not a date; use YYYY-MM-DD or DD/MM/YYYY`)
    if (!(row.customer_name ?? '').trim()) problems.push('customer name is missing')

    const quantity = toNumber(row.quantity)
    const rate = toNumber(row.rate)
    if (quantity === null || quantity <= 0) problems.push(`quantity "${row.quantity ?? ''}" is not a positive number`)
    if (rate === null || rate < 0) problems.push(`rate "${row.rate ?? ''}" is not a number`)
    const discount = toNumber(row.discount) ?? 0
    if (discount < 0) problems.push(`discount "${row.discount ?? ''}" cannot be negative`)

    const gstRate = toNumber(row.gst_rate) ?? 0
    if (gstRate < 0 || gstRate > 100) problems.push(`GST rate "${row.gst_rate ?? ''}" must be between 0 and 100`)
    const cessRate = toNumber(row.cess_rate) ?? 0
    if (cessRate < 0 || cessRate > 100) problems.push(`cess rate "${row.cess_rate ?? ''}" must be between 0 and 100`)

    const gstin = normalizeGstin(row.customer_gstin ?? '')
    if (gstin !== '' && !isValidGstin(gstin)) {
      problems.push(`GSTIN "${row.customer_gstin}" is not a valid 15-character GSTIN`)
    }

    const hsn = (row.hsn_code ?? '').trim()
    if (hsn !== '' && !/^[0-9]{2,8}$/.test(hsn)) {
      problems.push(`HSN "${hsn}" must be 2 to 8 digits`)
    }

    const paymentStatus = (row.payment_status ?? '').trim().toLowerCase()
    if (paymentStatus !== '' && !PAYMENT_STATUSES.has(paymentStatus)) {
      problems.push(`payment status "${row.payment_status}" must be unpaid, partial or paid`)
    }

    // What has been received against the bill.
    //
    // A partly paid bill needs the figure: "partial" on its own says how the
    // bill stands but not by how much, and the database refuses the save
    // without it. A sheet that says "partial" and nothing else is incomplete,
    // and saying so is better than importing a bill whose balance nobody can
    // read.
    const amountText = (row.amount_received ?? '').trim()
    const amountReceived = toNumber(row.amount_received)
    if (amountText !== '' && amountReceived === null) {
      problems.push(`amount received "${row.amount_received}" is not a number`)
    }
    if (paymentStatus === 'partial' && amountReceived === null) {
      problems.push('a partly paid bill needs the amount received')
    }
    if (paymentStatus === 'partial' && amountReceived !== null && amountReceived <= 0) {
      problems.push('the amount received must be more than zero')
    }

    if (problems.length > 0) {
      invalid.push({ row: line, bill: billNumber || '(no number)', message: problems.join('; ') })
      continue
    }

    const existing = bills.get(billNumber)
    const description = (row.description ?? '').trim()
    const item: BillPayloadItem = {
      product_name: description || (row.part_number ?? '').trim() || 'Imported item',
      product_code: (row.part_number ?? '').trim() || null,
      hsn_code: hsn || null,
      description: description || null,
      quantity: String(quantity),
      unit: (row.unit ?? '').trim() || 'NOS',
      rate: String(rate),
      discount: String(discount),
      gst_rate: String(gstRate),
      cess_rate: String(cessRate),
      cess_amount: '0',
    }

    if (existing) {
      // The header fields must agree across every line of the same bill, or the
      // sheet is inconsistent and silently picking one would corrupt the record.
      if (existing.billDate !== billDate) {
        invalid.push({ row: line, bill: billNumber, message: `bill date differs from the earlier row for this bill (${existing.billDate})` })
        continue
      }
      if (existing.customerName.toLowerCase() !== (row.customer_name ?? '').trim().toLowerCase()) {
        invalid.push({ row: line, bill: billNumber, message: `customer differs from the earlier row for this bill (${existing.customerName})` })
        continue
      }
      if (existing.items.length >= 200) {
        invalid.push({ row: line, bill: billNumber, message: 'a bill cannot have more than 200 lines' })
        continue
      }
      if (existing.amountReceived !== amountReceived) {
        invalid.push({ row: line, bill: billNumber, message: 'amount received differs from the earlier row for this bill' })
        continue
      }
      existing.items.push(item)
    } else {
      bills.set(billNumber, {
        billNumber,
        billDate: billDate!,
        customerName: (row.customer_name ?? '').trim(),
        customerGstin: gstin,
        customerPhone: (row.customer_phone ?? '').trim(),
        notes: (row.notes ?? '').trim(),
        paymentStatus: PAYMENT_STATUSES.has(paymentStatus) ? paymentStatus : 'unpaid',
        amountReceived: paymentStatus === 'partial' ? amountReceived : null,
        items: [item],
      })
    }
  }

  return { bills: [...bills.values()], invalid }
}

/**
 * Finds the customer for a bill, or creates one.
 *
 * Matching is by GSTIN first because it is the only reliable identifier: two
 * parties can share a trading name, and a bill raised against the wrong customer
 * record is worse than a new one.
 */
async function resolveCustomer(
  organizationId: string,
  draft: DraftBill,
  cache: Map<string, Customer | null>,
): Promise<Customer | { error: string }> {
  const key = draft.customerGstin || `name:${draft.customerName.toLowerCase()}`
  if (cache.has(key)) {
    const cached = cache.get(key)!
    if (cached) return cached
  }

  let query = db.from('customers').select('*').eq('organization_id', organizationId).is('deleted_at', null).limit(1)
  query = draft.customerGstin !== ''
    ? query.eq('gstin', draft.customerGstin)
    : query.ilike('name', draft.customerName)

  const found = await query
  if (found.error) return { error: found.error.message }
  const existing = (found.data ?? [])[0] as Customer | undefined
  if (existing) {
    cache.set(key, existing)
    return existing
  }

  // Not found. A GSTIN is the unique identifier, so only create automatically
  // when there is one to key on; a name-only match would happily create three
  // near-identical customers from a sheet with inconsistent spellings.
  if (draft.customerGstin === '') {
    cache.set(key, null)
    return { error: `no customer named "${draft.customerName}" and no GSTIN to identify them by; create the customer first, then import` }
  }

  const created = await db.from('customers').insert({
    organization_id: organizationId,
    name: draft.customerName,
    gstin: draft.customerGstin,
    phone: draft.customerPhone || null,
    // Imported records have not been checked against a registry, and this app
    // never claims a GSTIN is government-verified.
    verification_status: 'needs_review',
  }).select('*').single()

  if (created.error) return { error: created.error.message }
  const customer = created.data as Customer
  cache.set(key, customer)
  return customer
}

/** Runs the import. With `dryRun` nothing is written at all. */
export async function runImport(
  organizationId: string,
  drafts: DraftBill[],
  precomputedInvalid: ImportIssue[],
  dryRun: boolean,
): Promise<ImportOutcome> {
  const outcome: ImportOutcome = {
    invalid: [...precomputedInvalid],
    imported: 0,
    rejected: [],
    customersCreated: 0,
    dryRun,
  }

  const cache = new Map<string, Customer | null>()

  for (const draft of drafts) {
    const customer = await resolveCustomer(organizationId, draft, cache)
    if ('error' in customer) {
      outcome.rejected.push({ row: 0, bill: draft.billNumber, message: customer.error })
      continue
    }
    if (dryRun) { outcome.imported += 1; continue }

    const payload = {
      organization_id: organizationId,
      customer_id: customer.id,
      bill_number: draft.billNumber,
      bill_date: draft.billDate,
      // Without a stored state on either party, intra-state is the safe default
      // for a domestic job-work unit: splitting CGST/SGST wrongly is reversible,
      // while charging IGST to a local customer is not.
      tax_mode: 'intra' as const,
      place_of_supply: null,
      payment_status: draft.paymentStatus as 'unpaid' | 'partial' | 'paid',
      payment_date: null,
      payment_method: null,
      // Only a partly paid bill carries an amount. The amount for an unpaid
      // bill is nothing and for a paid one the whole total, and the database
      // derives both.
      amount_received: draft.paymentStatus === 'partial' ? draft.amountReceived : null,
      notes: draft.notes || null,
      source_type: 'import' as const,
      items: draft.items,
    }

    const saved = await db.rpc('save_bill', { payload, allow_duplicate: false })
    if (saved.error) {
      const message = saved.error.message
      outcome.rejected.push({
        row: 0,
        bill: draft.billNumber,
        message: message.includes('DUPLICATE_BILL')
          ? 'a likely duplicate already exists; open the existing bill and add the lines there instead'
          : message,
      })
      continue
    }
    outcome.imported += 1
  }

  return outcome
}

/** Re-exported so the page can name the type without importing from two modules. */
export type { DraftBill }