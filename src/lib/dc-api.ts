import { db, queryWithRetry } from './db'
import { settle, settleAll, type Settled } from './async'
import { describeError } from './format'
import type { PartyType } from './types'
import type {
  DcBillableLine, DcBillableDocument, DcBundle, DcDocument, DcInwardLine, DcItem, DcJobProgressRow, DcJobStatus, DcLedgerRow,
  DcOption, DcSearchHit, DcSetting, DcSummary, DcType, BillChallanSummary, BillIdMatch,
} from './dc-types'

/** Short description of a failure, for messages shown beside a partially loaded view. */
function describe(cause: unknown): string {
  return describeError(cause, 'unknown error').split('\n')[0]?.slice(0, 160) ?? 'unknown error'
}

/**
 * Every DC write goes through one of these RPCs. There is no other way to move
 * material: the browser has no INSERT or UPDATE grant on any dc_* table, so a
 * crafted request cannot set a quantity directly.
 */

/**
 * Calls one of the RPCs whose only argument is a `payload jsonb`.
 *
 * The body has to arrive wrapped in a key with exactly that name. PostgREST
 * matches the keys of a request body against the names of the function's
 * parameters, so sending the payload's own fields at the top level asks it for
 * `save_inward_dc(organization_id, party_id, items, ...)` - a function that does
 * not exist - and it answers PGRST202. That reply is a 404 reading
 * "Could not find the function public.save_inward_dc(...) in the schema cache",
 * which reads like a deployment problem rather than a malformed call, and it
 * took every DC write in the module down with it: saving a draft, finalizing a
 * challan, recording a receipt or an inspection, issuing material, cancelling.
 *
 * The read-only RPCs below take ordinary named parameters and are called with
 * those names directly.
 */
async function call<T>(name: string, payload: Record<string, unknown>): Promise<T> {
  const { data, error } = await queryWithRetry(() => db.rpc(name as never, { payload } as never))
  if (error) throw error
  return (data ?? null) as T
}

/** For the one RPC that takes no arguments at all. */
async function callWithoutArguments<T>(name: string): Promise<T> {
  const { data, error } = await queryWithRetry(() => db.rpc(name as never, {} as never))
  if (error) throw error
  return (data ?? null) as T
}

/** One row of the DC register, which joins the referenced inward challan's number. */
export type DcListRow = {
  id: string
  dc_number: string
  dc_type: DcType
  dc_date: string
  status: string
  /**
   * How far the job on an inward challan has got: derived from the outward
   * challans drawn from it, never stored. Null for outward challans, which are
   * their own delivery and carry the answer in `status`.
   */
  job_status: DcJobStatus | null
  party_id: string
  party_name: string
  party_gstin: string | null
  /** Every customer DC number this document touches. Always an array, possibly empty. */
  customer_dc_numbers: string[] | null
  reference_inward_dc_id: string | null
  reference_inward_number: string | null
  vehicle_number: string | null
  line_count: number
  total_quantity: number
  total_declared: number
}

/** Where one line of a challan came from, merged onto the item by loadDcBundle. */
type DcLineSource = {
  item_id: string
  line_no: number
  source_inward_item_id: string
  source_inward_dc_id: string
  source_inward_dc_number: string
  source_inward_line_no: number
  source_inward_customer_dc_number: string | null
  source_inward_accepted_qty: number
  source_available_qty: number
}

const withOrg = (payload: Record<string, unknown>, organizationId: string) =>
  ({ ...payload, organization_id: organizationId })

/**
 * Turns an option label from dc_options into the value the column accepts.
 *
 * The dropdowns offer the human labels seeded into dc_options, but
 * receipt_type, movement_type and delivery_purpose are constrained columns that
 * hold fixed slugs. Turning one label into a slug by lowercasing it and swapping
 * spaces for underscores is right often enough to be tempting and wrong exactly
 * where it matters: "Approved Sample" becomes approved_sample and "Inter-Company
 * Transfer" becomes inter_company_transfer, neither of which the database
 * accepts, and the save is refused with a 400. "For Inspection" and "For Rework"
 * both have to land on inspection_rework. Every mapping is therefore written out,
 * once, here.
 *
 * The unknown-label fallback is the slug the column would reject, which is the
 * honest outcome: a label added in DC settings that has no counterpart in this
 * map cannot be stored, and the database is right to say so.
 */
