/**
 * Delivery Challan types.
 *
 * These mirror the database exactly. Every quantity is a number here because the
 * Data API returns `numeric` as a JSON number; the columns behind them are
 * numeric(14,3) so nothing is lost for the magnitudes involved.
 */

export type DcType = 'inward' | 'outward_customer' | 'material_return'
export type DcStatus = 'draft' | 'issued' | 'dispatched' | 'partially_delivered' | 'delivered' | 'cancelled'
export type InspectionStatus =
  | 'not_required' | 'pending' | 'partially_inspected'
  | 'accepted' | 'partially_accepted' | 'rejected' | 'rework_required'
export type SupplySource = 'customer_material' | 'finished_stock' | 'other'
export type PartyType = 'customer' | 'supplier' | 'vendor' | 'other'
export type Disposition = 'return_to_customer' | 'return_to_supplier' | 'rework' | 'hold_for_decision' | 'scrap' | 'other'

export const DC_TYPE_LABEL: Record<DcType, string> = {
  inward: 'Inward DC',
  outward_customer: 'Outward DC',
  material_return: 'Material Return DC',
}

/** The title printed on the document itself. */
export const DC_TYPE_TITLE: Record<DcType, string> = {
  inward: 'INWARD DELIVERY CHALLAN',
  outward_customer: 'OUTWARD DELIVERY CHALLAN',
  material_return: 'MATERIAL RETURN CHALLAN',
}

export const DC_TYPE_DESCRIPTION: Record<DcType, string> = {
  inward: 'Material received from a customer, supplier or other authorised party.',
  outward_customer: 'Components or materials delivered to a customer.',
  material_return: 'Physical return of rejected or surplus material.',
}

export const SUPPLY_SOURCE_LABEL: Record<SupplySource, string> = {
  customer_material: 'Customer-owned material',
  finished_stock: 'Finished stock',
  other: 'Other',
}

export const INSPECTION_STATUS_LABEL: Record<InspectionStatus, string> = {
  not_required: 'Inspection not required',
  pending: 'Pending inspection',
  partially_inspected: 'Partially inspected',
  accepted: 'Accepted',
  partially_accepted: 'Partially accepted',
  rejected: 'Rejected',
  rework_required: 'Rework required',
}

export const DISPOSITION_LABEL: Record<Disposition, string> = {
  return_to_customer: 'Return to customer',
  return_to_supplier: 'Return to supplier',
  rework: 'Rework',
  hold_for_decision: 'Hold for customer decision',
  scrap: 'Scrap (authorised)',
  other: 'Other approved disposition',
}


export type DcDocument = {
  id: string
  organization_id: string
  dc_type: DcType
  dc_number: string
  dc_date: string
  financial_year: string
  status: DcStatus
  party_id: string
  party_type: PartyType
  party_name: string
  party_gstin: string | null
  party_phone: string | null
  party_email: string | null
  party_address: string | null
  party_state_code: string | null
  party_pincode: string | null
  party_contact_person: string | null
  party_ship_to: string | null
  receipt_type: string | null
  movement_type: string | null
  delivery_purpose: string | null
  purpose: string | null
  external_dc_number: string | null
  external_dc_date: string | null
  external_notes: string | null
  purchase_order_no: string | null
  job_work_order_id: string | null
  production_order_id: string | null
  reference_inward_dc_id: string | null
  customer_order_reference: string | null
  delivery_schedule_reference: string | null
  mode_of_transport: string | null
  transporter_name: string | null
  transporter_gstin: string | null
  vehicle_number: string | null
  driver_name: string | null
  driver_contact: string | null
  lr_number: string | null
  docket_number: string | null
  eway_bill_number: string | null
  package_count: number | null
  package_type: string | null
  gross_weight: number | null
  net_weight: number | null
  dispatch_at: string | null
  expected_arrival_at: string | null
  actual_arrival_at: string | null
  expected_return_at: string | null
  actual_delivery_at: string | null
  receipt_date: string | null
  receipt_time: string | null
  received_by: string | null
  prepared_by: string | null
  authorized_by: string | null
  receiver_name: string | null
  proof_of_delivery_ref: string | null
  unloading_remarks: string | null
  dispatch_remarks: string | null
  remarks: string | null
  internal_remarks: string | null
  version: number
  finalized_at: string | null
  cancelled_at: string | null
  cancel_reason: string | null
  created_at: string
}

