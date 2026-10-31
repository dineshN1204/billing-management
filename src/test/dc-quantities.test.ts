import { describe, expect, it } from 'vitest'
import {
  balanceInspectionOutcome,
  canDispatch,
  deliveryBalance,
  deliveryClosesChallan,
  deliveryPreview,
  firstLineWithoutQuantity,
  inwardCompletion,
  inspectionBalance,
  inspectionSplit,
  inspectionStatus,
  isNegativeQty,
  ledgerTotals,
  machiningBalance,
  machiningSplit,
  outcomeTotal,
  outwardCompletion,
  parseQty,
  pendingReturn,
  qty,
  quantityText,
  receiptSplit,
  type InspectionOutcome,
} from '../lib/dc-quantities'

/**
 * These mirror db/migrations/0016_dc_rpc.sql. Where the two disagree the
 * database wins, but a browser that disagrees with the database produces a form
 * that lies to the user, so the two are kept honest against each other by these
 * tests and by the SQL harness in tests/run-dc-tests.mjs.
 */

describe('Rule 1: physical receipt is not acceptance', () => {
  it('keeps the declared quantity and derives shortage from it', () => {
    expect(receiptSplit(1000, 990)).toEqual({
      declared: 1000, received: 990, shortage: 10, excess: 0, rejected: 0, pending: 990,
    })
  })

  it('records excess when more arrives than was declared', () => {
    expect(receiptSplit(100, 120)).toEqual({
      declared: 100, received: 120, shortage: 0, excess: 20, rejected: 0, pending: 120,
    })
  })

  it('treats an exact receipt as neither short nor excess', () => {
    const split = receiptSplit(500, 500)
    expect(split.shortage).toBe(0)
    expect(split.excess).toBe(0)
    expect(split.pending).toBe(500)
  })

  it('never reports a negative quantity for an over-delivery', () => {
    expect(receiptSplit(0, 40).shortage).toBe(0)
    expect(receiptSplit(10, -5).received).toBe(0)
  })

  it('measures shortage against what was declared, not against what survived rejection', () => {
    // 1000 declared, 990 arrived, 30 refused at the gate. The 10-piece shortage
    // is a delivery failure and must not be inflated to 40 by the rejection -
    // they are different facts about different things.
    const split = receiptSplit(1000, 990, 30)
    expect(split.shortage).toBe(10)
    expect(split.rejected).toBe(30)
  })

  it('leaves what remains for inspection equal to the receipt less the gate rejection', () => {
    expect(receiptSplit(1000, 990, 30).pending).toBe(960)
    expect(receiptSplit(1000, 990, 0).pending).toBe(990)
  })

  it('cannot reject more than arrived', () => {
    expect(receiptSplit(1000, 990, 5000).rejected).toBe(990)
    expect(receiptSplit(1000, 990, 5000).pending).toBe(0)
  })
})

describe('Rule 2: inspection reconciles against the quantity received', () => {
  it('sums the four outcomes into what was inspected', () => {
    const split = inspectionSplit(960, 20, 0, 10, 990)
    expect(split.inspected).toBe(990)
    expect(split.reconciled).toBe(true)
  })

  it('refuses an inspection that accounts for more than was received', () => {
    // 960 accepted + 20 rejected = 980 accounted against 990 received, with a
    // further 30 judged on this line. 1010 > 990 once pending is included, but
    // pending material has not been judged yet and is still physically present,
    // so the database does not count it against the ceiling.
    //
    // 0016_dc_rpc.sql line 971:
    //   accepted_qty + rejected_qty + rework_qty
    //     + v_accepted + v_rejected + v_rework > received_qty
    // and dc_items_inspection_within_receipt_check in 0014 lines 298-299.
    // This test used to assert `false` here, which disagreed with both, and made
    // the form warn "the database will refuse this" about a save it would accept.
    expect(inspectionSplit(960, 20, 0, 30, 990).reconciled).toBe(true)
  })

  it('still refuses an outcome total that exceeds the quantity received', () => {
    // The ceiling does apply to judged material: 960 + 40 = 1000 > 990.
    expect(inspectionSplit(960, 40, 0, 0, 990).reconciled).toBe(false)
  })

  it('refuses a second inspection measured only against its own increment', () => {
    // 960 already accepted; another 500 would put the total at 1460 against 990
    // received. An increment-only check would pass this, which is the bug.
    const split = inspectionSplit(500, 0, 0, 0, 990, { accepted: 960, rejected: 20, rework: 0 })
    expect(split.reconciled).toBe(false)
  })

  it('allows a partial inspection leaving the rest pending', () => {
    const split = inspectionSplit(500, 0, 0, 100, 990)
    expect(split.reconciled).toBe(true)
    expect(split.pending).toBe(100)
  })

  it('derives the status the same way the SQL does', () => {
    expect(inspectionStatus(960, 20, 0, 10)).toBe('partially_accepted')
    expect(inspectionStatus(0, 50, 0, 0)).toBe('rejected')
    expect(inspectionStatus(0, 0, 10, 0)).toBe('rework_required')
    expect(inspectionStatus(0, 0, 0, 10)).toBe('partially_inspected')
    expect(inspectionStatus(100, 0, 0, 0)).toBe('accepted')
  })
})