const OPTION_VALUE: Record<string, Record<string, string>> = {
  receipt_type: {
    'Raw Material': 'raw_material',
    'Customer Owned Component': 'customer_owned',
    'Semi-Finished Component': 'semi_finished',
    'Return from Processing': 'return_from_processing',
    'For Inspection': 'inspection_rework',
    'For Rework': 'inspection_rework',
    Other: 'other',
  },
  movement_type: {
    Subcontracting: 'subcontracting',
    'Inter-Company Transfer': 'inter_company',
    'Return to Supplier': 'return_to_supplier',
    Testing: 'testing',
    Inspection: 'inspection',
    Other: 'other',
  },
  delivery_purpose: {
    'Finished Goods': 'finished_goods',
    'Partially Processed': 'partially_processed',
    'Approved Sample': 'sample',
    'Customer Inspection': 'customer_inspection',
    Replacement: 'replacement',
    Rework: 'rework',
    Other: 'other',
  },
}

export function optionValue(group: string, label: string): string {
  return OPTION_VALUE[group]?.[label] ?? label.replace(/[\s-]+/g, '_').toLowerCase()
}

/** Unwraps a report result set, failing loudly rather than returning an empty table. */
async function rows(result: unknown): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await queryWithRetry(() => result as Promise<{ data: unknown; error: unknown }>)
  if (error) throw error
  return (data ?? []) as Array<Record<string, unknown>>
}