export type DcItem = {
  id: string
  dc_id: string
  line_no: number
  product_id: string | null
  part_number: string
  customer_part_number: string | null
  /**
   * The customer's own challan number this material arrived on.
   *
   * One inward challan of ours can carry material from several of the
   * customer's challans, which is why this sits on the line and not on the
   * document. `dc_documents.external_dc_number` still holds the single
   * header-level number; this is the authoritative per-line one.
   */
  customer_dc_number: string | null
  description: string | null
  drawing_number: string | null
  drawing_revision: string | null
  batch_lot_no: string | null
  heat_no: string | null
  material_grade: string | null
  unit: string
  supply_source: SupplySource
  declared_qty: number
  received_qty: number
  shortage_qty: number
  excess_qty: number
  damaged_qty: number
  inspection_required: boolean
  inspected_qty: number
  accepted_qty: number
  rejected_qty: number
  rework_qty: number
  pending_inspection_qty: number
  inspection_status: InspectionStatus
  inspection_date: string | null
  rejection_reason: string | null
  inspection_report_no: string | null
  inspection_remarks: string | null
  processing_operation: string | null
  qty_sent: number
  expected_return_qty: number | null
  returned_qty: number
  accepted_return_qty: number
  rejected_return_qty: number
  scrap_qty: number
  still_at_vendor_qty: number | null
  ordered_qty: number | null
  previously_dispatched_qty: number
  qty_dispatched: number
  /** Acknowledged by the customer. Never exceeds qty_dispatched; see 0025. */
  qty_delivered: number
  source_inward_item_id: string | null
  /**
   * Where this line's material came from, resolved by `dc_document_json`.
   *
   * Null on a line with no source, which is legitimate: finished stock the
   * customer bought outright has no inward line behind it. On a linked line
   * `source_available_qty` is the figure `record_dispatch` will enforce -
   * inward accepted, less machining rejection, less what other outward lines
   * have already taken.
   */
  source_inward_dc_id?: string | null
  source_inward_dc_number?: string | null
  source_inward_line_no?: number | null
  source_inward_customer_dc_number?: string | null
  source_inward_accepted_qty?: number | null
  source_available_qty?: number | null
  material_owner_id: string | null
  production_order_id: string | null
  storage_location: string | null
  item_remarks: string | null
}

export type DcMovement = {
  id: string
  movement_type: 'dispatch' | 'receipt' | 'vendor_return' | 'material_return' | 'customer_delivery'
  quantity: number
  unit: string
  supply_source: SupplySource
  moved_at: string
  remarks: string | null
  is_reversal: boolean
}

export type DcInspection = {
  id: string
  dc_item_id: string
  inspected_at: string
  inspected_quantity: number
  accepted_quantity: number
  rejected_quantity: number
  rework_quantity: number
  pending_quantity: number
  rejection_reason: string | null
  disposition: Disposition | null
  inspection_report_no: string | null
  remarks: string | null
  is_reversal: boolean
}

export type DcRejection = {
  id: string
  dc_id: string
  dc_item_id: string
  party_id: string
  part_number: string
  batch_lot_no: string | null
  quantity_received: number
  quantity_inspected: number
  quantity_accepted: number
  quantity_rejected: number
  quantity_returned: number
  quantity_scrapped: number
  rejection_date: string
  rejection_reason: string | null
  inspection_report_no: string | null
  disposition: Disposition
  responsible_person: string | null
  return_dc_id: string | null
  status: 'open' | 'partially_returned' | 'returned' | 'scrapped' | 'closed'
  remarks: string | null
}

export type DcMachiningResult = {
  id: string
  source_dc_id: string | null
  source_dc_item_id: string | null
  party_id: string
  material_owner_id: string | null
  part_number: string
  operation: string
  operation_date: string
  input_quantity: number
  input_unit: string
  accepted_output_quantity: number
  output_unit: string
  machining_rejection_quantity: number
  rework_quantity: number
  scrap_quantity: number
  process_loss_quantity: number
  /**
   * What was left of the input when the record was made.
   *
   * The material that had not been machined yet: it stays with the customer
   * material until it is machined, and it cannot be sent back to the customer
   * before then. Zero on a record that finished everything it took.
   */
  remaining_quantity: number
  unit_conversion: boolean
  loss_reason: string | null
  rejection_reason: string | null
  inspection_report: string | null
  operator_name: string | null
  inspector_name: string | null
  corrective_action: string | null
  remarks: string | null
}

