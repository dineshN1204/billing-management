export type Role = 'admin' | 'staff' | 'viewer'
/** Delivery Challan module: customers also hold suppliers, vendors and other parties. */
export type PartyType = 'customer' | 'supplier' | 'vendor' | 'other'
export type Customer = {
  id: string
  organization_id: string
  name: string
  gstin: string | null
  phone: string | null
  email: string | null
  address: string | null
  state_code: string | null
  notes: string | null
  address_line_1: string | null
  address_line_2: string | null
  city: string | null
  state: string | null
  pincode: string | null
  country: string | null
  verification_status: 'unverified' | 'needs_review' | 'verified' | 'rejected'
  /** Delivery Challan module: this table also holds suppliers and vendors. */
  party_type: PartyType
  created_at: string
  deleted_at: string | null
}
export type Product = {
  id: string
  organization_id: string
  name: string
  product_code: string | null
  hsn_code: string | null
  unit: string
  default_rate: number
  gst_rate: number
  description: string | null
  deleted_at: string | null
}
export type Bill = {
  id: string
  organization_id: string
  customer_id: string
  customer_name: string
  customer_gstin: string | null
  customer_phone: string | null
  customer_email: string | null
  customer_address: string | null
  bill_number: string
  bill_date: string
  place_of_supply: string | null
  financial_year: string
  tax_mode: 'intra' | 'inter'
  payment_status: 'paid' | 'partial' | 'unpaid'
  payment_date: string | null
  payment_method: 'cash' | 'upi' | 'card' | 'bank_transfer' | 'cheque' | 'other' | null
  source_type: 'manual' | 'ocr' | 'import'
  verification_status: 'verified' | 'needs_review' | 'unverified' | 'rejected'
  /**
   * The customer's own delivery challan number, typed by hand.
   *
   * Bills raised from one of our outward challans take the number from that
   * challan instead; this is for a bill raised by hand - an old invoice typed
   * in from paper, or work that never had a challan.
   */
  customer_dc_reference: string | null
  notes: string | null
  subtotal: number
  discount_total: number
  taxable_amount: number
  cgst_amount: number
  sgst_amount: number
  igst_amount: number
  tax_total: number
  cess_amount: number
  grand_total: number
  /**
   * What has been received against this bill so far.
   *
   * Zero on an unpaid bill, the whole total on a paid one, and what the
   * operator typed on a partly paid one.
   */
  paid_amount: number
  /**
   * What is still owed: the total less what has been received.
   *
   * A generated column in the database, so every screen reads the same figure.
   */
  remaining_amount: number
  version: number
  /**
   * Why this bill was cancelled, set when it is cancelled and cleared when it
   * is restored. The cancellation dialog writes it; the cancelled-bills view
   * shows it. Null on a bill that is on the books.
   */
  cancellation_reason: string | null
  deleted_at: string | null
  created_at: string
}
export type BillItem = {
  id: string
  line_no: number
  bill_id: string
  product_id: string | null
  product_name: string
  product_code: string | null
  hsn_code: string | null
  description: string | null
  unit: string
  quantity: number
  rate: number
  discount: number
  gst_rate: number
  line_subtotal: number
  taxable_amount: number
  cgst_amount: number
  sgst_amount: number
  igst_amount: number
  cess_amount: number
  cess_rate: number
  line_total: number
}
export type Attachment = { id: string; bill_id: string; file_path: string; file_name: string; mime_type: string | null }
export type OcrJob = {
  id: string
  organization_id: string
  bill_id: string | null
  file_path: string
  status: string
  staging: Record<string, unknown>
  confidence: number | null
  error_message: string | null
  created_at: string
}
export type BillPayloadItem = {
  product_id?: string | null
  product_name: string
  product_code?: string | null
  hsn_code?: string | null
  description?: string | null
  unit: string
  quantity: string
  rate: string
  discount: string
  gst_rate: string
  cess_rate?: string
  cess_amount?: string
}
export type BillPayload = {
  organization_id: string
  customer_id: string
  bill_number: string
  bill_date: string
  tax_mode: 'intra' | 'inter'
  place_of_supply: string | null
  payment_status: Bill['payment_status']
  payment_date: string | null
  payment_method: Bill['payment_method']
  /**
   * What the customer has paid against this bill.
   *
   * Only sent for a partly paid bill: the amount is what makes "partial" mean
   * something, and the database derives the amount for an unpaid bill (nothing)
   * and for a paid one (the whole total). Null when it does not apply.
   */
  amount_received?: number | null
  notes: string | null
  /**
   * Provenance and verification, set when a bill is first created.
   *
   * Optional because an update must omit them: app_private.upsert_bill treats a
   * missing key as "keep what is already stored" (0009 lines 226-231, 233-240).
   * Sending them on every save used to rewrite an OCR or imported bill's source to
   * "manual" and promote a needs_review bill to "verified" under whoever edited it.
   */
  source_type?: Bill['source_type']
  verification_status?: Bill['verification_status']
  items: BillPayloadItem[]
  attachments?: Array<{ file_path: string; file_name: string; mime_type: string; size_bytes: number }>
  ocr_job_id?: string
}
