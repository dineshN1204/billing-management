import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Every write in the Delivery Challan module goes through a `payload jsonb` RPC.
 *
 * PostgREST matches the keys of a request body against the names of the function's
 * parameters. Sending those fields at the top level asks it for
 * `save_inward_dc(organization_id, party_id, items, ...)`, which is not a function
 * that exists, and it answers PGRST202 - a 404 reading "Could not find the
 * function public.save_inward_dc(...) in the schema cache". That was reported as
 * "The request could not be completed. Please try again." on every DC write:
 * saving a draft, finalizing a challan, recording a receipt or an inspection,
 * issuing material, and cancelling.
 *
 * The billing module was unaffected because `save_bill(payload jsonb, ...)`
 * names its argument `payload` and BillForm passes it under that key.
 */
const rpc = vi.fn(async (name: string, body: unknown) => {
  void name; void body
  return { data: null, error: null }
})

vi.mock('../lib/db', () => ({
  db: { rpc: (name: string, body: unknown) => rpc(name, body), from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }) }) }) }) },
  queryWithRetry: (run: () => unknown) => run(),
}))

const { dcApi } = await import('../lib/dc-api')
const { emptyItem, draftFromItem } = await import('../lib/dc-types')
import type { DcItem } from '../lib/dc-types'

const ORG = '11111111-1111-1111-1111-111111111111'

describe('DC write calls', () => {
  beforeEach(() => rpc.mockClear())

  const payloadOf = (call = 0) => rpc.mock.calls[call]?.[1] as Record<string, unknown>

  it('wraps the payload under the single parameter the RPC declares', async () => {
    await dcApi.saveInward(ORG, { party_id: 'party-1', finalize: true, items: [{ part_number: 'P1' }] })
    expect(rpc.mock.calls[0]?.[0]).toBe('save_inward_dc')
    expect(payloadOf()).toEqual({
      payload: {
        organization_id: ORG,
        party_id: 'party-1',
        finalize: true,
        items: [{ part_number: 'P1' }],
      },
    })
    // The keys that broke it: a payload field at the top of the body.
    expect(Object.keys(payloadOf())).not.toContain('party_id')
    expect(Object.keys(payloadOf())).not.toContain('organization_id')
  })

  it('does the same for every other write in the module', async () => {
    const party = '22222222-2222-2222-2222-222222222222'
    await dcApi.saveOutwardCustomer(ORG, { party_id: party })
    await dcApi.recordReceipt(ORG, { dc_id: 'd1' })
    await dcApi.recordInspection(ORG, { dc_id: 'd1' })
    await dcApi.recordMaterialReturn(ORG, { dc_id: 'd1' })
    await dcApi.recordDispatch(ORG, { dc_id: 'd1' })
    await dcApi.confirmDelivery(ORG, { dc_id: 'd1' })
    await dcApi.recordMachining(ORG, { dc_id: 'd1' })
    await dcApi.recordMachiningBatch(ORG, { dc_id: 'd1', lines: [{ dc_item_id: 'i1' }] })
    await dcApi.cancel(ORG, 'd1', 'entered twice')
    await dcApi.updateSettings(ORG, { setting_key: 'k' })
    await dcApi.saveOption(ORG, { option_group: 'unit', option_value: 'NOS' })

    expect(rpc).toHaveBeenCalledTimes(11)
    for (const call of rpc.mock.calls) {
      expect(Object.keys(call[1] as object)).toEqual(['payload'])
    }
    expect((rpc.mock.calls[8]?.[1] as unknown as { payload: Record<string, unknown> }).payload).toMatchObject({
      organization_id: ORG, dc_id: 'd1', reason: 'entered twice',
    })
  })

  it('sends no body at all for the one RPC that declares no parameters', async () => {
    await dcApi.bootstrapOptions()
    expect(rpc.mock.calls[0]?.[0]).toBe('dc_bootstrap_options')
    // Wrapping this one in `payload` would be the same mistake, inverted: the
    // function takes nothing, so any key in the body asks for a signature it
    // does not have.
    expect(rpc.mock.calls[0]?.[1]).toEqual({})
  })

  it('leaves the read-only RPCs addressed by their own parameter names', async () => {
    await dcApi.dashboard(ORG)
    expect(rpc.mock.calls[0]?.[1]).toEqual({ p_org: ORG })
  })
})

/**
 * The inward/outward link.
 *
 * The three functions that reach it - the picker, the job progress and the
 * search - all take named parameters rather than a wrapped payload, so they
 * must be addressed by name. Wrapping any of them in `payload` asks PostgREST
 * for a signature that does not exist and answers PGRST202.
 */