describe('Rule 2a: the four outcomes always add up to what is left to inspect', () => {
  const start = (over: Partial<InspectionOutcome> = {}): InspectionOutcome =>
    ({ accepted: 0, rejected: 0, rework: 0, pending: 0, ...over })

  it('measures the balance against everything already judged on the line', () => {
    // Mirrors record_material_inspection in 0022:
    //   received_qty - (accepted_qty + rejected_qty + rework_qty)
    expect(inspectionBalance(990)).toBe(990)
    expect(inspectionBalance(990, { accepted: 960, rejected: 20, rework: 0 })).toBe(10)
  })

  it('counts a gate rejection against the balance, because it arrived but was refused', () => {
    // 990 arrived, 30 refused at the gate, so 960 remain for an inspection.
    expect(inspectionBalance(990, { accepted: 0, rejected: 30, rework: 0 })).toBe(960)
  })

  it('never reports a negative balance once a line is over-inspected', () => {
    expect(inspectionBalance(990, { accepted: 990, rejected: 20, rework: 0 })).toBe(0)
  })

  it('empties every other outcome when accepted is set to the balance', () => {
    // The reported case: type the whole received quantity into accepted and the
    // rejected, rework and pending figures go to zero on their own.
    const after = balanceInspectionOutcome(start({ accepted: 900, pending: 90 }), 'accepted', '990', 990)
    expect(after).toEqual({ accepted: 990, rejected: 0, rework: 0, pending: 0 })
  })

  it('holds the sum at the balance whatever field is edited', () => {
    const line = start({ accepted: 960, pending: 30 })
    for (const key of ['accepted', 'rejected', 'rework', 'pending'] as const) {
      expect(outcomeTotal(balanceInspectionOutcome(line, key, '20', 990)), `${key} did not reconcile`).toBe(990)
    }
  })

  it('takes the shortfall into pending rather than rejecting material nobody judged', () => {
    // Judging 900 of 990 leaves 90 unjudged. That is what pending means; it is
    // not 90 missing and it is not 90 rejected.
    const after = balanceInspectionOutcome(start({ accepted: 990 }), 'accepted', '900', 990)
    expect(after).toEqual({ accepted: 900, rejected: 0, rework: 0, pending: 90 })
  })

  it('takes an increase out of pending before it touches an accepted or rejected figure', () => {
    // Reversing an accepted or rejected decision undoes a call somebody already
    // made; moving material back into pending costs nothing.
    const after = balanceInspectionOutcome(start({ accepted: 960, pending: 30 }), 'rejected', '20', 990)
    expect(after).toEqual({ accepted: 960, rejected: 20, rework: 0, pending: 10 })
  })

  it('caps a figure entered beyond the balance instead of refusing the save', () => {
    const after = balanceInspectionOutcome(start({ accepted: 900, pending: 90 }), 'accepted', '5000', 990)
    expect(after).toEqual({ accepted: 990, rejected: 0, rework: 0, pending: 0 })
  })

  it('reconciles a line already partly inspected against its balance, not the received quantity', () => {
    // 10 still to inspect. Typing all 10 in leaves nothing pending, rather than
    // demanding 990 outcomes against a 990 receipt.
    const balance = inspectionBalance(990, { accepted: 960, rejected: 20, rework: 0 })
    expect(outcomeTotal(balanceInspectionOutcome(start(), 'accepted', '10', balance))).toBe(10)
  })

  it('treats a blank or malformed entry as zero and still balances', () => {
    const after = balanceInspectionOutcome(start({ accepted: 990 }), 'accepted', '', 990)
    expect(after.pending).toBe(990)
    expect(outcomeTotal(after)).toBe(990)
  })

  it('keeps three-decimal quantities exact instead of drifting', () => {
    const after = balanceInspectionOutcome(start({ accepted: 0.1, pending: 0.2 }), 'accepted', '0.7', 1)
    expect(after).toEqual({ accepted: 0.7, rejected: 0, rework: 0, pending: 0.3 })
    expect(outcomeTotal(after)).toBe(1)
  })
})

