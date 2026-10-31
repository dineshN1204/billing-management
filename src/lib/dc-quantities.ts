/**
 * Delivery Challan quantity rules, in the browser.
 *
 * This module is deliberately a mirror of what `db/migrations/0016_dc_rpc.sql`
 * enforces. It exists so the forms can show a correct balance *before* the user
 * saves, and so the arithmetic is unit-testable. It is never the authority: the
 * database re-checks every number, and where the two disagree the database
 * wins. Nothing here should be used to decide that a quantity is valid.
 *
 * The rule that shapes this file: receiving is not accepting, and two different
 * pools of material are never netted against one another.
 */

export type ReceiptSplit = {
  declared: number
  received: number
  shortage: number
  excess: number
  /** Received but refused at the gate, before anything was inspected. */
  rejected: number
  /** Still awaiting inspection, i.e. what an inspection can be recorded against. */
  pending: number
}

/**
 * Rule 1: the quantity declared on the external challan and the quantity that
 * physically arrived are separate facts. A short receipt is recorded as a
 * shortage, never by overwriting what the customer declared.
 *
 * Material refused at the gate is part of what arrived, not a deduction from it:
 * the shortage is still measured against the declared quantity so a challan
 * showing "20 short" is not quietly turned into "50 short" by also rejecting 30.
 */
export function receiptSplit(declared: number, received: number, rejected = 0): ReceiptSplit {
  const d = Math.max(0, declared)
  const r = Math.max(0, received)
  const x = Math.min(Math.max(0, rejected), r)
  return {
    declared: d,
    received: r,
    shortage: Math.max(d - r, 0),
    excess: Math.max(r - d, 0),
    rejected: x,
    pending: r - x,
  }
}

export type InspectionSplit = {
  inspected: number
  accepted: number
  rejected: number
  rework: number
  pending: number
  reconciled: boolean
}

/**
 * Rule 2, ceiling half only: accepted + rejected + rework must never exceed what
 * was physically received, cumulatively across inspections.
 *
 * `pending` is deliberately NOT part of the ceiling, and `reconciled` here means
 * only "under the ceiling" - NOT "the line adds up". Since 0022 the database also
 * requires the four outcomes to sum to exactly the quantity still to be
 * inspected, and `balanceInspectionOutcome` is what enforces that. This function
 * remains as the mirror of the ceiling check on its own, which the database runs
 * first and which decides the error the operator sees.
 *
 * The database enforces
 *
 *     accepted_qty + rejected_qty + rework_qty <= received_qty
 *
 * (record_material_inspection in 0022, and the
 * dc_items_inspection_within_receipt_check constraint in 0014). `pending` is
 * material that has *not* been judged yet - it is still in stock awaiting
 * inspection - so counting it toward the ceiling made this function report a
 * perfectly legal submission as unreconciled.
 */
export function inspectionSplit(
  accepted: number,
  rejected: number,
  rework: number,
  pending: number,
  receivedQty: number,
  cumulative = { accepted: 0, rejected: 0, rework: 0 },
): InspectionSplit {
  const a = Math.max(0, accepted)
  const r = Math.max(0, rejected)
  const w = Math.max(0, rework)
  const p = Math.max(0, pending)
  const inspected = a + r + w + p
  const alreadyAccounted = cumulative.accepted + cumulative.rejected + cumulative.rework
  return {
    inspected,
    accepted: a,
    rejected: r,
    rework: w,
    pending: p,
    reconciled: alreadyAccounted + a + r + w <= Math.max(0, receivedQty),
  }
}

/**
 * The inspection status implied by the quantities.
 *
 * Mirrors the SQL CASE in record_material_inspection (0016 lines 1003-1009),
 * which mixes cumulative totals for the first two branches with the increment for
 * the last two. The `cumulative` argument is the accepted/rejected/rework already
 * on the line; the other three are this inspection's increment.
 */
