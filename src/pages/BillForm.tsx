import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Plus, Trash2 } from 'lucide-react'
import { z } from 'zod'
import Decimal from 'decimal.js'
import { CustomerForm } from '../components/CustomerForm'
import { DocumentPicker } from '../components/DocumentPicker'
import { Button, Card, EmptyState, Field, Loading, PageTitle, SelectField, TextArea } from '../components/ui'
import { useAuth } from '../lib/auth'
import { billNumberForChallan, orderBySerial, pickNumberedChallan } from '../lib/bill-number'
import { calculateBill, paymentBalance } from '../lib/calculations'
import { uploadDocument, validateDocument } from '../lib/documents'
import { financialYear, displayDate, friendlyError, money, today } from '../lib/format'
import { db } from '../lib/db'
import { dcApi } from '../lib/dc-api'
import { settleAll } from '../lib/async'
import type { Bill, BillItem, BillPayload, BillPayloadItem, Customer, Product } from '../lib/types'

/** The shape of one entry in the RPC's DUPLICATE_BILL detail payload. */
type DuplicateBill = { bill_id: string; bill_number: string }

const itemSchema = z.object({ product_name: z.string().trim().min(1, 'Enter a product name'), quantity: z.coerce.number().positive().max(99999999), rate: z.coerce.number().min(0).max(999999999), discount: z.coerce.number().min(0), gst_rate: z.coerce.number().min(0).max(100), cess_rate: z.coerce.number().min(0).max(1000).optional(), cess_amount: z.coerce.number().min(0).optional() })
const itemEmpty = (): DraftItem => ({ product_name: '', unit: 'NOS', quantity: '1', rate: '0', discount: '0', gst_rate: '18', cess_rate: '0', cess_amount: '0' })

/**
 * One line of the bill, with the challan it came from.
 *
 * The challan is kept on the draft only - it is never sent to the database,
 * because the link between a bill and a challan is recorded in its own table.
 * It is here so that taking a challan off the selection can take its lines
 * with it, and so the operator can see which line came from where.
 */
type DraftItem = BillPayloadItem & { source_dc_id?: string }

/** One outward challan that can be invoiced. */
type ChallanOption = {
  dc_id: string
  dc_number: string
  dc_date: string
  dc_status: string
  reference_inward_number: string | null
  customer_dc_numbers: string[] | null
  line_count: number
  total_dispatched: number
}

type FormData = { bill_number: string; bill_date: string; customer_id: string; tax_mode: 'intra' | 'inter'; place_of_supply: string; payment_status: Bill['payment_status']; payment_date: string; payment_method: Bill['payment_method']; amount_received: string; notes: string; items: DraftItem[] }

/** Joins numbers without repeating any, so "500" and "500, 503" stay "500, 503". */
function joinNumbers(existing: string[], added: string[]): string[] {
  const out = new Set(existing.map(value => value.trim()).filter(Boolean))
  for (const value of added) { const trimmed = value.trim(); if (trimmed) out.add(trimmed) }
  return [...out]
}