export const dcApi = {
  /** Seeds the workspace option lists and numbering on first use. */
  bootstrapOptions: () => callWithoutArguments<{ organization_id: string }>('dc_bootstrap_options'),

  saveInward: (organizationId: string, payload: Record<string, unknown>) =>
    call<DcBundle>('save_inward_dc', withOrg(payload, organizationId)),


  saveOutwardCustomer: (organizationId: string, payload: Record<string, unknown>) =>
    call<DcBundle>('save_outward_customer_dc', withOrg(payload, organizationId)),

  recordReceipt: (organizationId: string, payload: Record<string, unknown>) =>
    call<DcBundle>('record_inward_receipt', withOrg(payload, organizationId)),

  recordInspection: (organizationId: string, payload: Record<string, unknown>) =>
    call<DcBundle>('record_material_inspection', withOrg(payload, organizationId)),

  recordMaterialReturn: (organizationId: string, payload: Record<string, unknown>) =>
    call<{ rejection: Record<string, unknown>; return_dc: DcBundle }>(
      'record_material_return', withOrg(payload, organizationId)),


  recordDispatch: (organizationId: string, payload: Record<string, unknown>) =>
    call<DcBundle>('record_dispatch', withOrg(payload, organizationId)),

  confirmDelivery: (organizationId: string, payload: Record<string, unknown>) =>
    call<DcBundle>('confirm_delivery', withOrg(payload, organizationId)),

  recordMachining: (organizationId: string, payload: Record<string, unknown>) =>
    call<Record<string, number>>('record_machining_result', withOrg(payload, organizationId)),

  recordMachiningBatch: (organizationId: string, payload: Record<string, unknown>) =>
    call<Record<string, unknown>>('record_machining_batch', withOrg(payload, organizationId)),

  cancel: (organizationId: string, dcId: string, reason: string) =>
    call<DcBundle>('cancel_dc', withOrg({ dc_id: dcId, reason }, organizationId)),

  /** Read-only: the eligible balance the server will enforce. */
  /**
   * Read-only wrappers. Each one awaits the client's thenable rather than
   * chaining onto it, because the Data API builder exposes no `.catch`.
   */
  async availableBalance(organizationId: string, customerId: string, part: string, source: string) {
    const { data, error } = await queryWithRetry(() => db.rpc('dc_available_balance' as never, {
      p_org: organizationId, p_customer_id: customerId, p_part: part, p_supply_source: source,
    } as never))
    if (error) throw error
    return Number(data ?? 0)
  },

  /**
   * What is left of one inward line, which is the figure `record_dispatch`
   * enforces for an outward line linked to it: accepted, less machining
   * rejection, less what other outward challans have already taken.
   */
  async inwardLineAvailability(organizationId: string, inwardItemId: string) {
    const { data, error } = await queryWithRetry(() => db.rpc('dc_inward_line_availability' as never, {
      p_org: organizationId, p_inward_item_id: inwardItemId,
    } as never))
    if (error) throw error
    return Number(data ?? 0)
  },

  /**
   * How much of an inward line is still to be machined.
   *
   * The accepted quantity less everything a machining record has already
   * accounted for, so a second record on the same line starts from what is
   * left rather than from the whole accepted quantity again.
   */
  async inwardLineUnmachined(organizationId: string, inwardItemId: string) {
    const { data, error } = await queryWithRetry(() => db.rpc('dc_inward_line_unmachined' as never, {
      p_org: organizationId, p_inward_item_id: inwardItemId,
    } as never))
    if (error) throw error
    return Number(data ?? 0)
  },

  /**
   * The inward lines of one customer that still have material to give.
   *
   * Only lines with something available are returned, so the picker cannot
   * offer a line the database would refuse to dispatch against. Each row also
   * carries its inspection state, so a line still awaiting a decision can be
   * marked rather than silently offered as finished.
   */
  async inwardLines(organizationId: string, customerId: string, query?: string) {
    const { data, error } = await queryWithRetry(() => db.rpc('dc_inward_lines' as never, {
      p_org: organizationId, p_party: customerId, p_query: query || null,
    } as never))
    if (error) throw error
    return (data ?? []) as DcInwardLine[]
  },

  /**
   * The lines of an outward challan, for building a bill from it.
   *
   * Returns quantities and part numbers only. A challan carries no rate, so
   * every price on the bill is typed by the operator.
   */
  async billableLines(organizationId: string, dcId: string) {
    const { data, error } = await queryWithRetry(() => db.rpc('dc_billable_lines' as never, {
      p_org: organizationId, p_dc_id: dcId,
    } as never))
    if (error) throw error
    return (data ?? []) as DcBillableLine[]
  },

  /** Bills reachable through a customer DC number on one of their challans. */
  async billsForCustomerDc(organizationId: string, query: string) {
    const { data, error } = await queryWithRetry(() => db.rpc('bill_ids_for_customer_dc' as never, {
      p_org: organizationId, p_query: query,
    } as never))
    if (error) throw error
    return (data ?? []) as BillIdMatch[]
  },

  /** Bills reachable through the number of a challan they pay for. */
  async billsForDcNumber(organizationId: string, query: string) {
    const { data, error } = await queryWithRetry(() => db.rpc('bill_ids_for_dc_number' as never, {
      p_org: organizationId, p_query: query,
    } as never))
    if (error) throw error
    return (data ?? []) as BillIdMatch[]
  },

  /**
   * The bill number the form offers before anything is saved.
   *
   * A read: it does not take the number, so a form that is opened and closed
   * leaves no gap in the series. The number the bill is actually saved with
   * is the one `reserveBillNumber` returns, and that is the authoritative one
   * - the number shown here may have been taken by somebody else in the
   * meantime.
   */
  async nextBillNumber(organizationId: string, date: string) {
    const { data, error } = await queryWithRetry(() => db.rpc('next_bill_number' as never, {
      p_org: organizationId, p_date: date,
    } as never))
    if (error) throw error
    return (data as { bill_number: string } | null)?.bill_number ?? null
  },

  /**
   * The number the bill is saved with.
   *
   * Called once, immediately before the save.
   *
   * With no number wanted, the database picks the next free one in the
   * financial year. With a number wanted - the one the challan made, or the
   * one the operator typed - it is checked: a number of ours that names a
   * challan is accepted only when the bill pays for that challan, and a
   * number already held by another bill is refused.
   */
  async reserveBillNumber(organizationId: string, date: string, billNumber: string | null, dcIds: string[], billId?: string | null) {
    const { data, error } = await queryWithRetry(() => db.rpc('reserve_bill_number' as never, {
      p_org: organizationId,
      p_date: date,
      p_bill_number: billNumber && billNumber.trim() ? billNumber.trim() : null,
      p_dc_ids: dcIds,
      p_bill_id: billId ?? null,
    } as never))
    if (error) throw error
    return (data as { bill_number: string } | null)?.bill_number ?? null
  },

  /**
   * The challans a bill pays for, with enough on each to be useful.
   *
   * One bill can cover several outward challans, and one challan can be billed
   * across several bills, so this is a list rather than a single reference.
   */
  async billsForBill(organizationId: string, billId: string) {
    const { data, error } = await queryWithRetry(() => db.rpc('bills_for_dc_summary' as never, {
      p_org: organizationId, p_bill_id: billId,
    } as never))
    if (error) throw error
    return (data ?? []) as BillChallanSummary[]
  },

  /**
   * How far the job on an inward challan has got.
   *
   * Derived by the database, never stored. `dc_documents.status` means the
   * receipt lifecycle on an inward challan, so this is deliberately a separate
   * value: writing "delivered" there when the outward ships would say "we
   * received it" when the meaning is "our job on it is finished".
   */
  async jobProgress(organizationId: string, dcId: string) {
    const { data, error } = await queryWithRetry(() => db.rpc('dc_job_progress' as never, {
      p_org: organizationId, p_dc_id: dcId,
    } as never))
    if (error) throw error
    return (data ?? []) as DcJobProgressRow[]
  },

  /**
   * One search across challans and bills.
   *
   * A customer's DC number returns the inward challans carrying it *and* the
   * outward challans drawn from those inward lines, which is the whole reason
   * the link exists.
   */
  async search(organizationId: string, query: string, limit = 100) {
    const { data, error } = await queryWithRetry(() => db.rpc('dc_search' as never, {
      p_org: organizationId, p_query: query, p_limit: limit,
    } as never))
    if (error) throw error
    return (data ?? []) as DcSearchHit[]
  },

  /**
   * The outward challans that can be invoiced for a customer.
   *
   * Only finalized challans with something dispatched on them: a draft has not
   * happened yet, and a line with nothing on the truck is nothing to invoice.
   * The customer DC numbers come back with each one, taken from the inward
   * lines the material was drawn from.
   */
  async billableDocuments(organizationId: string, partyId?: string | null) {
    const { data, error } = await queryWithRetry(() => db.rpc('dc_billable_documents' as never, {
      p_org: organizationId, p_party_id: partyId ?? null,
    } as never))
    if (error) throw error
    return (data ?? []) as DcBillableDocument[]
  },

  /**
   * Records the customer's own challan number on a bill by hand.
   *
   * Only needed for a bill that is not raised from one of our outward
   * challans - an old invoice typed in from paper, or work that never had a
   * challan. Bills raised from a challan take the number from it.
   */
  async setBillReferences(organizationId: string, billId: string, customerDcReference: string | null) {
    return call<{ bill_id: string; customer_dc_reference: string | null }>(
      'set_bill_dc_references',
      withOrg({ bill_id: billId, customer_dc_reference: customerDcReference ?? '' }, organizationId),
    )
  },

  /**
   * The outward challans made from one inward challan.
   *
   * The other direction of the link: the inward challan's page shows which of
   * our outward challans answer it.
   */
  async outwardsForInward(organizationId: string, inwardId: string) {
    const { data, error } = await queryWithRetry(() => db.rpc('dc_outward_challans_for_inward' as never, {
      p_org: organizationId, p_inward_id: inwardId,
    } as never))
    if (error) throw error
    return (data ?? []) as Array<{
      dc_id: string; dc_number: string; dc_date: string; dc_status: string
      line_count: number; total_dispatched: number; total_delivered: number
    }>
  },

  /** Replaces the set of bills attached to a challan. Audited; idempotent. */
  async linkBills(organizationId: string, dcId: string, billIds: string[]) {
    return call<{ dc_id: string; bills: { bill_id: string }[] }>(
      'dc_link_bills',
      withOrg({ dc_id: dcId, bills: billIds.map(bill_id => ({ bill_id })) }, organizationId),
    )
  },

  async linkedBills(organizationId: string, dcId: string) {
    const { data, error } = await queryWithRetry(() => db.rpc('dc_linked_bills' as never, {
      p_org: organizationId, p_dc_id: dcId,
    } as never))
    if (error) throw error
    return (data ?? []) as Array<{
      bill_id: string; bill_number: string; bill_date: string
      customer_id: string; customer_name: string
      grand_total: number; payment_status: string
    }>
  },

  /** Named parameters, so this one is addressed directly rather than through call(). */
  async dashboard(organizationId: string) {
    const { data, error } = await queryWithRetry(() => db.rpc('dc_dashboard_summary' as never, { p_org: organizationId } as never))
    if (error) throw error
    return data as DcSummary
  },

  async register(
    organizationId: string,
    filters: { dc_type?: string; from?: string; to?: string; status?: string; job_status?: string } = {},
  ) {
    const { data, error } = await queryWithRetry(() => db.rpc('dc_register' as never, {
      p_org: organizationId,
      p_dc_type: filters.dc_type ?? null,
      p_from: filters.from || null,
      p_to: filters.to || null,
      p_status: filters.status || null,
      p_job_status: filters.job_status || null,
    } as never))
    if (error) throw error
    return (data ?? []) as DcListRow[]
  },

  async ledger(organizationId: string, customerId: string, part?: string, from?: string, to?: string) {
    const { data, error } = await queryWithRetry(() => db.rpc('customer_material_ledger' as never, {
      p_org: organizationId, p_customer_id: customerId, p_part: part || null, p_from: from || null, p_to: to || null,
    } as never))
    if (error) throw error
    return (data ?? []) as DcLedgerRow[]
  },

  async pendingInspection(organizationId: string, from?: string, to?: string) {
    return rows(await db.rpc('dc_pending_inspection' as never, { p_org: organizationId, p_from: from || null, p_to: to || null } as never))
  },

  async materialRejections(organizationId: string, from?: string, to?: string) {
    return rows(await db.rpc('dc_material_rejections' as never, { p_org: organizationId, p_from: from || null, p_to: to || null } as never))
  },

  async machiningRejections(organizationId: string, from?: string, to?: string) {
    return rows(await db.rpc('dc_machining_rejections' as never, { p_org: organizationId, p_from: from || null, p_to: to || null } as never))
  },

  async variance(organizationId: string, from?: string, to?: string) {
    return rows(await db.rpc('dc_variance_report' as never, { p_org: organizationId, p_from: from || null, p_to: to || null } as never))
  },


  async pendingCustomerDelivery(organizationId: string) {
    return rows(await db.rpc('dc_pending_customer_delivery' as never, { p_org: organizationId } as never))
  },

  async acceptanceRate(organizationId: string, from?: string, to?: string) {
    return rows(await db.rpc('dc_acceptance_rate' as never, { p_org: organizationId, p_from: from || null, p_to: to || null } as never))
  },

  async rejectionTrend(organizationId: string) {
    return rows(await db.rpc('dc_rejection_trend' as never, { p_org: organizationId } as never))
  },

  async movementHistory(organizationId: string, from?: string, to?: string, type?: string) {
    return rows(await db.rpc('dc_movement_history' as never, {
      p_org: organizationId, p_from: from || null, p_to: to || null, p_movement_type: type || null,
    } as never))
  },

  settings: async (organizationId: string): Promise<DcSetting[]> => {
    // Throws on failure. Returning [] here made a broken read look like "no
    // numbering configuration exists", and the settings page rendered an empty
    // table as though that were the truth.
    const result = await settle(() => queryWithRetry(() =>
      db.from('dc_settings').select('*').eq('organization_id', organizationId)))
    if (!result.ok) throw result.error
    if (result.value.error) throw result.value.error
    return (result.value.data ?? []) as DcSetting[]
  },

  updateSettings: (organizationId: string, payload: Record<string, unknown>) =>
    // dc_update_settings returns the whole jsonb array of settings, not one row.
    call<DcSetting[]>('dc_update_settings', withOrg(payload, organizationId)),

  options: async (organizationId: string, group?: string): Promise<DcOption[]> => {
    // Throws on failure, for the same reason: an empty option list collapsed every
    // dropdown on the challan form to a single "Not specified" entry with no
    // indication that anything had gone wrong.
    const result = await settle(() => queryWithRetry(() => {
      let request = db.from('dc_options').select('*').eq('organization_id', organizationId).eq('is_active', true)
      if (group) request = request.eq('option_group', group)
      return request.order('sort_order')
    }))
    if (!result.ok) throw result.error
    if (result.value.error) throw result.value.error
    return (result.value.data ?? []) as DcOption[]
  },

  saveOption: (organizationId: string, payload: Record<string, unknown>) =>
    call<DcOption>('dc_save_option', withOrg(payload, organizationId)),
}