describe('Typing a quantity field', () => {
  it('leaves a half-typed number alone rather than rewriting it under the cursor', () => {
    expect(quantityText('12.', 12)).toBe('12.')
    expect(quantityText('090', 90)).toBe('090')
  })

  it('shows the number that will actually be saved when it had to be capped', () => {
    // Leaving "5000" on screen over a balance of 990 would display a figure that
    // is not the one being submitted.
    expect(quantityText('5000', 990)).toBe('990')
  })
})

describe('Detecting a negative quantity', () => {
  it('sees a negative entry, which parseQty cannot', () => {
    expect(isNegativeQty('-5')).toBe(true)
    expect(isNegativeQty('-0.5')).toBe(true)
  })

  it('does not fire on blank, malformed or ordinary input', () => {
    expect(isNegativeQty('')).toBe(false)
    expect(isNegativeQty('   ')).toBe(false)
    expect(isNegativeQty('abc')).toBe(false)
    expect(isNegativeQty('0')).toBe(false)
    expect(isNegativeQty('12.5')).toBe(false)
  })

  it('is why the receipt form checks this instead of testing parseQty output', () => {
    // parseQty clamps negatives to zero on the way out, so the check the form
    // used to run was `0 < 0` and could never be true.
    expect(parseQty('-5')).toBe(0)
    expect(parseQty('-5') < 0).toBe(false)
    expect(isNegativeQty('-5')).toBe(true)
  })
})

describe('Partial returns', () => {
  it('keeps the remainder visible instead of calling it returned', () => {
    expect(pendingReturn(50, 30)).toBe(20)
  })

  it('never goes negative once everything is back', () => {
    expect(pendingReturn(50, 50)).toBe(0)
    expect(pendingReturn(50, 60)).toBe(0)
  })

  it('accounts for authorised scrap separately from a return', () => {
    expect(pendingReturn(50, 30, 5)).toBe(15)
  })
})

describe('Rule 5: machining input must reconcile', () => {
  it('accepts input equal to accepted output plus every recorded loss', () => {
    const split = machiningSplit(600, 560, 20, 10, 10, 0)
    expect(split.accounted).toBe(600)
    expect(split.reconciled).toBe(true)
  })

  it('refuses an unexplained difference instead of absorbing it', () => {
    const split = machiningSplit(600, 560, 20, 0, 0, 0)
    expect(split.difference).toBe(20)
    expect(split.reconciled).toBe(false)
  })

  it('accepts a process loss only when a reason is recorded', () => {
    expect(machiningSplit(100, 90, 0, 0, 0, 10).needsLossApproval).toBe(true)
    expect(machiningSplit(100, 90, 0, 0, 0, 10, { lossReason: 'swarf', lossApproved: true }).needsLossApproval).toBe(false)
  })

  it('does not apply the equation when the process converts units', () => {
    const split = machiningSplit(250, 900, 0, 0, 0, 0, { unitConversion: true, unitsMatch: false })
    expect(split.reconciled).toBe(true)
  })

  it('does not apply the equation when the units simply differ', () => {
    expect(machiningSplit(250, 900, 0, 0, 0, 0, { unitsMatch: false }).reconciled).toBe(true)
  })

  it('still applies the equation when the units match', () => {
    expect(machiningSplit(250, 900, 0, 0, 0, 0, { unitsMatch: true }).reconciled).toBe(false)
  })
})