/** What every RPC that returns a document hands back. */
export type DcBundle = {
  document: DcDocument
  /**
   * Every customer DC number this document touches - the ones on its own lines
   * (an inward challan) and the ones behind the lines it drew from (an outward
   * challan). Always a list: one inward can reference several of the
   * customer's challans, and one outward can be fed by several of ours.
   */
  customer_dc_numbers?: string[]
  items: DcItem[]
  movements: DcMovement[]
  inspections: DcInspection[]
  machining_results: DcMachiningResult[]
  rejections: DcRejection[]
}

/**
 * How far along the work on an inward challan is.
 *
 * Derived by `dc_job_progress`, never stored. `dc_documents.status` means the
 * receipt lifecycle on an inward challan - `delivered` there means the material
 * arrived at our gate - so the job's progress is a separate value rather than a
 * second meaning on the same column.
 *
 * Four states, in the words the shop floor uses:
 *
 *   - `not_started`       nothing has been raised against this inward challan
 *   - `in_progress`       an outward challan exists: the work is under way
 *   - `partially_delivered` the customer has acknowledged some of it
 *   - `delivered`         every linked line has been acknowledged in full
 */
export type DcJobStatus =
  | 'not_started' | 'in_progress' | 'partially_delivered' | 'delivered'

export const JOB_STATUS_LABEL: Record<DcJobStatus, string> = {
  not_started: 'Job not started',
  in_progress: 'Work in process',
  partially_delivered: 'Partly delivered',
  delivered: 'Delivered',
}

/** One row of `dc_job_progress`: the document rollup, or one of its lines. */
export type DcJobProgressRow = {
  scope: 'document' | 'line'
  dc_id: string
  dc_number: string
  dc_type: DcType
  dc_status: DcStatus
  line_no: number
  part_number: string | null
  customer_dc_number: string | null
  unit: string | null
  accepted_qty: number
  machining_rejection_qty: number
  dispatched_qty: number
  delivered_qty: number
  outstanding_qty: number
  linked_dc_count: number
  job_status: DcJobStatus | null
}

/** One inward line available to draw an outward line from. */
export type DcInwardLine = {
  inward_dc_id: string
  inward_dc_number: string
  inward_dc_date: string
  inward_status: string
  item_id: string
  line_no: number
  part_number: string
  customer_part_number: string | null
  customer_dc_number: string | null
  drawing_number: string | null
  drawing_revision: string | null
  batch_lot_no: string | null
  unit: string
  received_qty: number
  accepted_qty: number
  rejected_qty: number
  /** Still awaiting a decision at inspection. Non-zero means not yet ready. */
  pending_inspection_qty: number
  inspection_status: InspectionStatus
  /**
   * Nothing left awaiting a decision. A line that was 90 accepted and 10
   * rejected IS fully inspected - the 90 is exactly what can go back - so this
   * is not the same as "nothing was rejected".
   */
  fully_inspected: boolean
  machining_rejection_qty: number
  dispatched_qty: number
  available_qty: number
}

/**
 * One line of an outward challan, for building a bill from it.
 *
 * Deliberately carries no rate and no amount. `dc_items` has neither: a
 * challan records the movement of material, not its price. Every price on the
 * resulting bill is the operator's to type.
 */
export type DcBillableLine = {
  dc_number: string
  dc_date: string
  dc_type: DcType
  party_id: string
  party_name: string
  party_gstin: string | null
  party_state_code: string | null
  party_address: string | null
  customer_dc_numbers: string[] | null
  item_id: string
  line_no: number
  product_id: string | null
  part_number: string
  customer_part_number: string | null
  description: string | null
  unit: string
  qty_dispatched: number
  qty_delivered: number
}

/** One hit of `bill_ids_for_customer_dc`. */
export type BillIdMatch = { bill_id: string; bill_number: string }

/**
 * One outward challan that can be invoiced, from `dc_billable_documents`.
 *
 * Only finalized challans with something dispatched on them are offered: a
 * draft has not happened yet, and a line with nothing on the truck is nothing
 * to invoice.
 */
export type DcBillableDocument = {
  dc_id: string
  dc_number: string
  dc_date: string
  dc_status: DcStatus
  /** The inward challan this one answers, when it names one. */
  reference_inward_number: string | null
  customer_dc_numbers: string[] | null
  line_count: number
  total_dispatched: number
}

/** One challan a bill pays for. */
export type BillChallanSummary = {
  dc_id: string
  dc_number: string
  dc_date: string
  dc_type: DcType
  dc_status: DcStatus
  customer_dc_numbers: string[] | null
  line_count: number
  total_dispatched: number
  total_delivered: number
}