/**
 * Reads a document with its items, movements, inspections and rejections.
 *
 * Returns null only when the document genuinely does not exist or is not visible.
 * A transport failure throws instead, because rendering "not found" for a dropped
 * connection is what made a refresh look like the only way to recover.
 *
 * A failing child read is reported through `partial_errors` rather than silently
 * producing an empty list: an item table that is missing its rows looks exactly
 * like a challan with no lines, which is a dangerous thing to show a storekeeper.
 */
export type DcBundleResult = { bundle: DcBundle | null; partialErrors: string[] }

export async function loadDcBundle(dcId: string, organizationId: string): Promise<DcBundleResult> {
  const head = await settle(() => db
    .from('dc_documents').select('*')
    .eq('id', dcId).eq('organization_id', organizationId).is('deleted_at', null).single())
  if (!head.ok) throw head.error
  const headRow = head.value as { data?: unknown; error?: unknown }
  if (headRow.error) throw headRow.error
  if (!headRow.data) return { bundle: null, partialErrors: [] }

  const document = headRow.data as DcDocument
  const [items, movements, inspections, rejections, machining, sources] = await settleAll([
    () => db.from('dc_items').select('*').eq('dc_id', dcId).eq('organization_id', organizationId).order('line_no'),
    () => db.from('dc_movements').select('*').eq('dc_id', dcId).eq('organization_id', organizationId).order('moved_at'),
    () => db.from('dc_inspections').select('*').eq('dc_id', dcId).eq('organization_id', organizationId).order('inspected_at'),
    () => db.from('dc_rejections').select('*').eq('dc_id', dcId).eq('organization_id', organizationId).order('rejection_date'),
    () => db.from('dc_machining_results').select('*').eq('source_dc_id', dcId).eq('organization_id', organizationId).order('operation_date'),
    () => db.rpc('dc_line_sources' as never, { p_org: organizationId, p_dc_id: dcId } as never),
  ])

  const read = <T,>(step: Settled<{ data?: unknown; error?: unknown }>, label: string, fallback: T[]): T[] => {
    if (!step.ok) { partialErrors.push(`${label}: ${describe(step.error)}`); return fallback }
    if (step.value.error) { partialErrors.push(`${label}: ${describe(step.value.error)}`); return fallback }
    return (Array.isArray(step.value.data) ? step.value.data : []) as T[]
  }

  const partialErrors: string[] = []
  const lines = read<DcItem>(items, 'lines', [])

  // Where each line's material came from. Merged in rather than read as part of
  // the lines themselves: the Data API cannot join, and a failure here leaves
  // the challan fully readable with the source columns blank rather than
  // replacing a resilient multi-read with one function call that can fail.
  const byItem = new Map<string, DcLineSource>()
  for (const source of read<DcLineSource>(sources, 'line sources', [])) byItem.set(source.item_id, source)
  for (const line of lines) {
    const source = byItem.get(line.id)
    if (!source) continue
    line.source_inward_dc_id = source.source_inward_dc_id
    line.source_inward_dc_number = source.source_inward_dc_number
    line.source_inward_line_no = source.source_inward_line_no
    line.source_inward_customer_dc_number = source.source_inward_customer_dc_number
    line.source_inward_accepted_qty = source.source_inward_accepted_qty
    line.source_available_qty = source.source_available_qty
  }

  // The customer DC numbers this challan touches, from both directions: the
  // ones on its own lines (an inward challan) and the ones behind the lines it
  // drew from (an outward challan). Derived here rather than read, so the
  // header of a mixed outward challan names only the customer DCs its material
  // actually arrived on.
  const customerDcNumbers = [...new Set(lines.flatMap(line =>
    [line.customer_dc_number, line.source_inward_customer_dc_number]
      .filter((value): value is string => Boolean(value && value.trim())),
  ))].sort((a, b) => a.localeCompare(b))

  return {
    bundle: {
      document,
      customer_dc_numbers: customerDcNumbers,
      items: lines,
      movements: read(movements, 'movements', []),
      inspections: read(inspections, 'inspections', []),
      rejections: read(rejections, 'rejections', []),
      machining_results: read(machining, 'machining results', []),
    },
    partialErrors,
  }
}