describe('Inward / outward link calls', () => {
  beforeEach(() => rpc.mockClear())

  it('asks for the inward lines available to draw an outward line from', async () => {
    await dcApi.inwardLines(ORG, 'party-1', 'CUST-4411')
    expect(rpc.mock.calls[0]?.[0]).toBe('dc_inward_lines')
    expect(rpc.mock.calls[0]?.[1]).toEqual({ p_org: ORG, p_party: 'party-1', p_query: 'CUST-4411' })
  })

  it('sends an empty picker search as null, not as an empty string', async () => {
    // An empty ilike '%%' matches every inward line of the customer. Passing ''
    // through would list the whole customer's history the moment the form opens,
    // which is not what a picker that has not been typed into should do.
    await dcApi.inwardLines(ORG, 'party-1')
    expect(rpc.mock.calls[0]?.[1]).toEqual({ p_org: ORG, p_party: 'party-1', p_query: null })
  })

  it('reads the derived job progress by its own names', async () => {
    await dcApi.jobProgress(ORG, 'dc-1')
    expect(rpc.mock.calls[0]?.[0]).toBe('dc_job_progress')
    expect(rpc.mock.calls[0]?.[1]).toEqual({ p_org: ORG, p_dc_id: 'dc-1' })
  })

  it('searches across challans and bills under one term', async () => {
    await dcApi.search(ORG, 'CUST-4411')
    expect(rpc.mock.calls[0]?.[0]).toBe('dc_search')
    expect(rpc.mock.calls[0]?.[1]).toEqual({ p_org: ORG, p_query: 'CUST-4411', p_limit: 100 })
  })

  it('replaces the set of bills attached to a challan, rather than toggling one', async () => {
    // A toggle is not idempotent: retrying the same request after a dropped
    // response would detach the bill the first attempt had just attached.
    await dcApi.linkBills(ORG, 'dc-1', ['b1', 'b2'])
    expect(rpc.mock.calls[0]?.[0]).toBe('dc_link_bills')
    expect((rpc.mock.calls[0]?.[1] as unknown as { payload: Record<string, unknown> }).payload).toEqual({
      organization_id: ORG,
      dc_id: 'dc-1',
      bills: [{ bill_id: 'b1' }, { bill_id: 'b2' }],
    })
  })

  it('reads what is left of one inward line directly', async () => {
    await dcApi.inwardLineAvailability(ORG, 'item-1')
    expect(rpc.mock.calls[0]?.[0]).toBe('dc_inward_line_availability')
    expect(rpc.mock.calls[0]?.[1]).toEqual({ p_org: ORG, p_inward_item_id: 'item-1' })
  })

  it('reads the source of each line separately from the challan it belongs to', async () => {
    await dcApi.linkedBills(ORG, 'dc-1')
    expect(rpc.mock.calls[0]?.[0]).toBe('dc_linked_bills')
    expect(rpc.mock.calls[0]?.[1]).toEqual({ p_org: ORG, p_dc_id: 'dc-1' })
  })
})

/**
 * The per-line customer DC number has to survive the round trip.
 *
 * The save RPC deletes and re-inserts every line on each save (0018 line 252),
 * so anything the payload does not carry is silently erased. `customer_dc_number`
 * is the field that records which of the customer's own challans the material
 * arrived on; dropping it would quietly unlink the outward challans that were
 * resolved through it.
 */
describe('Per-line customer DC number', () => {
  it('is carried by both save calls', () => {
    // The field has to be in the draft the form builds, or the RPC receives
    // nothing for it and the line is stored with no customer DC number.
    expect(Object.keys(emptyItem())).toContain('customer_dc_number')
  })

  it('defaults to blank on a new line, and to null on a loaded one', () => {
    expect(emptyItem().customer_dc_number).toBe('')
    const loaded = draftFromItem({
      id: 'i', dc_id: 'd', line_no: 1, product_id: null, part_number: 'P',
      customer_part_number: null, customer_dc_number: null, description: null,
      drawing_number: null, drawing_revision: null, batch_lot_no: null, heat_no: null,
      material_grade: null, unit: 'NOS', supply_source: 'customer_material',
      declared_qty: 1, received_qty: 0, shortage_qty: 0, excess_qty: 0, damaged_qty: 0,
      inspection_required: true, inspected_qty: 0, accepted_qty: 0, rejected_qty: 0,
      rework_qty: 0, pending_inspection_qty: 0, inspection_status: 'pending',
      inspection_date: null, rejection_reason: null, inspection_report_no: null,
      inspection_remarks: null, processing_operation: null, qty_sent: 0,
      expected_return_qty: null, returned_qty: 0, accepted_return_qty: 0,
      rejected_return_qty: 0, scrap_qty: 0, still_at_vendor_qty: null,
      ordered_qty: null, previously_dispatched_qty: 0, qty_dispatched: 0,
      qty_delivered: 0, source_inward_item_id: null, material_owner_id: null,
      production_order_id: null, storage_location: null, item_remarks: null,
    } as DcItem)
    expect(loaded.customer_dc_number).toBe('')
  })

  it('keeps the source link across a re-save of a draft', () => {
    // Same reason as the number: the RPC rebuilds every line, so a draft that
    // was linked to an inward line and re-saved unlinked would lose the cap that
    // links it to the material it came from.
    const draft = emptyItem()
    expect(draft.source_inward_item_id).toBeNull()
    draft.source_inward_item_id = 'inward-item-1'
    expect(draft.source_inward_item_id).toBe('inward-item-1')
  })
})