describe('The ledger keeps the raw pool and the finished pool apart', () => {
  it('closes both pools when raw went in, came out as finished, and went back out', () => {
    // 90 raw accepted, all 90 consumed by machining, 85 accepted out, all 85
    // dispatched. Nothing is left in either pool. The 5 machining rejections are
    // already inside the 90 consumed, so counting them again would understate the
    // raw pool and is exactly the double-count this arithmetic avoids.
    const totals = ledgerTotals({
      acceptedMaterial: 90,
      machiningInput: 90,
      acceptedOutput: 85,
      machiningRejection: 5,
      dispatchedFinishedStock: 85,
    })

    expect(totals.availableCustomerMaterial).toBe(0)
    expect(totals.availableFinishedStock).toBe(0)
    expect(totals.unaccountedDispatch).toBe(0)
  })

  it('does not deduct a customer-material dispatch from the finished pool', () => {
    // 80 raw pieces sent back unprocessed, and 400 finished pieces sent back
    // processed. They are two different pools and each dispatch must drain only
    // its own. Deducting 480 from the finished pool is what produced a negative
    // balance in production.
    const totals = ledgerTotals({
      acceptedMaterial: 80,
      dispatchedCustomerMaterial: 80,
      acceptedOutput: 400,
      dispatchedFinishedStock: 400,
    })

    expect(totals.availableCustomerMaterial).toBe(0)
    expect(totals.availableFinishedStock).toBe(0)
    expect(totals.unaccountedDispatch).toBe(0)
  })

  it('reports raw stock as still at the plant when only finished goods went out', () => {
    // 1000 raw accepted and never machined; 400 finished pieces dispatched from a
    // different inward receipt. The raw pool must not shrink by the finished
    // dispatch, which is the error the two-pool design exists to prevent.
    const totals = ledgerTotals({
      acceptedMaterial: 1000,
      acceptedOutput: 400,
      dispatchedFinishedStock: 400,
    })

    expect(totals.availableCustomerMaterial).toBe(1000)
    expect(totals.availableFinishedStock).toBe(0)
  })

  it('counts material accepted directly as finished stock', () => {
    const totals = ledgerTotals({ acceptedFinishedInward: 75 })
    expect(totals.availableFinishedStock).toBe(75)
  })

  it('reports the accepted quantity as received rather than re-deriving it', () => {
    // The old mirror computed received as accepted + rejected + pending, which
    // silently ignored shortage and damage and could disagree with the row above
    // it on screen.
    const totals = ledgerTotals({ received: 990, acceptedMaterial: 960, rejectedMaterial: 20, pendingInspection: 10 })
    expect(totals.received).toBe(990)
  })
})

describe('The ledger never reports a negative balance', () => {
  it('floors finished stock at zero and names the unaccounted quantity', () => {
    // The reproduced production defect: 50 pieces dispatched for a part whose
    // machining result was never recorded, so accepted output reads zero and the
    // arithmetic produced -50. The balance floors; the gap is reported.
    const totals = ledgerTotals({ dispatchedFinishedStock: 50 })

    expect(totals.availableFinishedStock).toBe(0)
    expect(totals.unaccountedDispatch).toBe(50)
  })

  it('floors the raw pool too, when more raw was consumed than ever accepted', () => {
    const totals = ledgerTotals({ acceptedMaterial: 10, machiningInput: 90 })
    expect(totals.availableCustomerMaterial).toBe(0)
    expect(totals.unaccountedDispatch).toBe(80)
  })

  it('adds the shortfall from both pools into one figure', () => {
    const totals = ledgerTotals({
      acceptedMaterial: 0,
      machiningInput: 5,
      dispatchedFinishedStock: 30,
    })
    expect(totals.availableCustomerMaterial).toBe(0)
    expect(totals.availableFinishedStock).toBe(0)
    expect(totals.unaccountedDispatch).toBe(35)
  })

  it('reports no gap when the arithmetic balances', () => {
    const totals = ledgerTotals({
      acceptedMaterial: 100, machiningInput: 60, acceptedOutput: 55,
      dispatchedCustomerMaterial: 40, dispatchedFinishedStock: 55,
    })
    expect(totals.availableCustomerMaterial).toBe(0)
    expect(totals.availableFinishedStock).toBe(0)
    expect(totals.unaccountedDispatch).toBe(0)
  })
})

describe('Rule 6: dispatch cannot exceed the eligible balance', () => {
  it('allows a dispatch up to the balance', () => {
    expect(canDispatch(160, 160).ok).toBe(true)
    expect(canDispatch(160, 0).ok).toBe(false)
  })

  it('refuses a dispatch beyond the balance and says what is available', () => {
    const result = canDispatch(160, 400)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('160')
  })

  it('tolerates floating point noise on an exact quantity', () => {
    expect(canDispatch(160, 160.0004).ok).toBe(true)
  })
})