export type PartySummary = {
  id: string
  name: string
  gstin: string | null
  city: string | null
  party_type: string
  phone: string | null
}

/** How a party search term is applied to the customers table.
 *
 *  Exported for testing, because the rule was wrong for a long time in a way
 *  that could only be seen in the browser: an empty term produced no filter at
 *  all, so the picker had nothing to show until someone typed.
 *
 *  A GSTIN is alphanumeric, so a scrubbed term that is long enough and holds a
 *  digit is treated as one and matched as a prefix. Ordinary words are left to
 *  the name match alone instead of being dragged into the or=(...) branch.
 */
export function partySearch(term: string): { name: string | null; gstinPrefix: string | null } {
  const trimmed = term.trim()
  if (!trimmed) return { name: null, gstinPrefix: null }

  const gstin = trimmed.replace(/[^0-9A-Za-z]/g, '').toUpperCase()
  const looksLikeGstin = /\d/.test(gstin) && gstin.length >= 6

  const name = `%${trimmed.replace(/[\\%_]/g, '\\$&')}%`
  return {
    // Commas and brackets are stripped because or=(...) splits on commas and a
    // company name can contain one. A GSTIN never contains either, so this
    // only ever costs a partial name match, never a failed query.
    name: looksLikeGstin ? name.replace(/[,()]/g, ' ') : name,
    gstinPrefix: looksLikeGstin ? `${gstin}%` : null,
  }
}

/** Escaped search for the party picker.
 *
 *  An empty term deliberately lists the parties eligible for this document type
 *  rather than returning nothing. A picker that stays blank until you type is
 *  indistinguishable from a workspace that has no parties at all, which is
 *  exactly the wrong answer to give someone trying to find one.
 *
 *  A failure is thrown, not swallowed. Returning [] on error made a broken query
 *  read as "no such party", and hid the real cause. */
export async function searchParties(
  organizationId: string,
  query: string,
  partyTypes?: string[],
): Promise<PartySummary[]> {
  const { name, gstinPrefix } = partySearch(query)

  let request = db.from('customers').select('id,name,gstin,city,party_type,phone')
    .eq('organization_id', organizationId).is('deleted_at', null)

  if (name && gstinPrefix) request = request.or(`gstin.ilike.${gstinPrefix},name.ilike.${name}`)
  else if (name) request = request.ilike('name', name)

  if (partyTypes?.length) request = request.in('party_type', partyTypes as Array<PartyType>)

  const { data, error } = await request.order('name').limit(25)
  if (error) throw error
  return (data ?? []) as PartySummary[]
}