export function inspectionStatus(
  accepted: number,
  rejected: number,
  rework: number,
  pending: number,
  cumulative = { accepted: 0, rejected: 0, rework: 0 },
): string {
  const totalAccepted = cumulative.accepted + Math.max(0, accepted)
  const totalRejected = cumulative.rejected + Math.max(0, rejected)
  const thisRework = Math.max(0, rework)
  const thisRejected = Math.max(0, rejected)
  if (totalAccepted > 0 && totalRejected > 0) return 'partially_accepted'
  if (totalRejected > 0 && totalAccepted === 0) return 'rejected'
  if (thisRework > 0 && thisRejected === 0) return 'rework_required'
  if (pending > 0) return 'partially_inspected'
  return 'accepted'
}

/**
 * Where an inward challan has got to, derived from its lines rather than stored.
 *
 * There is no "finalised" status on an inward document and there is not meant to
 * be one: a challan is complete when every line has been judged, and that is a
 * fact about the lines, not a decision somebody ticks. Deriving it means it can
 * never disagree with the quantities underneath it, and it cannot get stuck - a
 * receipt re-recorded after the fact moves the challan back on its own.
 *
 * `not_received` is deliberately distinct from `complete`: an operator who has
 * not recorded the receipt yet must not be told the challan is finished, which is
 * what treating "nothing pending" as "done" would say.
 */
export type InwardCompletion = 'not_received' | 'awaiting_inspection' | 'complete'

export function inwardCompletion(lines: Array<{
  received_qty: number
  inspection_required: boolean
  pending_inspection_qty: number
}>): InwardCompletion {
  if (lines.length === 0) return 'not_received'
  // A challan whose lines have all been received at zero has no receipt on it.
  // `received_qty > 0` rather than a null test, because a line nobody has
  // received is stored as 0, not null.
  if (!lines.some(line => (line.received_qty ?? 0) > 0)) return 'not_received'
  return lines.some(line => line.inspection_required && (line.pending_inspection_qty ?? 0) > 0)
    ? 'awaiting_inspection'
    : 'complete'
}

/**
 * How much of what was dispatched on a line the customer has not acknowledged.
 *
 * Floored at zero and never negative. `qty_delivered` is capped against
 * `qty_dispatched` by `confirm_delivery` under the item's row lock, so a
 * negative here would mean the two columns had been read from different
 * moments - which the header badge must never present as a real figure.
 */
export function deliveryBalance(dispatched: number, delivered: number): number {
  return toQty(Math.max(0, Math.max(0, dispatched) - Math.max(0, delivered)))
}

/**
 * Where an outward challan has got to, derived from its lines.
 *
 * The counterpart to `inwardCompletion`, and for the same reason: there is no
 * separate stored flag for "the customer has taken delivery", because arrival
 * at the customer is a fact about the quantities rather than a box somebody
 * ticks. `confirm_delivery` derives `dc_documents.status` the same way, so the
 * badge and the stored status cannot disagree.
 *
 * `not_dispatched` is deliberately distinct from `complete`: material that has
 * not left the plant must not be reported as delivered.
 */
export type OutwardCompletion =
  | 'not_dispatched' | 'awaiting_delivery' | 'partially_delivered' | 'complete'

export function outwardCompletion(lines: Array<{ qty_dispatched: number; qty_delivered: number }>): OutwardCompletion {
  if (lines.length === 0) return 'not_dispatched'
  // Nothing has left the plant. Zero rather than null in the database, so the
  // test is on the value and not on its absence.
  if (!lines.some(line => (line.qty_dispatched ?? 0) > 0)) return 'not_dispatched'

  const delivered = toQty(lines.reduce((sum, line) => sum + Math.max(0, line.qty_delivered ?? 0), 0))
  const outstanding = toQty(lines.reduce(
    (sum, line) => sum + deliveryBalance(line.qty_dispatched ?? 0, line.qty_delivered ?? 0), 0))

  if (outstanding <= 0) return 'complete'
  // Some acknowledged, some not. Kept distinct from awaiting_delivery because
  // the first needs chasing and the second has simply not happened yet.
  return delivered > 0 ? 'partially_delivered' : 'awaiting_delivery'
}

/** The four mutually exclusive outcomes one inspection of a line can record. */
export type InspectionOutcome = {
  accepted: number
  rejected: number
  rework: number
  pending: number
}

export const INSPECTION_KEYS = ['accepted', 'rejected', 'rework', 'pending'] as const
export type InspectionKey = typeof INSPECTION_KEYS[number]