export function BillForm({ source = 'manual', initial, ocrJobId, existingAttachment }: { source?: 'manual' | 'ocr'; initial?: Partial<FormData>; ocrJobId?: string; existingAttachment?: { file_path: string; file_name: string; mime_type: string; size_bytes: number } }) {
  const { id } = useParams()
  const [params] = useSearchParams()
  const { organization } = useAuth()
  const navigate = useNavigate()
  const [form, setForm] = useState<FormData>({ bill_number: initial?.bill_number || '', bill_date: initial?.bill_date ?? today(), customer_id: initial?.customer_id || params.get('customer') || '', tax_mode: initial?.tax_mode || 'intra', place_of_supply: initial?.place_of_supply || '', payment_status: initial?.payment_status || 'unpaid', payment_date: initial?.payment_date || '', payment_method: initial?.payment_method || null, amount_received: initial?.amount_received || '', notes: initial?.notes || '', items: initial?.items?.length ? initial.items : [itemEmpty()] })
  const [version, setVersion] = useState<number | null>(null)
  const [customers, setCustomers] = useState<Customer[]>([])
  const [customerQuery, setCustomerQuery] = useState('')
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null)
  const [creatingCustomer, setCreatingCustomer] = useState(false)
  const [productQuery, setProductQuery] = useState<{ index: number; value: string } | null>(null)
  const [productMatches, setProductMatches] = useState<Product[]>([])
  const [file, setFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(Boolean(id))
  const [error, setError] = useState('')
  const [duplicates, setDuplicates] = useState<Array<{ bill_id: string; bill_number: string }>>([])
  // The outward challans this bill is raised against. A bill can cover
  // several of them, and one challan can be billed across several bills, so
  // this is a list rather than a single reference.
  const [selectedDcs, setSelectedDcs] = useState<ChallanOption[]>([])
  // The challans the bill was already linked to when the form opened, so the
  // save can add the new ones and take the removed ones off without touching
  // the bills that share a challan.
  const [initialDcIds, setInitialDcIds] = useState<string[]>([])
  // The challans of this customer that can be invoiced.
  const [challanOptions, setChallanOptions] = useState<ChallanOption[]>([])
  const [optionsLoading, setOptionsLoading] = useState(false)
  // The customer DC number typed by hand. Null means "not typed", and the
  // field then shows the numbers carried by the selected challans.
  const [customerDcManual, setCustomerDcManual] = useState<string | null>(null)
  // Whether the operator has typed in the bill number themselves, or it came
  // from the paper the bill was scanned from. It decides whose number the
  // bill is saved with: one the operator chose, or the one the database
  // picks.
  const [numberChosen, setNumberChosen] = useState(Boolean(initial?.bill_number))
  const preview = useMemo(() => calculateBill(form.items, form.tax_mode), [form.items, form.tax_mode])

  /**
   * What the customer has paid, and what is left of the bill, as the operator
   * sees it while typing.
   *
   * The same arithmetic the database does on save, so the figure on the form
   * and the figure on the saved bill are the same figure. An unpaid bill has
   * received nothing, a paid bill has received everything, and a partly paid
   * bill has received what has been typed into it.
   */
  const { received, remaining } = paymentBalance(preview.total, form.payment_status, form.amount_received)

  /**
   * The customer DC numbers this bill shows.
   *
   * The numbers carried by the selected challans, unless the operator has
   * typed their own - in which case theirs is what the field shows, and the
   * invoice still prints both (the challans' numbers and the typed one).
   */
  const customerDcNumbers = useMemo(() => {
    let numbers: string[] = []
    for (const dc of selectedDcs) numbers = joinNumbers(numbers, dc.customer_dc_numbers ?? [])
    if (customerDcManual !== null) return customerDcManual
    return numbers.join(', ')
  }, [selectedDcs, customerDcManual])

  /**
   * The challan whose serial the bill number carries.
   */
  const numberedChallan = useMemo(() => pickNumberedChallan(selectedDcs), [selectedDcs])

  /**
   * The number a bill raised from a challan carries.
   *
   * The challan's serial, in the bill's own financial year: the outward
   * KI/OUT-C/2026-27/0020 is billed as 2026-27/0020, so a search for 0020
   * answers with the inward challan, the outward challan and the bill
   * together.
   *
   * A bill that is being edited keeps the number it was saved with. Renaming
   * an invoice that has gone out is not a decision this form makes.
   */
  const derivedNumber = useMemo(() => {
    if (id || !numberedChallan) return null
    return billNumberForChallan(numberedChallan.dc_number, financialYear(form.bill_date))
  }, [id, numberedChallan, form.bill_date])

  /** The number the field shows: the challan's, or the one in the form. */
  const shownNumber = derivedNumber ?? form.bill_number

  /** What the number is, and why it is what it is. */
  const numberHint = derivedNumber
    ? `Taken from challan ${numberedChallan?.dc_number}. A bill and the challan it pays for carry the same number.`
    : numberChosen
      ? 'Your own number. A number printed on a paper invoice is kept exactly as it is.'
      : `The next free bill number in ${financialYear(form.bill_date)}. Type another one if the bill was numbered by hand.`

  /**
   * The number a bill raised by hand is offered.
   *
   * A read, not a reservation: the form can be opened and closed again
   * without leaving a gap in the series. The number the bill is actually
   * saved with is the one the reservation returns, and that is the
   * authoritative one - the number shown here may have been taken by
   * somebody else in the meantime.
   *
   * It is fetched again when the bill date moves to another financial year,
   * because the series is per financial year.
   */
  useEffect(() => {
    if (!organization || id || derivedNumber || numberChosen || !form.bill_date) return
    let active = true
    void dcApi.nextBillNumber(organization.id, form.bill_date)
      .then(next => { if (active && next) setForm(old => ({ ...old, bill_number: next })) })
      // A failed read leaves the field empty, and the operator can type a
      // number. The database picks one at the save if they do not.
      .catch(() => { /* nothing to show, and nothing to undo */ })
    return () => { active = false }
  }, [organization, id, derivedNumber, numberChosen, form.bill_date])

  /**
   * Pre-fills the bill from an outward challan: /bills/new?dc=<id>.
   *
   * Part, quantity, unit and the customer come across. **Rates do not**, and
   * cannot: `dc_items` has no rate and no amount column, because a challan
   * records the movement of material rather than its price. Every rate on the
   * resulting bill is typed by the operator, which is why each line arrives at
   * 0 rather than at a guess.
   *
   * Only the lines that have actually been dispatched are brought over. A line
   * with nothing on the truck is nothing to invoice.
   *
   * The customer DC numbers come across too: they are the numbers of the
   * customer's own challans, taken from the inward lines the material was
   * drawn from, and they are the same numbers the inward and outward challans
   * show. They are shown in the field below and are not typed a second time.
   */
  useEffect(() => {
    const dcId = params.get('dc')
    if (!organization || !dcId || id) return
    // Editing an existing bill, or one opened without a challan: leave it alone.
    if (initial?.items?.length) return
    let active = true
    void dcApi.billableLines(organization.id, dcId)
      .then(lines => {
        if (!active || lines.length === 0) return
        const first = lines[0]!
        const option: ChallanOption = {
          dc_id: dcId,
          dc_number: first.dc_number,
          dc_date: first.dc_date,
          dc_status: 'issued',
          reference_inward_number: null,
          customer_dc_numbers: first.customer_dc_numbers,
          line_count: lines.length,
          total_dispatched: lines.reduce((sum, line) => sum + Number(line.qty_dispatched), 0),
        }
        setSelectedDcs([option])
        setForm(old => ({
          ...old,
          customer_id: old.customer_id || first.party_id,
          // Same-day so the bill and the delivery agree on their period.
          bill_date: old.bill_date || today(),
          notes: old.notes || `Delivery challan ${first.dc_number}${
            first.customer_dc_numbers?.length ? ` (customer ${first.customer_dc_numbers.join(', ')})` : ''
          }`,
          items: lines.map(line => ({
            ...itemEmpty(),
            product_name: line.part_number,
            description: line.description ?? '',
            quantity: String(line.qty_dispatched),
            unit: line.unit,
            rate: '0',
            source_dc_id: dcId,
          })),
        }))
      })
      .catch(cause => { if (active) setError(`${friendlyError(cause)} The bill was not filled from the challan.`) })
    return () => { active = false }
  }, [organization, params, id, initial])

  /**
   * The outward challans of this customer that can be invoiced.
   *
   * Only finalized challans with something dispatched on them: a draft has not
   * happened yet, and a line with nothing on the truck is nothing to invoice.
   */
  useEffect(() => {
    if (!organization || !form.customer_id) { setChallanOptions([]); return }
    let active = true
    setOptionsLoading(true)
    void dcApi.billableDocuments(organization.id, form.customer_id)
      .then(rows => { if (active) setChallanOptions(rows as ChallanOption[]) })
      // A failed read leaves the list empty. The bill can still be raised by
      // hand, so this is not worth an error on the page.
      .catch(() => { if (active) setChallanOptions([]) })
      .finally(() => { if (active) setOptionsLoading(false) })
    return () => { active = false }
  }, [organization, form.customer_id])

  useEffect(() => {
    if (!organization) return
    let active = true
    const query = customerQuery.trim()
    const timer = window.setTimeout(async () => {
      const request = db.from('customers').select('*').eq('organization_id', organization.id).is('deleted_at', null)
      const { data } = await (query ? request.ilike('name', `%${query.replace(/[\\%_]/g, '\\$&')}%`) : request).order('name').limit(8)
      if (active) setCustomers((data ?? []) as Customer[])
    }, 200)
    return () => { active = false; window.clearTimeout(timer) }
  }, [organization, customerQuery])
  useEffect(() => {
    if (!form.customer_id || !organization) { setSelectedCustomer(null); return }
    let active = true
    void db.from('customers').select('*').eq('id', form.customer_id).eq('organization_id', organization.id).single().then(({ data }) => { if (active) setSelectedCustomer(data as Customer | null) })
    return () => { active = false }
  }, [form.customer_id, organization])
  useEffect(() => {
    if (!productQuery || !organization || productQuery.value.length < 2) { setProductMatches([]); return }
    let active = true
    const timer = window.setTimeout(async () => {
      const { data } = await db.from('products').select('*').eq('organization_id', organization.id).is('deleted_at', null).ilike('name', `%${productQuery.value.replace(/[\\%_]/g, '\\$&')}%`).limit(6)
      if (active) setProductMatches((data ?? []) as Product[])
    }, 200)
    return () => { active = false; window.clearTimeout(timer) }
  }, [productQuery, organization])
  useEffect(() => {
    if (!id || !organization) return
    let active = true
    void settleAll([
      () => db.from('bills').select('*').eq('id', id).eq('organization_id', organization.id).is('deleted_at', null).single(),
      () => db.from('bill_items').select('*').eq('bill_id', id).eq('organization_id', organization.id).order('line_no'),
    ]).then(([billResult, itemsResult]) => {
      if (!active) return
      // settleAll never rejects, so this callback - and setLoading(false) - runs
      // even when a request failed outright.
      const billQuery = billResult.ok ? billResult.value : null
      const bill = (billQuery?.data ?? null) as Bill | null
      const items = (itemsResult.ok ? itemsResult.value.data ?? [] : []) as BillItem[]
      if (bill) {
        setForm({ bill_number: bill.bill_number, bill_date: bill.bill_date, customer_id: bill.customer_id, place_of_supply: bill.place_of_supply ?? '', tax_mode: bill.tax_mode, payment_status: bill.payment_status, payment_date: bill.payment_date ?? '', payment_method: bill.payment_method, amount_received: bill.paid_amount ? String(bill.paid_amount) : '', notes: bill.notes ?? '', items: items.map(item => ({ product_id: item.product_id, product_name: item.product_name, product_code: item.product_code, hsn_code: item.hsn_code, description: item.description, quantity: String(item.quantity), unit: item.unit, rate: String(item.rate), discount: String(item.discount), gst_rate: String(item.gst_rate), cess_rate: String(item.cess_rate), cess_amount: String(item.cess_amount) })) })
        setVersion(bill.version)
        // The customer DC number typed by hand, if there is one.
        if (bill.customer_dc_reference) setCustomerDcManual(bill.customer_dc_reference)
      } else {
        // Distinguish "could not be read" from "does not exist", so a dropped
        // connection no longer looks like a deleted record.
        const failure = !billResult.ok ? billResult.error : billQuery?.error ?? null
        setError(failure ? friendlyError(failure) : 'Bill not found or access denied.')
      }
      setLoading(false)
    })
    // The challans this bill already pays for. Read separately: a bill with
    // no linked challan is the ordinary case, so a failed read leaves the
    // section empty rather than raising on the form.
    void dcApi.billsForBill(organization.id, id)
      .then(rows => {
        if (!active) return
        const options: ChallanOption[] = rows.map(row => ({
          dc_id: row.dc_id,
          dc_number: row.dc_number,
          dc_date: row.dc_date,
          dc_status: row.dc_status,
          reference_inward_number: null,
          customer_dc_numbers: row.customer_dc_numbers,
          line_count: row.line_count,
          total_dispatched: row.total_dispatched,
        }))
        setSelectedDcs(options)
        setInitialDcIds(options.map(option => option.dc_id))
      })
      .catch(() => { if (active) { setSelectedDcs([]); setInitialDcIds([]) } })
    return () => { active = false }
  }, [id, organization])

  function updateItem(index: number, key: keyof BillPayloadItem, value: string) {
    setForm(old => ({ ...old, items: old.items.map((item, i) => i === index ? { ...item, [key]: value, ...(key === 'product_name' ? { product_id: null } : {}) } : item) }))
    if (key === 'product_name') setProductQuery({ index, value })
  }
  function selectProduct(index: number, product: Product) {
    setForm(old => ({ ...old, items: old.items.map((item, i) => i === index ? { ...item, product_id: product.id, product_name: product.name, product_code: product.product_code, hsn_code: product.hsn_code, description: product.description, unit: product.unit, rate: String(product.default_rate), gst_rate: String(product.gst_rate) } : item) }))
    setProductQuery(null)
  }
  /**
   * Adds an outward challan to the bill, or takes it off again.
   *
   * Adding one brings in its dispatched lines at rate 0, and the customer DC
   * numbers it carries are shown in the field below. Taking one off removes
   * the lines it brought in, so what is on the form and what the invoice says
   * stay the same thing.
   */
  async function toggleDc(option: ChallanOption) {
    if (!organization) return
    const selected = selectedDcs.some(dc => dc.dc_id === option.dc_id)
    if (selected) {
      setSelectedDcs(old => old.filter(dc => dc.dc_id !== option.dc_id))
      setForm(old => ({ ...old, items: old.items.filter(item => item.source_dc_id !== option.dc_id) }))
      return
    }
    setSelectedDcs(old => [...old, option])
    try {
      const lines = await dcApi.billableLines(organization.id, option.dc_id)
      setForm(old => ({
        ...old,
        items: [
          ...old.items,
          ...lines.map(line => ({
            ...itemEmpty(),
            product_name: line.part_number,
            description: line.description ?? '',
            quantity: String(line.qty_dispatched),
            unit: line.unit,
            rate: '0',
            source_dc_id: option.dc_id,
          })),
        ],
      }))
    } catch (cause) {
      // The challan stays selected, but without its lines: a silent removal
      // would be worse than a half-added challan.
      setError(`${friendlyError(cause)} The lines of challan ${option.dc_number} could not be added.`)
    }
  }

  /**
   * Brings the bill's links to the challans in the form up to date.
   *
   * `dc_link_bills` sets the whole set of bills for a challan, so a challan
   * that is already billed against somebody else's bill is re-sent with that
   * bill still attached. Removing a challan takes this bill off it and leaves
   * the other bills alone.
   *
   * The challans are linked in the order their serials run, so the challan
   * the bill's number names is the first one linked. The database refuses a
   * bill whose number names a challan the bill does not pay for, and a bill
   * covering two challans carries the first one's serial - so the challan
   * that serial names has to be among the links before the other is checked.
   */
  async function syncLinks(billId: string): Promise<string[]> {
    if (!organization) return []
    const ordered = orderBySerial(selectedDcs)
    const wanted = ordered.map(dc => dc.dc_id)
    const failed: string[] = []
    for (const dcId of wanted.filter(value => !initialDcIds.includes(value))) {
      try {
        const attached = await dcApi.linkedBills(organization.id, dcId)
        await dcApi.linkBills(organization.id, dcId, [...attached.map(bill => bill.bill_id), billId])
      } catch { failed.push(dcId) }
    }
    for (const dcId of initialDcIds.filter(value => !wanted.includes(value))) {
      try {
        const attached = await dcApi.linkedBills(organization.id, dcId)
        await dcApi.linkBills(organization.id, dcId, attached.map(bill => bill.bill_id).filter(value => value !== billId))
      } catch { failed.push(dcId) }
    }
    return failed
  }

  async function save(allowDuplicate = false) {
    if (!organization || busy) return
    setError(''); setDuplicates([])
    if (!form.customer_id) { setError('Choose an existing customer or create one.'); return }
    if (!form.bill_date || (id && !form.bill_number.trim())) { setError('Bill number and date are required.'); return }
    if (!form.items.length || form.items.length > 200) { setError('A bill needs 1 to 200 items.'); return }
    for (const [index, item] of form.items.entries()) {
      const parsed = itemSchema.safeParse(item)
      if (!parsed.success) { setError(`Item ${index + 1}: ${parsed.error.issues[0]?.message ?? 'Check the values.'}`); return }
      // Compare against the ROUNDED line value, the way the database does
      // (0009 rounds qty * rate to 2 places before the comparison). Using the raw
      // product rejected saves the server would happily accept.
      if (new Decimal(item.discount || 0).greaterThan(new Decimal(item.quantity || 0).mul(item.rate || 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP))) { setError(`Item ${index + 1}: discount exceeds line value.`); return }
      if (Number(item.cess_rate || 0) > 0 && Number(item.cess_amount || 0) > 0) { setError(`Item ${index + 1}: use either a cess rate or a fixed cess amount.`); return }
    }
    // A partly paid bill says how much has been received. Without it, "partial"
    // is a word rather than a figure, and everything that depends on the
    // balance - the outstanding report, the dashboard - has nothing to work
    // with. The database refuses the save without it as well; this is the
    // form saying so before the round trip.
    if (form.payment_status === 'partial') {
      const received = Number(form.amount_received)
      if (!Number.isFinite(received) || received <= 0) { setError('Type how much the customer has paid against this bill.'); return }
      if (received >= preview.total) { setError(`That is the whole bill (${money(preview.total)}). Set the payment status to paid instead.`); return }
    }
    setBusy(true)
    try {
      if (file) await validateDocument(file)
      // The number the bill is saved with.
      //
      // A bill raised from a challan carries that challan's serial, and the
      // number cannot be changed. A bill raised by hand carries the number
      // the operator typed, or the next free number in the financial year
      // when they have not typed one. The database makes that choice and
      // checks the number either way, so the number that comes back is the
      // one the bill is saved with.
      //
      // A bill that is being edited keeps the number it was saved with: an
      // invoice that has gone out is not renumbered by an edit.
      let billNumber = form.bill_number.trim()
      if (!id) {
        const wanted = derivedNumber ?? (numberChosen ? billNumber : null)
        const reserved = await dcApi.reserveBillNumber(
          organization.id,
          form.bill_date,
          wanted,
          selectedDcs.map(dc => dc.dc_id),
        )
        if (!reserved) throw new Error('The bill number could not be allocated.')
        billNumber = reserved
        setForm(old => ({ ...old, bill_number: billNumber }))
      }
      const payload: BillPayload = { organization_id: organization.id, customer_id: form.customer_id, bill_number: billNumber, bill_date: form.bill_date, tax_mode: form.tax_mode, place_of_supply: form.place_of_supply.trim() || null, payment_status: form.payment_status, payment_date: form.payment_date || null, payment_method: form.payment_method, amount_received: form.payment_status === 'partial' ? Number(form.amount_received) : null, notes: form.notes.trim() || null, items: form.items.map(item => ({ product_id: item.product_id, product_name: item.product_name.trim(), product_code: item.product_code, hsn_code: item.hsn_code, description: item.description, unit: item.unit, quantity: item.quantity, rate: item.rate, discount: item.discount, gst_rate: item.gst_rate, cess_rate: item.cess_rate, cess_amount: item.cess_amount })), ...(ocrJobId ? { ocr_job_id: ocrJobId } : {}), ...(existingAttachment ? { attachments: [existingAttachment] } : {}) }
      // Provenance and verification are established when a bill is created, not by
      // every later correction. Sending them on an update rewrote the source of an
      // OCR or imported bill to "manual", and promoted a needs_review or rejected
      // bill to "verified" in the name of whoever happened to edit it. The RPC
      // preserves both when the key is absent (0009 lines 226-231 and 233-240).
      if (!id) Object.assign(payload, {
        source_type: source,
        verification_status: source === 'ocr' ? 'verified' : 'verified',
      })
      const result = id ? await db.rpc('update_bill', { target_bill_id: id, payload, expected_version: version, allow_duplicate: allowDuplicate }) : await db.rpc('save_bill', { payload, allow_duplicate: allowDuplicate })
      if (result.error) {
        if (result.error.message.includes('DUPLICATE_BILL')) {
          // Even if the detail payload cannot be parsed the operator still needs a
          // way forward, so a fallback marker is recorded and the override button
          // is rendered. Previously an unparseable body left duplicates empty, the
          // button never appeared, and the bill could not be saved at all.
          let found: DuplicateBill[] = []
          try {
            const detail = JSON.parse(result.error.details || '{}') as { duplicates?: DuplicateBill[] }
            if (Array.isArray(detail.duplicates)) found = detail.duplicates
          } catch { /* details unavailable - fall through to the marker below */ }
          setDuplicates(found.length ? found : [{ bill_id: '', bill_number: 'a similar bill' }])
          setError('A likely duplicate was found. Review it before choosing Save anyway.')
          return
        }
        throw result.error
      }
      const saved = (result.data as { bill: Bill }).bill
      // Link the challans this bill pays for. The bill is already saved by this
      // point, so a failure here leaves a real bill with a missing link -
      // reported rather than swallowed, and still navigable.
      const failedLinks = await syncLinks(saved.id)
      if (failedLinks.length) {
        const names = selectedDcs.filter(dc => failedLinks.includes(dc.dc_id)).map(dc => dc.dc_number).join(', ')
        setError(`Bill ${saved.bill_number} was saved, but it could not be linked to challan ${names}. Open the challan and attach the bill there.`)
        navigate(`/bills/${saved.id}`)
        return
      }
      // The customer DC number typed by hand. A bill raised from a challan
      // takes the number from that challan, so nothing is written here unless
      // the operator typed one.
      if (customerDcManual !== null) {
        const written = await dcApi.setBillReferences(organization.id, saved.id, customerDcManual.trim() || null).then(() => true).catch(() => false)
        if (!written) {
          setError(`Bill ${saved.bill_number} was saved, but the customer DC number could not be written. Open the bill and try again.`)
          navigate(`/bills/${saved.id}`)
          return
        }
      }
      if (file) {
        try {
          const attachment = await uploadDocument(organization.id, file)
          const { error: attachError } = await db.from('bill_attachments').insert({
            organization_id: organization.id,
            bill_id: saved.id,
            file_path: attachment.object_path,
            file_name: file.name.slice(0, 255),
            mime_type: attachment.content_type,
            size_bytes: attachment.size_bytes,
          })
          if (attachError) throw attachError
        } catch {
          // Navigate even on failure. Staying on /bills/new with the form still
          // filled left "Save" live, and a second click created a second bill.
          setError(`Bill ${saved.bill_number} was saved, but the document could not be attached. Open the bill and retry the upload.`)
          navigate(`/bills/${saved.id}`)
          return
        }
      }
      navigate(`/bills/${saved.id}`)
    } catch (cause) { setError(friendlyError(cause)) } finally { setBusy(false) }
  }
  if (loading) return <Loading label="Loading bill..." />
  if (organization?.role === 'viewer') return <EmptyState title="Read-only access" description="You cannot change bills with this role." />
  return <><PageTitle eyebrow={source === 'ocr' ? 'OCR REVIEW' : 'BILL ENTRY'} title={id ? 'Edit bill' : source === 'ocr' ? 'Verify extracted bill' : 'New bill'} description={id ? 'Saving checks for edits made by another user.' : 'Enter historical bills accurately; missing GSTIN is allowed.'} /><div className="editor-layout"><div className="editor-main">
    <Card className="section-card"><div className="section-heading"><span className="section-number">01</span><div><h2>Customer</h2><p>Link this bill to an existing customer.</p></div></div><div className="field"><span>Search customers</span><input aria-label="Find customer" placeholder="Type company name..." value={customerQuery} onChange={e => setCustomerQuery(e.target.value)} /></div>{selectedCustomer && <div className="selected-entity"><strong>{selectedCustomer.name}</strong><small>{selectedCustomer.gstin || 'GSTIN needs verification'}</small><Button variant="ghost" onClick={() => setForm(old => ({ ...old, customer_id: '' }))}>Change</Button></div>}{!selectedCustomer && <div className="choices">{customers.map(customer => <button key={customer.id} type="button" onClick={() => { setForm(old => ({ ...old, customer_id: customer.id })); setCustomerQuery('') }}><strong>{customer.name}</strong><small>{customer.gstin || 'No GSTIN'}</small></button>)}</div>}<Button variant="secondary" type="button" onClick={() => setCreatingCustomer(true)}><Plus size={15} /> Create new customer</Button></Card>
    <Card className="section-card"><div className="section-heading"><span className="section-number">02</span><div><h2>Bill details</h2><p>Financial year is derived from the bill date.</p></div></div><div className="form-grid"><Field label="Bill number" required maxLength={64} readOnly={Boolean(derivedNumber)} hint={numberHint} value={shownNumber} onChange={e => { setNumberChosen(true); setForm(old => ({ ...old, bill_number: e.target.value })) }} /><Field label="Bill date" required type="date" value={form.bill_date} onChange={e => setForm(old => ({ ...old, bill_date: e.target.value }))} /><Field label="Financial year" value={financialYear(form.bill_date)} readOnly /><Field label="Place of supply" value={form.place_of_supply} onChange={e => setForm(old => ({ ...old, place_of_supply: e.target.value }))} /><SelectField label="Tax type" value={form.tax_mode} onChange={e => setForm(old => ({ ...old, tax_mode: e.target.value as 'intra' | 'inter' }))}><option value="intra">Within state · CGST + SGST</option><option value="inter">Other state · IGST</option></SelectField><SelectField label="Payment status" value={form.payment_status} onChange={e => setForm(old => ({ ...old, payment_status: e.target.value as Bill['payment_status'], ...(e.target.value === 'unpaid' ? { payment_date: '', payment_method: null, amount_received: '' } : {}) }))}><option value="unpaid">Unpaid</option><option value="partial">Partially paid</option><option value="paid">Paid</option></SelectField>{form.payment_status !== 'unpaid' && <><Field label="Payment date" type="date" min={form.bill_date} value={form.payment_date} onChange={e => setForm(old => ({ ...old, payment_date: e.target.value }))} /><SelectField label="Payment method" value={form.payment_method || ''} onChange={e => setForm(old => ({ ...old, payment_method: (e.target.value || null) as Bill['payment_method'] }))}><option value="">Not recorded</option><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option><option value="bank_transfer">Bank transfer</option><option value="cheque">Cheque</option><option value="other">Other</option></SelectField>{form.payment_status === 'partial' ? <Field label="Amount received" required type="number" min="0.01" step="0.01" value={form.amount_received} onChange={e => setForm(old => ({ ...old, amount_received: e.target.value }))} hint="How much the customer has paid against this bill so far." /> : <Field label="Amount received" type="number" value={String(received)} readOnly hint="The whole bill is paid." />}<Field label="Remaining" type="number" value={String(remaining)} readOnly hint={form.payment_status === 'paid' ? 'Nothing is owed on this bill.' : 'What the customer still has to pay.'} /></>}</div></Card>
    <Card className="section-card"><div className="section-heading"><span className="section-number">03</span><div><h2>Delivery challans</h2><p>The outward challans this bill pays for, and the customer's own challan numbers.</p></div></div>
      <div className="field"><span>Customer DC number</span><input aria-label="Customer DC number" placeholder="e.g. 500, 503" maxLength={64} value={customerDcNumbers} onChange={e => setCustomerDcManual(e.target.value)} /><small>Your customer's own challan numbers. They are filled in from the challans below; type or change them yourself for a bill raised by hand.</small></div>
      {selectedDcs.length > 0 && (
        <div className="selected-entity"><strong>{selectedDcs.map(dc => dc.dc_number).join(', ')}</strong><small>{selectedDcs.length === 1 ? '1 challan' : `${selectedDcs.length} challans`} linked to this bill</small><Button variant="ghost" onClick={() => { setSelectedDcs([]); setForm(old => ({ ...old, items: old.items.filter(item => !item.source_dc_id) })) }}>Clear</Button></div>
      )}
      {form.customer_id ? (
        optionsLoading ? <Loading label="Loading challans..." /> : challanOptions.length === 0 ? (
          <p className="muted">No outward challan of this customer has anything dispatched on it yet. You can still raise the bill by hand and type the customer DC number above.</p>
        ) : (
          <div className="choices">{challanOptions.map(option => {
            const on = selectedDcs.some(dc => dc.dc_id === option.dc_id)
            return (
              <button key={option.dc_id} type="button" aria-pressed={on} onClick={() => void toggleDc(option)}>
                <strong>{option.dc_number}{on ? ' — linked' : ''}</strong>
                <small>
                  {displayDate(option.dc_date)} · {option.total_dispatched} dispatched
                  {(option.customer_dc_numbers ?? []).length ? ` · customer ${(option.customer_dc_numbers ?? []).join(', ')}` : ''}
                  {option.reference_inward_number ? ` · answers ${option.reference_inward_number}` : ''}
                </small>
              </button>
            )
          })}</div>
        )
      ) : (
        <p className="muted">Choose a customer first, and the challans that can be invoiced appear here.</p>
      )}
    </Card>
    <Card className="section-card"><div className="section-heading"><span className="section-number">04</span><div><h2>Line items</h2><p>Product defaults are editable to preserve historical values.</p></div></div>{selectedDcs.length > 0 && (
      <p className="success-box">
        Filled from {selectedDcs.length === 1 ? 'outward challan' : 'outward challans'} <strong>{selectedDcs.map(dc => dc.dc_number).join(', ')}</strong>. Quantities and parts came from the
        challan; <strong>every rate is yours to enter</strong> &mdash; a delivery challan records what
        moved, not what it cost. Edit any line, or remove one you are not billing.
      </p>
    )}{form.items.map((item, index) => <div className="item-row" key={index}><div className="item-header"><div><strong>Item {index + 1}</strong>{item.source_dc_id && <small className="muted"> · from {selectedDcs.find(dc => dc.dc_id === item.source_dc_id)?.dc_number ?? 'a challan'}</small>}</div><Button variant="ghost" aria-label={`Remove item ${index + 1}`} disabled={form.items.length <= 1} onClick={() => setForm(old => ({ ...old, items: old.items.filter((_, i) => i !== index) }))}><Trash2 size={16} /></Button></div><div className="form-grid item-fields"><div className="product-input"><Field label="Product name" required value={item.product_name} onChange={e => updateItem(index, 'product_name', e.target.value)} />{productQuery?.index === index && productMatches.length > 0 && <div className="product-suggestions">{productMatches.map(p => <button key={p.id} type="button" onClick={() => selectProduct(index, p)}>{p.name} <small>{p.product_code || ''}</small></button>)}</div>}</div><Field label="HSN" value={item.hsn_code || ''} onChange={e => updateItem(index, 'hsn_code', e.target.value)} /><Field label="Qty" type="number" required min="0.001" step="0.001" value={item.quantity} onChange={e => updateItem(index, 'quantity', e.target.value)} /><Field label="Unit" value={item.unit} onChange={e => updateItem(index, 'unit', e.target.value)} /><Field label="Rate (₹)" type="number" required min="0" step="0.0001" value={item.rate} onChange={e => updateItem(index, 'rate', e.target.value)} /><Field label="Discount (₹)" type="number" min="0" step="0.01" value={item.discount} onChange={e => updateItem(index, 'discount', e.target.value)} /><Field label="GST (%)" type="number" min="0" max="100" step="0.01" value={item.gst_rate} onChange={e => updateItem(index, 'gst_rate', e.target.value)} /><Field label="Cess rate (%)" type="number" min="0" max="1000" step="0.01" value={item.cess_rate ?? '0'} onChange={e => updateItem(index, 'cess_rate', e.target.value)} /><Field label="Fixed cess (₹)" type="number" min="0" step="0.01" value={item.cess_amount ?? '0'} onChange={e => updateItem(index, 'cess_amount', e.target.value)} /></div></div>)}<Button variant="secondary" onClick={() => setForm(old => ({ ...old, items: [...old.items, itemEmpty()] }))} disabled={form.items.length >= 200}><Plus size={16} /> Add item</Button></Card>
    <Card className="section-card"><div className="section-heading"><span className="section-number">05</span><div><h2>Original & notes</h2><p>Keep the physical source for future reference.</p></div></div><DocumentPicker file={file} disabled={busy} onFile={selected => { setFile(selected); setFileError('') }} onRemove={() => { setFile(null); setFileError('') }} onError={setFileError} hint="Photograph the paper bill or drop a PDF · Max 10 MB" />{fileError && <p role="alert" className="error-box top-gap">{fileError}</p>}<TextArea label="Notes" rows={3} value={form.notes} onChange={e => setForm(old => ({ ...old, notes: e.target.value }))} /></Card>
  </div><aside className="editor-aside"><Card className="summary-card"><div className="eyebrow">LIVE CALCULATION</div><h2>Bill summary</h2><dl><div><dt>Subtotal</dt><dd>{money(preview.subtotal)}</dd></div><div><dt>Discount</dt><dd>−{money(preview.discount)}</dd></div><div><dt>Taxable amount</dt><dd>{money(preview.taxable)}</dd></div>{form.tax_mode === 'intra' ? <><div><dt>CGST</dt><dd>{money(preview.cgst)}</dd></div><div><dt>SGST</dt><dd>{money(preview.sgst)}</dd></div></> : <div><dt>IGST</dt><dd>{money(preview.igst)}</dd></div>}{preview.cess > 0 && <div><dt>Cess</dt><dd>{money(preview.cess)}</dd></div>}<div className="summary-total"><dt>Grand total</dt><dd>{money(preview.total)}</dd></div></dl><p className="muted">Final totals are recalculated in the database on save.</p>{error && <div role="alert" className="error-box">{error}{duplicates.map(d => <div key={d.bill_id}><Link to={`/bills/${d.bill_id}`} target="_blank" rel="noopener noreferrer">View existing {d.bill_number} ↗</Link></div>)}</div>}<Button className="full-button" disabled={busy} onClick={() => void save()}>{busy ? 'Saving...' : id ? 'Save changes' : source === 'ocr' ? 'Confirm & save' : 'Save bill'}</Button>{duplicates.length > 0 && <Button className="full-button top-gap" variant="secondary" disabled={busy} onClick={() => { if (window.confirm('Save this bill even though a possible duplicate exists?')) void save(true) }}>Save anyway</Button>}</Card></aside></div>{creatingCustomer && <CustomerForm onClose={() => setCreatingCustomer(false)} onSaved={customer => { setForm(old => ({ ...old, customer_id: customer.id })); setCreatingCustomer(false) }} />}</>
}