describe('Quantity display', () => {
  it('drops trailing zeros but keeps meaningful decimals', () => {
    expect(qty(1000)).toBe('1000')
    expect(qty(12.5)).toBe('12.5')
    expect(qty(12.3456)).toBe('12.346')
    expect(qty(0)).toBe('0')
    expect(qty(null)).toBe('—')
  })

  it('treats blank and malformed input as zero', () => {
    expect(parseQty('')).toBe(0)
    expect(parseQty('   ')).toBe(0)
    expect(parseQty('abc')).toBe(0)
    expect(parseQty('42.5')).toBe(42.5)
  })
})

describe('Rule: every line needs a quantity greater than zero', () => {
  it('accepts lines that all carry a positive quantity', () => {
    expect(firstLineWithoutQuantity([{ declared_qty: '1' }, { declared_qty: '12.5' }])).toBe(-1)
  })

  it('reports the first line whose quantity is zero or blank', () => {
    expect(firstLineWithoutQuantity([{ declared_qty: '10' }, { declared_qty: '0' }])).toBe(1)
    expect(firstLineWithoutQuantity([{ declared_qty: '' }])).toBe(0)
    expect(firstLineWithoutQuantity([{ declared_qty: '   ' }, { declared_qty: '4' }])).toBe(0)
    expect(firstLineWithoutQuantity([{ declared_qty: 'abc' }])).toBe(0)
  })

  it('reports a negative quantity, because parseQty clamps it to zero', () => {
    expect(firstLineWithoutQuantity([{ declared_qty: '5' }, { declared_qty: '-3' }])).toBe(1)
  })
})

describe('Rule: an inward challan is complete when every line has been judged', () => {
  it('is not_received before anything arrives', () => {
    expect(inwardCompletion([{ received_qty: 0, inspection_required: true, pending_inspection_qty: 0 }]))
      .toBe('not_received')
  })

  it('is not_received on a challan with no lines', () => {
    expect(inwardCompletion([])).toBe('not_received')
  })

  it('is awaiting_inspection while a line is unjudged', () => {
    expect(inwardCompletion([
      { received_qty: 200, inspection_required: true, pending_inspection_qty: 0 },
      { received_qty: 50, inspection_required: true, pending_inspection_qty: 50 },
    ])).toBe('awaiting_inspection')
  })

  it('is complete once every line is judged', () => {
    expect(inwardCompletion([
      { received_qty: 200, inspection_required: true, pending_inspection_qty: 0 },
      { received_qty: 50, inspection_required: true, pending_inspection_qty: 0 },
    ])).toBe('complete')
  })

  it('does not wait on a line nobody is going to inspect', () => {
    // 0022 made "inspection not required" accept the material on arrival, so
    // such a line has nothing pending and must not hold the challan open.
    expect(inwardCompletion([
      { received_qty: 200, inspection_required: false, pending_inspection_qty: 0 },
    ])).toBe('complete')
  })

  it('is not_received when a whole challan arrived at zero', () => {
    // Distinct from "complete": treating nothing pending as done would tell an
    // operator who has not recorded the receipt yet that the challan is finished.
    expect(inwardCompletion([
      { received_qty: 0, inspection_required: true, pending_inspection_qty: 0 },
      { received_qty: 0, inspection_required: false, pending_inspection_qty: 0 },
    ])).toBe('not_received')
  })

  it('still awaits inspection when one line is refused in full', () => {
    expect(inwardCompletion([
      { received_qty: 200, inspection_required: true, pending_inspection_qty: 100 },
    ])).toBe('awaiting_inspection')
  })
})

/**
 * The outward mirror of the rule above. `confirm_delivery` in 0025 derives
 * dc_documents.status from exactly these two columns, so this is not a separate
 * opinion: it is the same calculation the database performs, and these tests
 * pin the agreement.
 */