/**
 * Quantities are numeric(14,3) in the database, so three decimals is the whole
 * story. Arithmetic on them has to round the same way or a field drifts to
 * 989.9999999999999 and a balance that is genuinely closed never reads as closed.
 */
function toQty(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** Sum of the four outcomes: what this inspection accounts for. */
export function outcomeTotal(outcome: InspectionOutcome): number {
  return toQty(INSPECTION_KEYS.reduce((sum, key) => sum + Math.max(0, outcome[key]), 0))
}

/**
 * What is still available to inspect on a line: what arrived, less everything
 * already judged - including material refused at the gate.
 *
 * The balance, not the raw received quantity, is what the four outcomes must add
 * up to. A second inspection measured against the received quantity would demand
 * outcomes for material the first one already accounted for.
 *
 * Mirrors record_material_inspection in 0022, where the same figure is
 * `received_qty - (accepted_qty + rejected_qty + rework_qty)`.
 */
export function inspectionBalance(
  receivedQty: number,
  judged = { accepted: 0, rejected: 0, rework: 0 },
): number {
  const total = Math.max(0, judged.accepted) + Math.max(0, judged.rejected) + Math.max(0, judged.rework)
  return toQty(Math.max(0, Math.max(0, receivedQty) - total))
}

/**
 * The order in which the *other* three fields give way when one of them grows.
 *
 * Pending goes first because it is the only bucket meaning "not judged yet" -
 * moving material into it costs nothing, whereas taking it back out of an
 * accepted or rejected quantity reverses a decision somebody already made.
 * Accepted is last for the same reason.
 */
const ABSORB_ORDER: readonly InspectionKey[] = ['pending', 'rework', 'rejected', 'accepted']

/**
 * The four outcomes after the operator edits one of them, always adding up to
 * exactly `balance`.
 *
 * This is what makes "accepted = received, so everything else is 0" fall out on
 * its own instead of being special-cased: typing the whole received quantity
 * into accepted leaves no room, and the remaining fields are emptied by the same
 * absorption that handles every other edit.
 *
 * Typing *less* than the balance puts the shortfall into pending, because
 * unjudged material is precisely what pending means. An inspector who has judged
 * 900 of 990 has 90 pending, not 90 missing.
 *
 * The edited field is capped at the balance, so a save can never carry more
 * outcomes than there was material. The database re-checks all of this.
 */
export function balanceInspectionOutcome(
  current: InspectionOutcome,
  key: InspectionKey,
  value: string | number,
  balance: number,
): InspectionOutcome {
  const room = toQty(Math.max(0, balance))
  const next: InspectionOutcome = { ...current }
  next[key] = Math.min(toQty(parseQty(String(value))), room)

  let excess = toQty(outcomeTotal(next) - room)
  if (excess > 0) {
    for (const other of ABSORB_ORDER) {
      if (other === key || excess <= 0) continue
      const take = Math.min(Math.max(0, next[other]), excess)
      next[other] = toQty(next[other] - take)
      excess = toQty(excess - take)
    }
  }

  const short = toQty(room - outcomeTotal(next))
  if (short > 0) next.pending = toQty(next.pending + short)
  return next
}

/**
 * What to show in the field the operator is typing into.
 *
 * The text is kept verbatim while it is within the balance, so a half-typed
 * "12." or "090" is not rewritten under the cursor mid-keystroke. It is
 * replaced by the applied number only when the two disagree - that is, when the
 * value had to be capped - because leaving "1200" on screen over a balance of
 * 990 would show a number that is not being saved.
 */
export function quantityText(raw: string, applied: number): string {
  return parseQty(raw) > applied ? String(applied) : raw
}

/**
 * Quantity still awaiting return, after a partial return.
 *
 * The example from the brief: 50 rejected, 30 returned, 20 still pending.
 * Treating the rejected figure as returned is the mistake this prevents.
 */
export function pendingReturn(rejected: number, returned: number, scrapped = 0): number {
  return Math.max(0, rejected - Math.max(0, returned) - Math.max(0, scrapped))
}

export type MachiningSplit = {
  accounted: number
  difference: number
  reconciled: boolean
  needsLossApproval: boolean
}

/**
 * Rule 5: input = accepted output + machining rejection + rework + scrap +
 * authorised loss.
 *
 * The difference is returned rather than discarded. When the units differ - raw
 * stock weight becoming finished pieces - the caller sets `unitConversion` and
 * the equation is not applied, because it would be meaningless.
 */
export function machiningSplit(
  input: number,
  accepted: number,
  rejection: number,
  rework: number,
  scrap: number,
  loss: number,
  options: { unitConversion?: boolean; unitsMatch?: boolean; lossReason?: string; lossApproved?: boolean } = {},
): MachiningSplit {
  const { unitConversion = false, unitsMatch = true, lossReason = '', lossApproved = false } = options
  const accounted = Math.max(0, accepted) + Math.max(0, rejection) + Math.max(0, rework) + Math.max(0, scrap) + Math.max(0, loss)
  const difference = Math.max(0, input) - accounted
  const applicable = !unitConversion && unitsMatch
  return {
    accounted,
    difference,
    reconciled: !applicable || Math.abs(difference) < 0.0005,
    needsLossApproval: Math.max(0, loss) > 0 && (!lossReason || !lossApproved),
  }
}

export type LedgerTotals = {
  received: number
  acceptedMaterial: number
  /** Accepted straight in as finished, bypassing machining. */
  acceptedFinishedInward: number
  rejectedMaterial: number
  pendingInspection: number
  machiningInput: number
  acceptedOutput: number
  machiningRejection: number
  dispatchedCustomerMaterial: number
  dispatchedFinishedStock: number
  dispatchedTotal: number
  /** Raw customer-owned material physically at the plant. Never negative. */
  availableCustomerMaterial: number
  /** Finished components physically at the plant. Never negative. */
  availableFinishedStock: number
  /** Material that left the plant with neither a receipt nor a machining result behind it. */
  unaccountedDispatch: number
}

export type LedgerInput = {
  /** What physically arrived at the gate. Reported, never re-derived. */
  received?: number
  /** Inward quantity inspection accepted, supply_source = customer_material. */
  acceptedMaterial?: number
  /** Inward quantity inspection accepted, supply_source = finished_stock. */
  acceptedFinishedInward?: number
  rejectedMaterial?: number
  pendingInspection?: number
  /** Raw material consumed by machining. */
  machiningInput?: number
  acceptedOutput?: number
  machiningRejection?: number
  /** Sent back without having been machined: raw material returned unprocessed. */
  dispatchedCustomerMaterial?: number
  /** Sent back from a line that was machined: finished pieces returned. */
  dispatchedFinishedStock?: number
}

/**
 * The two balances a job-work plant actually holds, kept apart.
 *
 * Each pool is drained only by what actually left that pool:
 *
 *   raw     = accepted material - machining input consumed - dispatched raw
 *   finished = machining output + accepted finished - dispatched finished
 *
 * The two are never subtracted from one another. Raw stock is not finished stock,
 * and a dispatch out of one pool cannot reduce the other. That separation is the
 * whole point: 90 raw consumed, 85 finished out, is 0 raw and 85 finished, not
 * "85 and 85" and certainly not one merged balance.
 *
 * Neither balance is ever negative. A pool can be over-drained when material went
 * out with no machining result or no receipt recorded behind it; that shortfall is
 * returned as `unaccountedDispatch` rather than shown as a stock level, because a
 * negative balance is not a quantity anything can hold.
 */
export function ledgerTotals(input: LedgerInput): LedgerTotals {
  const acceptedMaterial = Math.max(0, input.acceptedMaterial ?? 0)
  const acceptedFinishedInward = Math.max(0, input.acceptedFinishedInward ?? 0)
  const machiningInput = Math.max(0, input.machiningInput ?? 0)
  const acceptedOutput = Math.max(0, input.acceptedOutput ?? 0)
  const dispatchedCustomerMaterial = Math.max(0, input.dispatchedCustomerMaterial ?? 0)
  const dispatchedFinishedStock = Math.max(0, input.dispatchedFinishedStock ?? 0)

  const rawUsed = machiningInput + dispatchedCustomerMaterial
  const finishedAvailable = acceptedOutput + acceptedFinishedInward

  return {
    received: Math.max(0, input.received ?? 0),
    acceptedMaterial,
    acceptedFinishedInward,
    rejectedMaterial: Math.max(0, input.rejectedMaterial ?? 0),
    pendingInspection: Math.max(0, input.pendingInspection ?? 0),
    machiningInput,
    acceptedOutput,
    machiningRejection: Math.max(0, input.machiningRejection ?? 0),
    dispatchedCustomerMaterial,
    dispatchedFinishedStock,
    dispatchedTotal: dispatchedCustomerMaterial + dispatchedFinishedStock,
    availableCustomerMaterial: Math.max(0, toQty(acceptedMaterial - rawUsed)),
    availableFinishedStock: Math.max(0, toQty(finishedAvailable - dispatchedFinishedStock)),
    unaccountedDispatch: toQty(
      Math.max(0, rawUsed - acceptedMaterial) + Math.max(0, dispatchedFinishedStock - finishedAvailable),
    ),
  }
}

/**
 * Rule 6: a dispatch may not exceed the eligible balance of the pool it draws
 * from. `available` is whatever the server last reported; this is a courtesy
 * check that catches an obvious mistake before a round trip.
 */
export function canDispatch(available: number, requested: number): { ok: boolean; reason?: string } {
  if (!Number.isFinite(requested) || requested <= 0) return { ok: false, reason: 'Enter a quantity greater than zero.' }
  if (requested > available + 0.0005) {
    return { ok: false, reason: `Only ${available} is eligible for this customer and part.` }
  }
  return { ok: true }
}

/** Formats a quantity for display: no trailing zeros, at most 3 decimals. */
export function qty(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  const rounded = Math.round(value * 1000) / 1000
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

/**
 * Parses a quantity field. Blank and malformed input are both zero.
 *
 * Negative input becomes zero rather than being passed through. The split
 * helpers clamp negatives to zero before displaying them, so passing the raw
 * value on meant the screen showed shortage/excess computed from 0 while the
 * submission sent -5 and the database refused the whole batch. The database
 * rejects negatives outright (parse_numeric, min 0), so clamping here makes the
 * number on screen the number that is actually sent.
 */
export function parseQty(value: string): number {
  const n = Number(String(value).trim())
  if (!Number.isFinite(n)) return 0
  return n < 0 ? 0 : n
}

/**
 * Whether a quantity field holds a negative number.
 *
 * parseQty cannot answer this. It clamps negatives to zero on the way out, so
 * `parseQty(raw) < 0` is always false - which is exactly what the receipt form
 * did, making "quantities cannot be negative" a message that could never be
 * displayed while the database went on rejecting the save with a raw error.
 * This reads the raw value instead, and treats blank and malformed input as
 * zero so only a genuine negative counts.
 */
export function isNegativeQty(value: string): boolean {
  const n = Number(String(value).trim())
  return Number.isFinite(n) && n < 0
}

/**
 * Form courtesy check: the index of the first line whose quantity is not
 * greater than zero, or -1 when every line has a positive quantity.
 *
 * Blank, malformed and negative input all parse to 0 (parseQty), so they are
 * caught by the same test. The database still accepts `declared_qty = 0`
 * (`dc_items_declared_check` is `>= 0`), so this check - like canDispatch - is
 * what refuses the save in the browser, and it never replaces the authority of
 * the database. The caller is expected to take the operator to the line.
 */
export function firstLineWithoutQuantity(lines: { declared_qty: string }[]): number {
  return lines.findIndex(line => parseQty(line.declared_qty) <= 0)
}

/**
 * One line of a delivery being confirmed: what was dispatched, what has already
 * been acknowledged, and what the operator is typing now.
 */
export type DeliveryLine = {
  /** What left the plant on this line. */
  dispatched: number
  /** What the customer has already acknowledged on this line. */
  delivered: number
  /** What is being acknowledged now. */
  entering: number
}

export type DeliveryLinePreview = {
  /** What was dispatched and not yet acknowledged, before this delivery. */
  outstanding: number
  /** What is being acknowledged now. */
  entering: number
  /** Whether the figure entered is more than the customer can still take. */
  over: boolean
  /** What will still be outstanding once this delivery is recorded. */
  left: number
}

/**
 * What one line of a delivery looks like.
 *
 * The cap is what was dispatched and not yet acknowledged - a fact about the
 * challan, not about the form. This is the whole point of the function: an
 * earlier version compared the figure being typed against `dispatched minus
 * what was being typed`, so a line with 4950 outstanding and 4950 typed in it
 * calculated an outstanding of zero, refused the delivery with "0 NOS left",
 * and accepted anything up to half. The database has always compared against
 * the real outstanding, and the screen now does the same.
 *
 * The numbers are not the authority: `confirm_delivery` re-checks every figure
 * under the line's row lock and refuses anything larger.
 */
export function deliveryPreview(line: DeliveryLine): DeliveryLinePreview {
  const dispatched = Math.max(0, line.dispatched)
  const delivered = Math.max(0, line.delivered)
  const entering = Math.max(0, line.entering)
  const outstanding = toQty(Math.max(0, dispatched - delivered))
  return {
    outstanding,
    entering,
    over: entering > outstanding,
    left: toQty(Math.max(0, outstanding - entering)),
  }
}

/**
 * Whether a delivery closes its challan.
 *
 * It closes the challan when every line that had something outstanding has had
 * all of it acknowledged, and nothing was entered beyond what was
 * outstanding. A delivery that enters nothing closes nothing.
 *
 * This is the rule behind three things that have to agree: the button's label
 * ("Confirm and close challan" or "Record part-delivery"), whether the proof
 * of delivery is required, and the `delivered` flag sent to the database.
 * They used to be three separate readings of the same question, in a React
 * component, with nothing to test them against.
 */
export function deliveryClosesChallan(previews: Array<{ outstanding: number; entering: number; over: boolean }>): boolean {
  // A delivery of nothing closes nothing.
  if (!previews.some(line => line.entering > 0)) return false
  // More than the customer can take is refused, not a closing delivery.
  if (previews.some(line => line.over)) return false
  // A line with nothing outstanding is already done and does not hold the
  // challan open. Every other line must be acknowledged in full.
  return previews.every(line => line.outstanding <= 0 || line.entering >= line.outstanding)
}

/** The five outcomes one machining record can account for. */
export type MachiningOutcome = {
  /** What came out finished. */
  finished: number
  /** What the process spoiled. */
  rejection: number
  /** What has to go back for another operation. */
  rework: number
  /** What is scrap. */
  scrap: number
  /** What was lost, and had to be authorised. */
  loss: number
}

export type MachiningBalance = {
  /** What the record accounts for. */
  accounted: number
  /**
   * What is left of the input.
   *
   * Negative when the operator has accounted for more than went in, which is
   * the one thing this arithmetic refuses: a record cannot create material.
   */
  remaining: number
  /** Whether the record balances exactly. */
  reconciled: boolean
  /** Whether the operator has accounted for more than the input. */
  over: boolean
}

/**
 * How a machining record adds up.
 *
 * The input is finished machining, plus machining rejection, plus rework, plus
 * scrap, plus any authorised loss, plus whatever is left. The last of those is
 * the remaining, and it is worked out rather than typed: an input of 2000 with
 * 1900 finished, 10 rejected, 5 for rework and 5 scrapped leaves 80 that has
 * not been machined yet.
 *
 * A record with a remaining is a real thing - a batch that is part finished -
 * so it is allowed, and only a negative remaining is refused. The database
 * re-checks the whole equation when the record is written.
 */
export function machiningBalance(input: number, outcome: MachiningOutcome): MachiningBalance {
  const inQty = Math.max(0, input)
  const accounted = toQty(
    Math.max(0, outcome.finished)
    + Math.max(0, outcome.rejection)
    + Math.max(0, outcome.rework)
    + Math.max(0, outcome.scrap)
    + Math.max(0, outcome.loss),
  )
  const remaining = toQty(inQty - accounted)
  return {
    accounted,
    remaining,
    reconciled: Math.abs(remaining) < 0.0005,
    over: remaining < -0.0005,
  }
}