/** One hit from `dc_search`: a challan of either direction. */
export type DcSearchHit = {
  result_type: 'inward' | 'outward' | 'other'
  id: string
  dc_number: string
  dc_type: DcType
  dc_date: string
  status: string
  job_status: DcJobStatus | null
  party_id: string
  party_name: string
  customer_dc_numbers: string[] | null
  line_count: number
  total_quantity: number
  /** Which identifier matched, so a row in the list is never a mystery. */
  matched_on: string | null
}

export type DcLedgerRow = {
  part_number: string
  unit: string
  declared_total: number
  received_total: number
  shortage_total: number
  excess_total: number
  damaged_total: number
  accepted_material: number
  /** Accepted straight in as finished, bypassing machining. Feeds the finished pool. */
  accepted_finished_inward: number
  rejected_material: number
  pending_inspection: number
  /** Raw material consumed by machining. This is what leaves the raw pool. */
  machining_input: number
  accepted_output: number
  machining_rejection: number
  rework_total: number
  scrap_total: number
  process_loss_total: number
  /** Unit of the machining output, which is not always the line unit. */
  output_unit: string | null
  /** True when input and output units differ, so the columns are not comparable. */
  unit_conversion: boolean
  /** Dispatched without having been machined: raw material returned unprocessed. */
  dispatched_customer_material: number
  /** Dispatched from a line that was machined: finished pieces returned. */
  dispatched_finished_stock: number
  dispatched_total: number
  /** Lifetime. Never negative. */
  available_customer_material: number
  /** Lifetime. Never negative. */
  available_finished_stock: number
  /** Left the plant with no receipt and no machining result behind it. */
  unaccounted_dispatch: number
  ordered_quantity: number
  remaining_to_order: number
}

export type DcSummary = {
  inward_this_month: number
  /**
   * Outward challans with something still outstanding. `outward_self_open` and
   * `material_at_vendors` were removed in 0025: both filtered on the
   * `outward_self` type that 0024 deleted, so they were permanently zero.
   */
  outward_customer_open: number
  drafts: number
  cancelled: number
  pending_inspection_lines: number
  pending_inspection_quantity: number
  open_material_rejections: number
  pending_return_quantity: number
  machining_rejections_this_month: number
  machining_results_recorded: number
}

export type DcSetting = {
  organization_id: string
  dc_type: DcType
  prefix: string
  segment_code: string
  padding: number
}

export type DcOption = {
  id: string
  option_group: string
  option_value: string
  is_active: boolean
  sort_order: number
}

/** One row of a line editor before it has been saved. */
export type DcItemDraft = {
  key: string
  product_id: string | null
  part_number: string
  customer_part_number: string
  customer_dc_number: string
  description: string
  drawing_number: string
  drawing_revision: string
  batch_lot_no: string
  heat_no: string
  material_grade: string
  unit: string
  supply_source: SupplySource
  declared_qty: string
  ordered_qty: string
  processing_operation: string
  material_owner_id: string
  item_remarks: string
  /** Set when the line was built from an inward line; travels to source_inward_item_id. */
  source_inward_item_id: string | null
}

export const emptyItem = (): DcItemDraft => ({
  key: crypto.randomUUID(),
  product_id: null,
  part_number: '',
  customer_part_number: '',
  customer_dc_number: '',
  description: '',
  drawing_number: '',
  drawing_revision: '',
  batch_lot_no: '',
  heat_no: '',
  material_grade: '',
  unit: 'NOS',
  supply_source: 'customer_material',
  declared_qty: '',
  ordered_qty: '',
  processing_operation: '',
  material_owner_id: '',
  item_remarks: '',
  source_inward_item_id: null,
})

/** An item draft loaded back from a saved document, for editing. */
export function draftFromItem(item: DcItem): DcItemDraft {
  return {
    key: crypto.randomUUID(),
    product_id: item.product_id,
    part_number: item.part_number,
    customer_part_number: item.customer_part_number ?? '',
    customer_dc_number: item.customer_dc_number ?? '',
    description: item.description ?? '',
    drawing_number: item.drawing_number ?? '',
    drawing_revision: item.drawing_revision ?? '',
    batch_lot_no: item.batch_lot_no ?? '',
    heat_no: item.heat_no ?? '',
    material_grade: item.material_grade ?? '',
    unit: item.unit,
    supply_source: item.supply_source,
    declared_qty: String(item.declared_qty ?? 0),
    ordered_qty: item.ordered_qty === null ? '' : String(item.ordered_qty),
    processing_operation: item.processing_operation ?? '',
    material_owner_id: item.material_owner_id ?? '',
    item_remarks: item.item_remarks ?? '',
    source_inward_item_id: item.source_inward_item_id ?? null,
  }
}