describe('Rule: an outward challan is delivered when everything dispatched has been acknowledged', () => {
  const line = (dispatched: number, delivered: number) => ({ qty_dispatched: dispatched, qty_delivered: delivered })

  it('reports what is still outstanding on a line', () => {
    expect(deliveryBalance(400, 0)).toBe(400)
    expect(deliveryBalance(400, 150)).toBe(250)
    expect(deliveryBalance(400, 400)).toBe(0)
  })

  it('never reports a negative balance, even if the two columns disagree', () => {
    // confirm_delivery caps delivered against dispatched under a row lock, so a
    // negative balance can only be a torn read. Showing "-50 outstanding" on a
    // header badge would be worse than showing nothing.
    expect(deliveryBalance(400, 450)).toBe(0)
    expect(deliveryBalance(0, 10)).toBe(0)
  })

  it('rounds to the three decimals the columns actually store', () => {
    expect(deliveryBalance(10, 2.3334)).toBe(7.667)
    expect(deliveryBalance(0.3, 0.1)).toBe(0.2)
  })

  it('is not_dispatched before anything has left the plant', () => {
    // Distinct from complete, for the same reason inwardCompletion separates
    // not_received from complete: material that has not moved cannot be
    // reported as having been delivered.
    expect(outwardCompletion([])).toBe('not_dispatched')
    expect(outwardCompletion([line(0, 0), line(0, 0)])).toBe('not_dispatched')
  })

  it('is awaiting_delivery when it has been dispatched but nothing acknowledged', () => {
    expect(outwardCompletion([line(400, 0)])).toBe('awaiting_delivery')
  })

  it('is partially_delivered when some of it has come back', () => {
    expect(outwardCompletion([line(400, 150)])).toBe('partially_delivered')
  })

  it('is complete only when every dispatched quantity is acknowledged', () => {
    expect(outwardCompletion([line(400, 400)])).toBe('complete')
    expect(outwardCompletion([line(400, 400), line(100, 100)])).toBe('complete')
  })

  it('does not add up the two lines to hide one that is short', () => {
    // 500 dispatched, 350 acknowledged. The total looks half done, but the
    // correct answer is "partially delivered", which is what per-line
    // outstanding is for.
    expect(outwardCompletion([line(400, 250), line(100, 100)])).toBe('partially_delivered')
  })

  it('does not let a line that was never dispatched hold the challan open', () => {
    // Material that never left is not outstanding. Holding the challan in
    // "partially delivered" over a line with nothing on it would leave the
    // pending-delivery report permanently non-empty.
    expect(outwardCompletion([line(400, 400), line(0, 0)])).toBe('complete')
  })

  it('is still partially delivered while any single line is short', () => {
    expect(outwardCompletion([line(400, 400), line(100, 40)])).toBe('partially_delivered')
  })
})

/**
 * The delivery panel.
 *
 * These are the numbers behind "More entered than is outstanding on UIFY-45
 * (0 NOS left)". The panel used to recompute the outstanding as `dispatched
 * minus what was being typed`, so entering the whole 4950 of a 4950 line
 * calculated an outstanding of zero and refused the delivery, while anything up
 * to half of it was accepted. The cap is the outstanding the challan had before
 * the delivery, and it does not move as the operator types.
 */
describe('Rule: a delivery cannot exceed what was dispatched and not yet acknowledged', () => {
  it('accepts the whole dispatched quantity in one go', () => {
    const preview = deliveryPreview({ dispatched: 4950, delivered: 0, entering: 4950 })
    expect(preview.outstanding).toBe(4950)
    expect(preview.over).toBe(false)
    expect(preview.left).toBe(0)
  })

  it('refuses more than the customer can still take, and says what is left', () => {
    const preview = deliveryPreview({ dispatched: 4950, delivered: 0, entering: 4951 })
    expect(preview.over).toBe(true)
    expect(preview.outstanding).toBe(4950)
  })

  it('leaves the rest outstanding on a part-delivery', () => {
    const preview = deliveryPreview({ dispatched: 4950, delivered: 0, entering: 2000 })
    expect(preview.over).toBe(false)
    expect(preview.left).toBe(2950)
  })

  it('measures against what is left after an earlier delivery', () => {
    const preview = deliveryPreview({ dispatched: 4950, delivered: 2000, entering: 2950 })
    expect(preview.outstanding).toBe(2950)
    expect(preview.over).toBe(false)
    expect(preview.left).toBe(0)
  })

  it('refuses a second delivery of material already acknowledged', () => {
    const preview = deliveryPreview({ dispatched: 4950, delivered: 4950, entering: 100 })
    expect(preview.outstanding).toBe(0)
    expect(preview.over).toBe(true)
  })

  it('never reports a negative balance, even if the two columns disagree', () => {
    const preview = deliveryPreview({ dispatched: 100, delivered: 150, entering: 0 })
    expect(preview.outstanding).toBe(0)
    expect(preview.left).toBe(0)
  })
})

/**
 * Whether the delivery closes the challan.
 *
 * Three things have to agree on that: the button's label, whether the proof of
 * delivery is required, and the `delivered` flag the panel sends to the
 * database. The flag used to be left out, and the database reads an absent
 * flag as true - which made the reference compulsory on every delivery while
 * the panel said it was optional for a part-delivery.
 */
describe('Rule: a delivery closes the challan only when everything outstanding is acknowledged', () => {
  const preview = (dispatched: number, delivered: number, entering: number) =>
    deliveryPreview({ dispatched, delivered, entering })

  it('closes when the whole dispatched quantity is acknowledged in one go', () => {
    expect(deliveryClosesChallan([preview(4950, 0, 4950)])).toBe(true)
  })

  it('closes when the last outstanding quantity is acknowledged', () => {
    // 2000 already acknowledged, the remaining 2950 taken now.
    expect(deliveryClosesChallan([preview(4950, 2000, 2950)])).toBe(true)
  })

  it('does not close on a part-delivery', () => {
    expect(deliveryClosesChallan([preview(4950, 0, 2000)])).toBe(false)
  })

  it('does not close when more is entered than the customer can take', () => {
    // Refused by the database, and not a closing delivery either.
    expect(deliveryClosesChallan([preview(4950, 0, 4951)])).toBe(false)
  })

  it('does not close on a delivery of nothing', () => {
    expect(deliveryClosesChallan([preview(4950, 0, 0)])).toBe(false)
    expect(deliveryClosesChallan([])).toBe(false)
  })

  it('does not let a line that was never dispatched hold the challan open', () => {
    // Nothing was dispatched on the second line, so it is not outstanding and
    // must not keep the challan from closing.
    expect(deliveryClosesChallan([preview(4950, 0, 4950), preview(0, 0, 0)])).toBe(true)
  })

  it('does not close while a single line is still short', () => {
    expect(deliveryClosesChallan([preview(4950, 0, 4950), preview(100, 0, 40)])).toBe(false)
  })
})

/**
 * The machining panel.
 *
 * The input is finished machining, plus machining rejection, plus rework, plus
 * scrap, plus any authorised loss, plus whatever is left. The left-over
 * quantity is worked out rather than typed, and a batch that is part finished
 * is a record that balances.
 */
describe('Rule: a machining record accounts for the whole input', () => {
  it('works out what is left of the input', () => {
    const balance = machiningBalance(2000, { finished: 1900, rejection: 10, rework: 5, scrap: 5, loss: 0 })
    expect(balance.accounted).toBe(1920)
    expect(balance.remaining).toBe(80)
    expect(balance.reconciled).toBe(false)
    expect(balance.over).toBe(false)
  })

  it('reconciles when everything is accounted for', () => {
    const balance = machiningBalance(2000, { finished: 1980, rejection: 10, rework: 5, scrap: 5, loss: 0 })
    expect(balance.remaining).toBe(0)
    expect(balance.reconciled).toBe(true)
  })

  it('counts an authorised loss as part of the input', () => {
    const balance = machiningBalance(2000, { finished: 1900, rejection: 10, rework: 5, scrap: 5, loss: 80 })
    expect(balance.remaining).toBe(0)
    expect(balance.reconciled).toBe(true)
  })

  it('refuses a record that accounts for more than the input', () => {
    const balance = machiningBalance(2000, { finished: 2000, rejection: 10, rework: 5, scrap: 5, loss: 0 })
    expect(balance.over).toBe(true)
    expect(balance.remaining).toBe(-20)
  })

  it('treats an empty form as a record that has accounted for nothing', () => {
    const balance = machiningBalance(2000, { finished: 0, rejection: 0, rework: 0, scrap: 0, loss: 0 })
    expect(balance.accounted).toBe(0)
    expect(balance.remaining).toBe(2000)
    expect(balance.over).toBe(false)
  })

  it('rounds to the three decimals the columns actually store', () => {
    const balance = machiningBalance(10, { finished: 2.3334, rejection: 0, rework: 0, scrap: 0, loss: 0 })
    expect(balance.accounted).toBe(2.333)
    expect(balance.remaining).toBe(7.667)
  })
})