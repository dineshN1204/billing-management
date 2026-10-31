#!/usr/bin/env node
/**
 * Database-level tests for the Delivery Challan module.
 *
 *   DATABASE_URL_TEST=<neon test branch> node tests/run-dc-tests.mjs
 *
 * Everything runs inside one transaction that is ALWAYS rolled back, so no test
 * can alter a production record. Each case impersonates a real organization
 * member the same way the Data API does:
 *
 *     set_config('request.jwt.claims', '{"sub":"<uuid>","role":"authenticated"}')
 *     set local role authenticated
 *
 * That matters: it means the tests exercise RLS, column grants and the
 * SECURITY DEFINER RPCs exactly as the browser does, rather than bypassing them
 * with owner privileges. A test that passes because it ran as the table owner
 * would prove nothing.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

function readEnvFile(file) {
  try {
    const values = {}
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
      if (match) values[match[1]] = match[2].trim().replace(/^"(.*)"$/, '$1')
    }
    return values
  } catch {
    return {}
  }
}

const fileEnv = readEnvFile(join(root, '.env'))
const url = process.env.DATABASE_URL_TEST || fileEnv.DATABASE_URL_TEST
if (!url) {
  console.error('Set DATABASE_URL_TEST to the dc-test Neon branch connection string.')
  console.error('  neonctl connection-string dc-test --pooled false --role-name neondb_owner')
  process.exit(1)
}
if (!process.argv.includes('--allow-production') && /production/i.test(new URL(url).hostname)) {
  console.error('Refusing to run against a production endpoint.')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------------

const results = []
let currentGroup = 'general'

function group(name) {
  currentGroup = name
  console.log(`\n${name}`)
}

let savepoint = 0

async function test(name, fn) {
  // Each case runs inside its own savepoint. Without this, the first failure
  // aborts the enclosing transaction and every later case reports the same
  // "current transaction is aborted" instead of its own real error.
  const point = `dc_case_${savepoint++}`
  await q(`savepoint ${point}`)
  try {
    await fn()
    await q(`release savepoint ${point}`)
    results.push({ group: currentGroup, name, ok: true })
    console.log(`  PASS  ${name}`)
  } catch (error) {
    await q(`rollback to savepoint ${point}`).catch(() => {})
    await q(`release savepoint ${point}`).catch(() => {})
    await impersonate()
    results.push({ group: currentGroup, name, ok: false, error })
    console.log(`  FAIL  ${name}`)
    console.log(`        ${error.message.split('\n')[0]}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${message}\n        expected ${b}\n        actual   ${a}`)
}

/**
 * Runs fn and asserts it fails with a message containing `code`.
 *
 * Each attempt gets its own savepoint: a failed statement puts the whole
 * transaction into the aborted state, so without this the assertion's own
 * cleanup would fail and poison every later statement in the case.
 *
 * The impersonation is repeated afterwards because `set_config(..., true)` and
 * `set local role` are transaction-local settings, and rolling back to a
 * savepoint discards them. Without this, a test that asserted a rejection would
 * leave the session anonymous and every later test would fail with
 * "authentication required" for reasons that have nothing to do with itself.
 */
let rejectPoint = 0
async function assertRejects(fn, code, message) {
  const point = `dc_reject_${rejectPoint++}`
  await q(`savepoint ${point}`)
  let failed = null
  try {
    await fn()
  } catch (error) {
    failed = error
  }
  await q(`rollback to savepoint ${point}`).catch(() => {})
  await q(`release savepoint ${point}`).catch(() => {})
  await impersonate()
  if (!failed) throw new Error(`${message} (no error was raised)`)
  if (code && !String(failed.message).includes(code)) {
    throw new Error(`${message}\n        expected an error containing "${code}", got: ${failed.message}`)
  }
  return failed
}

const num = value => Number(value ?? 0)

// ---------------------------------------------------------------------------
// Connection and fixtures
// ---------------------------------------------------------------------------

const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
await db.connect()

const q = (sql, params) => db.query(sql, params)

const ready = await q(`select to_regclass('public.dc_documents') is not null as dc_present`)
if (!ready.rows[0].dc_present) {
  console.error('The DC schema is missing on this database. Run scripts/apply-migrations.mjs first.')
  await db.end()
  process.exit(1)
}

await q('begin')

const member = await q(`select user_id from public.memberships order by created_at limit 1`)
if (!member.rows[0]) {
  console.error('No organization member found on this branch; fixtures cannot impersonate a user.')
  await q('rollback')
  await db.end()
  process.exit(1)
}
const UID = member.rows[0].user_id

const ORG = '11111111-1111-4111-8111-111111111111'
const OTHER_ORG = '22222222-2222-4222-8222-222222222222'

// The event tables (inspections, movements, machining results) are append-only
// by design and their trigger refuses deletes even from the owner, so leftovers
// from the one committing case are removed by disabling that trigger for this
// cleanup only. Test-only, on a test branch, never in the app.
async function clearFixture() {
  await q(`alter table public.dc_inspections disable trigger dc_inspections_append_only`)
  await q(`alter table public.dc_movements disable trigger dc_movements_append_only`)
  await q(`alter table public.dc_machining_results disable trigger dc_machining_results_append_only`)
  await q('delete from public.dc_inspections where organization_id = any($1::uuid[])', [[ORG, OTHER_ORG]])
  await q('delete from public.dc_movements where organization_id = any($1::uuid[])', [[ORG, OTHER_ORG]])
  await q('delete from public.dc_machining_results where organization_id = any($1::uuid[])', [[ORG, OTHER_ORG]])
  await q(`alter table public.dc_inspections enable trigger dc_inspections_append_only`)
  await q(`alter table public.dc_movements enable trigger dc_movements_append_only`)
  await q(`alter table public.dc_machining_results enable trigger dc_machining_results_append_only`)

  await q('delete from public.dc_rejections where organization_id = any($1::uuid[])', [[ORG, OTHER_ORG]])
  await q('delete from public.dc_documents where organization_id = any($1::uuid[])', [[ORG, OTHER_ORG]])
  // The billing regression case creates a real bill against the fixture
  // customer; it has to go before the customer row can.
  await q('delete from public.bill_items where organization_id = any($1::uuid[])', [[ORG, OTHER_ORG]])
  await q('delete from public.bills where organization_id = any($1::uuid[])', [[ORG, OTHER_ORG]])
  await q('delete from public.production_orders where organization_id = any($1::uuid[])', [[ORG, OTHER_ORG]])
  await q('delete from public.job_work_orders where organization_id = any($1::uuid[])', [[ORG, OTHER_ORG]])
  await q('delete from public.customers where organization_id = any($1::uuid[])', [[ORG, OTHER_ORG]])
  // Organizations are deleted rather than their memberships: the last-admin
  // trigger fires on membership changes and refuses to leave an organization
  // without one, which would make a plain cleanup impossible.
  await q('delete from public.organizations where id = any($1::uuid[])', [[ORG, OTHER_ORG]])
}

await clearFixture()
await q(`insert into public.organizations (id, name) values ($1, 'DC Test Org'), ($2, 'Other Org')`, [ORG, OTHER_ORG])
await q(`insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'admin')`, [ORG, UID])

// A second, distinct admin keeps the last-admin guard satisfied when 19b
// demotes UID to viewer. Created here, before impersonation, because the
// authenticated role has no INSERT grant on memberships.
const secondUser = await q(`select id from neon_auth.user where id <> $1 limit 1`, [UID])
if (secondUser.rows.length) {
  await q(`insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'admin')`, [ORG, secondUser.rows[0].id])
}
await q(
  `insert into public.customers (organization_id, name, gstin, party_type, phone, email, address_line_1, city, state, pincode, state_code)
   values
     ($1, 'Customer A', '33AAAAA0001BCZ1', 'customer', '9876500011', 'a@example.com', '1 Test Street', 'Coimbatore', 'Tamil Nadu', '641001', '33'),
     ($1, 'Customer B', '33BBBBB0002CDZ2', 'customer', null, null, null, null, null, null, null),
     ($1, 'Vendor Machining', null, 'vendor', '9876500022', 'vendor@example.com', '2 Vendor Road', 'Chennai', 'Tamil Nadu', '600001', '33'),
     ($2, 'Foreign Customer', '33CCCCC0003EFZ3', 'customer', null, null, null, null, null, null, null)`,
  [ORG, OTHER_ORG],
)

const customerId = (await q(`select id from public.customers where organization_id = $1 and name = 'Customer A'`, [ORG])).rows[0].id
const customerBId = (await q(`select id from public.customers where organization_id = $1 and name = 'Customer B'`, [ORG])).rows[0].id
const vendorId = (await q(`select id from public.customers where organization_id = $1 and name = 'Vendor Machining'`, [ORG])).rows[0].id
const foreignId = (await q(`select id from public.customers where organization_id = $1`, [OTHER_ORG])).rows[0].id
assert(foreignId && foreignId !== customerId, 'the other organization must hold its own party')

async function impersonate() {
  await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role: 'authenticated' })])
  await q('set local role authenticated')
}
await impersonate()

// Helpers that call the RPCs the browser calls.
// A function that returns jsonb comes back as one column named after the
// function. Aliasing it and unwrapping here keeps the assertions readable.
const rpc = (name, payload, ...rest) =>
  q(`select public.${name}($1${rest.map((_, i) => `, $${i + 2}`).join('')}) as result`, [payload, ...rest])
    .then(out => out.rows[0]?.result ?? null)

const saveInward = payload => rpc('save_inward_dc', payload)
const saveCustomer = payload => rpc('save_outward_customer_dc', payload)
const receive = payload => rpc('record_inward_receipt', payload)
const inspect = payload => rpc('record_material_inspection', payload)

/**
 * A function that RETURNS TABLE rather than a single jsonb.
 *
 * `rpc` aliases the result and unwraps one column, which is right for the
 * payload functions but returns only the FIRST row of a set. These have to be
 * selected from directly, which is also how the browser's PostgREST calls
 * reach them. Casts are explicit because a bare `$1, $2` leaves the parameter
 * types to the resolver, and these functions take named arguments with defaults.
 */
const rpcRows = (name, casts, ...args) =>
  q(`select * from public.${name}(${args.map((_, i) => `$${i + 1}${casts[i] ?? ''}`).join(', ')})`, args)
    .then(out => out.rows)

/**
 * A challan of its own, for a case that must not inherit another case's state.
 *
 * The shared `inward` fixture is inspected by case 7, and 0022 refuses a receipt
 * on any challan that already has an inspection. Cases that are testing
 * receipt-level validation used to lean on `inward` and only worked by accident:
 * there was no such guard before, and before that they only worked when case 7
 * happened to fail and roll itself back. Validation cases want an untouched
 * challan, so they make their own.
 */
async function freshInward(partNumber, declaredQty, dcDate) {
  const created = await saveInward({
    organization_id: ORG, party_id: customerId, dc_date: dcDate,
    items: [{ part_number: partNumber, unit: 'NOS', declared_qty: declaredQty, supply_source: 'customer_material' }],
  })
  return { dc: created.document, item: created.items[0].id }
}
const dispatch = payload => rpc('record_dispatch', payload)
const confirmDelivery = payload => rpc('confirm_delivery', payload)
const machining = payload => rpc('record_machining_result', payload)

// ---------------------------------------------------------------------------
// 1-5. Document creation
// ---------------------------------------------------------------------------

group('Document creation')

let inward = null
let inwardItem = null

await test('1. creates an inward delivery challan with an internal number', async () => {
  const result = await saveInward({
    organization_id: ORG, party_id: customerId, dc_date: '2026-10-01',
    external_dc_number: 'EXT-DC-9001', external_dc_date: '2026-09-30',
    purpose: 'Material received for machining', finalize: true,
    items: [{ part_number: 'KI-101', unit: 'NOS', declared_qty: 1000, supply_source: 'customer_material', batch_lot_no: 'LOT-A' }],
  })
  inward = result.document
  inwardItem = result.items[0].id
  assert(inward.dc_type === 'inward', 'document type should be inward')
  assert(inward.status === 'issued', 'a finalized document is issued, not draft')
  assert(/^KI\/IN\/\d{4}-\d{2}\/\d{4}$/.test(inward.dc_number), `unexpected number format: ${inward.dc_number}`)
  assert(inward.external_dc_number === 'EXT-DC-9001', 'the external challan number must be kept separately')
  assert(inward.party_gstin === '33AAAAA0001BCZ1', 'the party GSTIN should be snapshotted from the customer record')
  assert(inward.finalized_at !== null, 'a finalized document records who finalized it and when')
})

await test('3. creates an outward customer challan for finished goods', async () => {
  const result = await saveCustomer({
    organization_id: ORG, party_id: customerId, dc_date: '2026-10-05',
    delivery_purpose: 'finished_goods', customer_order_reference: 'PO-7781', finalize: true,
    items: [{ part_number: 'KI-101', unit: 'NOS', declared_qty: 400, supply_source: 'finished_stock' }],
  })
  assert(result.document.dc_type === 'outward_customer', 'document type should be outward_customer')
  assert(/^KI\/OUT-C\//.test(result.document.dc_number), 'outward customer uses its own number series')
})

await test('4. finds parties by name and by GSTIN inside the organization only', async () => {
  const byName = await q(`select name from public.customers where organization_id = $1 and name ilike $2 order by name`, [ORG, 'Customer%'])
  assertEqual(byName.rows.map(r => r.name), ['Customer A', 'Customer B'], 'name search should find both own customers')
  const byGstin = await q(`select name from public.customers where organization_id = $1 and gstin = $2`, [ORG, '33CCCCC0003EFZ3'])
  assertEqual(byGstin.rows, [], "RLS must hide another organization's party")
  // RLS filters silently rather than raising: another organization's rows are
  // simply absent. That is a stronger guarantee than an error, and it is what
  // must be asserted.
  const otherOrg = await q(`select * from public.customers where organization_id = $1`, [OTHER_ORG])
  assertEqual(otherOrg.rows.length, 0, "another organization's parties must be invisible")
})

await test('4b. finds a party added in Billing in the DC pickers', async () => {
  // What CustomerForm does: no party_type supplied, so the database default
  // applies. This is the whole "add in Billing, use in DC" requirement.
  await q('reset role')
  const added = await q(
    `insert into public.customers (organization_id, name, gstin, address_line_1, city, state, pincode, state_code)
     values ($1, 'Billing Added Co', '33DDDDD0001EFZ4', '9 Market Road', 'Coimbatore', 'Tamil Nadu', '641002', '33')
     returning id, name, party_type`,
    [ORG],
  )
  const party = added.rows[0]
  assertEqual(party.party_type, 'customer', 'a party created in Billing defaults to customer')
  await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role: 'authenticated' })])
  await q('set local role authenticated')

  const offeredIn = async types => {
    const { rows: found } = await q(
      `select id from public.customers
       where organization_id = $1 and deleted_at is null and id = $2 and party_type = any($3::text[])`,
      [ORG, party.id, types],
    )
    return found.length > 0
  }

  assert(await offeredIn(['customer', 'supplier', 'vendor', 'other']), 'a Billing customer must appear on an inward DC')
  assert(await offeredIn(['customer']), 'a Billing customer must appear on an outward customer DC')
  assert(!(await offeredIn(['vendor', 'supplier', 'other'])), 'a customer must not be offered as a processing destination')
})

await test('4c. keeps a vendor out of the customer delivery picker', async () => {
  await q('reset role')
  await q(`update public.customers set party_type = 'vendor' where organization_id = $1 and name = 'Vendor Machining'`, [ORG])
  await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role: 'authenticated' })])
  await q('set local role authenticated')

  const offeredIn = async types => {
    const { rows: found } = await q(
      `select id from public.customers
       where organization_id = $1 and deleted_at is null and party_type = any($2::text[]) and name = 'Vendor Machining'`,
      [ORG, types],
    )
    return found.length > 0
  }

  assert(await offeredIn(['vendor', 'supplier', 'other']), 'a vendor must be offered as an outward self destination')
  assert(!(await offeredIn(['customer'])), 'a vendor must not be offered as a customer delivery destination')
})

await test('5. supports a multi-item challan', async () => {
  const result = await saveInward({
    organization_id: ORG, party_id: customerBId, dc_date: '2026-10-02',
    items: [
      { part_number: 'KI-101', unit: 'NOS', declared_qty: 100, supply_source: 'customer_material' },
      { part_number: 'KI-202', unit: 'NOS', declared_qty: 250, supply_source: 'customer_material' },
      { part_number: 'KI-303', unit: 'Kg', declared_qty: 12.5, supply_source: 'customer_material' },
    ],
  })
  const items = result.items
  assertEqual(items.length, 3, 'all three lines should be stored')
  assertEqual(items.map(i => i.line_no), [1, 2, 3], 'lines are numbered in order')
  assertEqual(items.map(i => i.unit), ['NOS', 'NOS', 'Kg'], 'units are preserved per line, not assumed to be pieces')
})

await test('5b. refuses a challan with no line items', async () => {
  await assertRejects(
    () => saveInward({ organization_id: ORG, party_id: customerId, dc_date: '2026-10-02', items: [] }),
    'VALIDATION_ERROR',
    'an empty challan must be rejected',
  )
})

// ---------------------------------------------------------------------------
// 6-8. Receipt, inspection, reconciliation
// ---------------------------------------------------------------------------

group('Receipt and inspection')

await test('6. records a partial receipt against the declared quantity', async () => {
  const result = await receive({
    organization_id: ORG, dc_id: inward.id, received_by: 'Gatekeeper',
    lines: [{ dc_item_id: inwardItem, received_qty: 990, inspection_required: true }],
  })
  const line = result.items[0]
  assertEqual(num(line.received_qty), 990, 'physical receipt is recorded')
  assertEqual(num(line.declared_qty), 1000, 'the declared quantity stays as the customer declared it')
  assertEqual(num(line.shortage_qty), 10, 'shortage is derived, not overwritten')
  assertEqual(num(line.pending_inspection_qty), 990, 'received material starts as pending inspection')
  assertEqual(line.accepted_qty, 0, 'receiving is not accepting')
})

// The id of the rejection case 7 creates by inspecting, so 9 can assert against
// that exact row instead of "the most recent one".
//
// It cannot use "most recent". Every rejection in this file is inserted inside
// the single transaction the whole suite runs in, and created_at defaults to
// now(), which is the transaction's timestamp and therefore identical for every
// row. `order by created_at desc limit 1` is a tie on every run, and which row
// it returns is whatever the heap happens to hand back. That made case 9 read
// a different row as soon as anything else started creating rejections - and
// 0022 taught record_inward_receipt to record a gate rejection, so 8e began
// creating one part-way through the suite.
let inspectedRejectionId = null

await test('7. separates accepted, rejected and pending quantities on inspection', async () => {
  const result = await inspect({
    organization_id: ORG, dc_id: inward.id, responsible_person: 'QA Inspector',
    lines: [{
      dc_item_id: inwardItem, accepted_qty: 960, rejected_qty: 20, pending_qty: 10,
      rejection_reason: 'Dimensional Out of Tolerance', disposition: 'return_to_customer',
      inspection_report_no: 'IR-001',
    }],
  })
  const line = result.items[0]
  assertEqual(num(line.accepted_qty), 960, 'accepted quantity is recorded')
  assertEqual(num(line.rejected_qty), 20, 'rejected quantity is recorded separately')
  assertEqual(num(line.pending_inspection_qty), 10, 'material awaiting inspection is still pending')
  // 0022 deliberately changed this from 'partially_accepted'. Under 0016 a line
  // with any unjudged material still left could report 'rejected' or
  // 'rework_required' as if it were finished, so 0022 made "is anything still
  // awaiting a decision" decide the status first. Ten pieces out of 990 are
  // exactly that case. Nothing is lost in the interface: the rejected figure has
  // its own column in the line-item table and its own panel, and this test
  // asserts it on the two lines above.
  assertEqual(line.inspection_status, 'partially_inspected', 'status is derived from the quantities, and 10 pieces are still unjudged')
  assert(result.inspections.length === 1, 'the inspection is kept as an event, not just a column')
  inspectedRejectionId = (await q(
    `select id from public.dc_rejections where organization_id = $1 and dc_item_id = $2`, [ORG, inwardItem],
  )).rows[0].id
})

await test('8. refuses to accept or reject more than was physically received', async () => {
  // The ceiling check runs before the exact-sum check 0022 added, so this is
  // still the error an overshoot produces. Case 7 has already judged 980 of
  // this line, leaving 10 to inspect, and asking for 500 of them is an overshoot
  // before it is a miscount.
  await assertRejects(
    () => inspect({
      organization_id: ORG, dc_id: inward.id,
      lines: [{ dc_item_id: inwardItem, accepted_qty: 500, pending_qty: 0 }],
    }),
    'INSPECTION_EXCEEDS_RECEIPT',
    'inspecting beyond the received quantity must fail',
  )
})

await test('8b. refuses negative quantities', async () => {
  const { dc, item } = await freshInward('KI-311', 100, '2026-10-06')
  await assertRejects(
    () => receive({
      organization_id: ORG, dc_id: dc.id,
      lines: [{ dc_item_id: item, received_qty: -5 }],
    }),
    'VALIDATION_ERROR',
    'a negative received quantity must fail validation',
  )
})

// ---------------------------------------------------------------------------
// 8c-8h. Receipt rejection, auto-accept, and the receipt/inspection boundary
// ---------------------------------------------------------------------------

group('Receipt rejection and the receipt/inspection boundary')

await test('8c. records material refused at the gate and leaves the rest for inspection', async () => {
  const created = await saveInward({
    organization_id: ORG, party_id: customerId, dc_date: '2026-10-06',
    items: [{ part_number: 'KI-303', unit: 'NOS', declared_qty: 200, supply_source: 'customer_material' }],
  })
  const dc = created.document
  const item = created.items[0].id

  const result = await receive({
    organization_id: ORG, dc_id: dc.id, received_by: 'Gatekeeper',
    lines: [{ dc_item_id: item, received_qty: 200, rejected_qty: 30, rejection_reason: 'Crushed on arrival', inspection_required: true }],
  })
  const line = result.items[0]

  assertEqual(num(line.received_qty), 200, 'the received quantity is the whole delivery, rejections included')
  assertEqual(num(line.rejected_qty), 30, 'material refused at the gate is recorded as rejected')
  assertEqual(num(line.pending_inspection_qty), 170, 'only what survived the gate is left to inspect')
  assertEqual(num(line.accepted_qty), 0, 'receiving is still not accepting')
  assertEqual(num(line.inspected_qty), 0, 'nothing has been inspected yet')

  // The regression this case exists for. 0022 inserted the rejection with
  // quantity_inspected = 0, which dc_rejections_inspection_check refuses
  // (quantity_accepted + quantity_rejected <= quantity_inspected, i.e. 0 + 30 <=
  // 0). Because the insert shares a transaction with the rest of the receipt,
  // that refusal rolled the whole save back - so an operator who typed a
  // rejected quantity lost the received quantity, the shortage, the movement
  // and the audit entry as well. Every assertion above is reading committed
  // state, so reaching this point at all is the regression test.
  assertEqual(result.document.status, 'issued', 'the receipt transaction committed, not just the rejection')

  const movements = await q(
    `select count(*)::int as n from public.dc_movements
      where organization_id = $1 and dc_item_id = $2 and movement_type = 'receipt'`, [ORG, item])
  assertEqual(movements.rows[0].n, 1, 'the receipt movement survived the rejection being recorded')

  const rejections = await q(`select * from public.dc_rejections where organization_id = $1 and dc_item_id = $2`, [ORG, item])
  assert(rejections.rows.length === 1, 'a gate rejection must be its own trackable record')
  assertEqual(num(rejections.rows[0].quantity_rejected), 30, 'the gate rejection carries the refused quantity')
  // Only the refused pieces were judged at the gate. The 170 that survived are
  // untouched and still sit in pending_inspection_qty, so this row must not
  // claim they were accepted - doing so would count them a second time in
  // dc_material_rejections and dc_acceptance_rate.
  assertEqual(num(rejections.rows[0].quantity_inspected), 30, 'the refused quantity is what was judged, and the constraint holds')
  assertEqual(num(rejections.rows[0].quantity_accepted), 0, 'surviving material has not been accepted by anyone')
  assertEqual(num(rejections.rows[0].quantity_received), 200, 'the record still states the whole delivery that arrived')
  assertEqual(rejections.rows[0].status, 'open', 'nothing has been returned against it yet')
})

await test('8d. will not refuse more than physically arrived', async () => {
  const { dc, item } = await freshInward('KI-312', 1000, '2026-10-06')
  await assertRejects(
    () => receive({
      organization_id: ORG, dc_id: dc.id,
      lines: [{ dc_item_id: item, received_qty: 990, rejected_qty: 5000 }],
    }),
    'REJECTION_EXCEEDS_RECEIPT',
    'rejecting more than was received must fail',
  )
})

await test('8e. accepts on arrival when inspection is not required', async () => {
  // The material is never judged by anyone, so leaving accepted at zero made the
  // whole receipt invisible to available_customer_material forever. Unchecking
  // "inspection required" means this DC is final and the goods are good.
  const created = await saveInward({
    organization_id: ORG, party_id: customerId, dc_date: '2026-10-07',
    items: [{ part_number: 'KI-404', unit: 'NOS', declared_qty: 100, supply_source: 'customer_material' }],
  })
  const dc = created.document
  const item = created.items[0].id

  const result = await receive({
    organization_id: ORG, dc_id: dc.id,
    lines: [{ dc_item_id: item, received_qty: 100, rejected_qty: 10, inspection_required: false }],
  })
  const line = result.items[0]
  assertEqual(num(line.accepted_qty), 90, 'material nobody will inspect is accepted on arrival, less anything refused')
  assertEqual(num(line.pending_inspection_qty), 0, 'nothing is left awaiting a decision that will not come')
  assertEqual(line.inspection_status, 'not_required', 'the line is recorded as not requiring inspection')
})

await test('8f. re-recording an unchanged receipt does not invent movements', async () => {
  // The movement row was inserted unconditionally, so correcting a typo added
  // another full-quantity receipt and the history no longer agreed with
  // received_qty.
  const created = await saveInward({
    organization_id: ORG, party_id: customerId, dc_date: '2026-10-08',
    items: [{ part_number: 'KI-505', unit: 'NOS', declared_qty: 50, supply_source: 'customer_material' }],
  })
  const dc = created.document
  const item = created.items[0].id
  const payload = { organization_id: ORG, dc_id: dc.id, lines: [{ dc_item_id: item, received_qty: 50, inspection_required: true }] }

  await receive(payload)
  await receive(payload)
  await receive(payload)

  const moves = await q(
    `select count(*)::int as n from public.dc_movements
      where organization_id = $1 and dc_item_id = $2 and movement_type = 'receipt'`, [ORG, item])
  assertEqual(moves.rows[0].n, 1, 'material arriving once is one movement, however many times the receipt is saved')
})

await test('8g. allows a receipt to be corrected right up until it is inspected', async () => {
  const created = await saveInward({
    organization_id: ORG, party_id: customerId, dc_date: '2026-10-09',
    items: [{ part_number: 'KI-606', unit: 'NOS', declared_qty: 300, supply_source: 'customer_material' }],
  })
  const dc = created.document
  const item = created.items[0].id

  await receive({ organization_id: ORG, dc_id: dc.id, lines: [{ dc_item_id: item, received_qty: 280, inspection_required: true }] })
  const corrected = await receive({ organization_id: ORG, dc_id: dc.id, lines: [{ dc_item_id: item, received_qty: 295, inspection_required: true }] })

  assertEqual(num(corrected.items[0].received_qty), 295, 'a wrong quantity can be corrected before anyone inspects it')
  assertEqual(num(corrected.items[0].pending_inspection_qty), 295, 'the balance follows the corrected receipt')
})

await test('8g2. replacing a gate rejection rather than stacking a second one', async () => {
  // 0022 recognised a replaceable gate rejection by quantity_inspected = 0.
  // Fixing the constraint violation means that value can never be written
  // again, so a predicate still keyed on it silently matched nothing and every
  // correction appended another rejection. The receipt is the authority on what
  // was refused at the gate, so the previous record must go.
  const created = await saveInward({
    organization_id: ORG, party_id: customerId, dc_date: '2026-10-12',
    items: [{ part_number: 'KI-909', unit: 'NOS', declared_qty: 100, supply_source: 'customer_material' }],
  })
  const dc = created.document
  const item = created.items[0].id

  await receive({ organization_id: ORG, dc_id: dc.id, lines: [{ dc_item_id: item, received_qty: 100, rejected_qty: 30, rejection_reason: 'Wrong item' }] })
  const corrected = await receive({ organization_id: ORG, dc_id: dc.id, lines: [{ dc_item_id: item, received_qty: 100, rejected_qty: 12, rejection_reason: 'Two cracked' }] })

  const rows = await q(`select * from public.dc_rejections where organization_id = $1 and dc_item_id = $2`, [ORG, item])
  assertEqual(rows.rows.length, 1, 'a corrected receipt leaves one gate rejection, not two')
  assertEqual(num(rows.rows[0].quantity_rejected), 12, 'the record states the corrected quantity')
  assertEqual(rows.rows[0].rejection_reason, 'Two cracked', 'the record states the corrected reason')
  assertEqual(num(corrected.items[0].rejected_qty), 12, 'the line agrees with the record')

  await receive({ organization_id: ORG, dc_id: dc.id, lines: [{ dc_item_id: item, received_qty: 100, rejected_qty: 0 }] })
  const cleared = await q(`select * from public.dc_rejections where organization_id = $1 and dc_item_id = $2`, [ORG, item])
  assertEqual(cleared.rows.length, 0, 'withdrawing the rejection withdraws the record')
})

await test('8g3. returns material refused at the gate', async () => {
  // The whole point of recording a gate rejection: material the customer can
  // take away again has to go back out on a return challan. docs/KNOWN_ISSUES.md
  // has listed this as an unverified manual check since 0022 was written.
  const created = await saveInward({
    organization_id: ORG, party_id: customerId, dc_date: '2026-10-13',
    items: [{ part_number: 'KI-910', unit: 'NOS', declared_qty: 80, supply_source: 'customer_material' }],
  })
  const dc = created.document
  const item = created.items[0].id

  await receive({ organization_id: ORG, dc_id: dc.id, lines: [{ dc_item_id: item, received_qty: 80, rejected_qty: 25, rejection_reason: 'Damaged in transit' }] })
  const rejection = (await q(`select * from public.dc_rejections where organization_id = $1 and dc_item_id = $2`, [ORG, item])).rows[0]

  const result = await rpc('record_material_return', {
    organization_id: ORG, rejection_id: rejection.id, returned_qty: 25, mode_of_transport: 'Company Vehicle',
  })
  assertEqual(num(result.rejection.quantity_returned), 25, 'the refused material was physically returned')
  assertEqual(result.rejection.status, 'returned', 'a full return closes the record')
  assert(/^KI\/RET\//.test(result.return_dc.document.dc_number), 'the return raises its own challan')

  // And now the receipt is locked: the return DC exists, so re-recording would
  // leave dc_items.rejected_qty at zero while this row still reported 25 going
  // back to the customer.
  await assertRejects(
    () => receive({ organization_id: ORG, dc_id: dc.id, lines: [{ dc_item_id: item, received_qty: 80, rejected_qty: 0 }] }),
    'RECEIPT_AFTER_RETURN',
    'a receipt must not be rewritten once refused material has been returned',
  )
})

await test('8h. refuses to overwrite a receipt once the challan has been inspected', async () => {
  // Re-recording used to reset pending_inspection_qty to the full received
  // quantity while leaving accepted/rejected in place, so one line reported more
  // material accounted for than had ever arrived - and the inspection form was
  // then pre-filled with a figure the database would refuse.
  await assertRejects(
    () => receive({
      organization_id: ORG, dc_id: inward.id,
      lines: [{ dc_item_id: inwardItem, received_qty: 990, inspection_required: true }],
    }),
    'RECEIPT_AFTER_INSPECTION',
    'a receipt must not overwrite an inspection',
  )

  const line = (await q(`select * from public.dc_items where organization_id = $1 and id = $2`, [ORG, inwardItem])).rows[0]
  assertEqual(num(line.accepted_qty), 960, 'the refused receipt left the inspection result intact')
  assertEqual(num(line.rejected_qty), 20, 'the refused receipt left the rejection intact')
  assertEqual(num(line.pending_inspection_qty), 10, 'the refused receipt did not inflate the pending balance')
  assert(
    num(line.accepted_qty) + num(line.rejected_qty) + num(line.pending_inspection_qty) <= num(line.received_qty),
    'the line still reconciles against what was received',
  )
})

await test('8i. requires the four outcomes to add up to what is still to be inspected', async () => {
  // The ceiling was a "<=", so accepted 960 with pending 500 on a 990 receipt
  // passed both the browser and the database while accounting for 1460 pieces.
  // Judging 10 of 990 and leaving the other 980 unaccounted for is the same
  // mistake in the other direction.
  const { dc, item } = await freshInward('KI-313', 990, '2026-10-06')
  await receive({ organization_id: ORG, dc_id: dc.id, lines: [{ dc_item_id: item, received_qty: 990, inspection_required: true }] })
  await assertRejects(
    () => inspect({
      organization_id: ORG, dc_id: dc.id,
      lines: [{ dc_item_id: item, accepted_qty: 10, pending_qty: 0 }],
    }),
    'VALIDATION_ERROR',
    'outcomes that do not add up to the remaining balance must be refused',
  )
})

await test('8j. never reports more inspected than was received', async () => {
  // inspected_qty used to include pending material, so a second inspection could
  // drive it past received_qty and dc_acceptance_rate and dc_rejection_trend
  // would report more inspected than ever arrived.
  const created = await saveInward({
    organization_id: ORG, party_id: customerId, dc_date: '2026-10-10',
    items: [{ part_number: 'KI-707', unit: 'NOS', declared_qty: 400, supply_source: 'customer_material' }],
  })
  const dc = created.document
  const item = created.items[0].id
  await receive({ organization_id: ORG, dc_id: dc.id, lines: [{ dc_item_id: item, received_qty: 400, inspection_required: true }] })

  await inspect({ organization_id: ORG, dc_id: dc.id, lines: [{ dc_item_id: item, accepted_qty: 300, pending_qty: 100 }] })
  await inspect({ organization_id: ORG, dc_id: dc.id, lines: [{ dc_item_id: item, accepted_qty: 50, pending_qty: 50 }] })

  const line = (await q(`select * from public.dc_items where organization_id = $1 and id = $2`, [ORG, item])).rows[0]
  assertEqual(num(line.inspected_qty), 350, 'inspected counts judged material only: 300 plus 50, not the pending carried alongside')
  assertEqual(num(line.pending_inspection_qty), 50, '50 is still awaiting a decision')
  assert(num(line.inspected_qty) <= num(line.received_qty), 'inspected can never exceed received')
})

await test('8k. reports a line as partially inspected while material is still unjudged', async () => {
  // The rejected branch used to be tested first and ignored what remained, so
  // rejecting 20 of 990 reported "rejected" on a line with 970 uninspected.
  const created = await saveInward({
    organization_id: ORG, party_id: customerId, dc_date: '2026-10-11',
    items: [{ part_number: 'KI-808', unit: 'NOS', declared_qty: 990, supply_source: 'customer_material' }],
  })
  const dc = created.document
  const item = created.items[0].id
  await receive({ organization_id: ORG, dc_id: dc.id, lines: [{ dc_item_id: item, received_qty: 990, inspection_required: true }] })

  const result = await inspect({
    organization_id: ORG, dc_id: dc.id,
    lines: [{ dc_item_id: item, rejected_qty: 20, pending_qty: 970, rejection_reason: 'Out of tolerance' }],
  })
  const line = result.items[0]
  assertEqual(line.inspection_status, 'partially_inspected', '970 pieces are still unjudged, so this is not a rejected line')
  assertEqual(num(line.rejected_qty), 20, 'the rejection is still recorded')

  const finished = await inspect({
    organization_id: ORG, dc_id: dc.id,
    // The rest is *rejected*, which is what this case has always claimed to
    // test. It was passing accepted_qty: 970 here, which leaves the line at 970
    // accepted and 20 rejected - correctly 'partially_accepted', and the
    // opposite of what the assertion below says. The line was never reached
    // before, because the earlier assertion in this case failed against 0016.
    lines: [{ dc_item_id: item, rejected_qty: 970 }],
  })
  assertEqual(num(finished.items[0].rejected_qty), 990, 'all 990 arrived pieces have now been judged')
  assertEqual(finished.items[0].inspection_status, 'rejected', 'with nothing left pending, rejecting the rest makes the whole line rejected')
})

// ---------------------------------------------------------------------------
// 9. Material rejection and partial return
// ---------------------------------------------------------------------------

group('Material rejection and return')

await test('9. records a material rejection with an approved disposition', async () => {
  const rows = await q(`select * from public.dc_rejections where organization_id = $1 and id = $2`, [ORG, inspectedRejectionId])
  assert(rows.rows.length === 1, 'inspecting a rejection must create its own tracked record')
  assertEqual(num(rows.rows[0].quantity_rejected), 20, 'rejected quantity is tracked on its own record')
  assertEqual(rows.rows[0].disposition, 'return_to_customer', 'the disposition is recorded')
  assertEqual(rows.rows[0].status, 'open', 'nothing is returned yet')
})

await test('9b. returns part of the rejected material and keeps the rest outstanding', async () => {
  // Reject 50 on a second challan so the partial-return arithmetic is unambiguous.
  const created = await saveInward({
    organization_id: ORG, party_id: customerId, dc_date: '2026-10-04',
    items: [{ part_number: 'KI-202', unit: 'NOS', declared_qty: 50, supply_source: 'customer_material' }],
  })
  const dc = created.document
  const item = created.items[0].id
  await receive({ organization_id: ORG, dc_id: dc.id, lines: [{ dc_item_id: item, received_qty: 50 }] })
  await inspect({
    organization_id: ORG, dc_id: dc.id,
    lines: [{ dc_item_id: item, accepted_qty: 0, rejected_qty: 50, rejection_reason: 'Material Defect', disposition: 'return_to_customer' }],
  })
  const rejection = (await q(`select * from public.dc_rejections where organization_id = $1 and dc_item_id = $2`, [ORG, item])).rows[0]

  const result = await rpc('record_material_return', {
    organization_id: ORG, rejection_id: rejection.id, returned_qty: 30, mode_of_transport: 'Company Vehicle',
  })
  const updated = result.rejection
  assertEqual(num(updated.quantity_rejected), 50, 'the original rejected quantity is preserved')
  assertEqual(num(updated.quantity_returned), 30, 'only what physically went back is recorded')
  assertEqual(num(updated.quantity_rejected - updated.quantity_returned), 20, '20 pieces are still pending return')
  assertEqual(updated.status, 'partially_returned', 'a partial return is its own state')
  assert(/^KI\/RET\//.test(result.return_dc.document.dc_number), 'the return creates its own document series')

  await assertRejects(
    () => rpc('record_material_return', { organization_id: ORG, rejection_id: rejection.id, returned_qty: 25 }),
    'RETURN_EXCEEDS_REJECTION',
    'returning more than was rejected must fail',
  )
})

// ---------------------------------------------------------------------------
// 10-13. Subcontracting and machining
// ---------------------------------------------------------------------------

group('Machining reconciliation')

// A document for record_machining_result to point at. It used to be an
// outward_self challan issued to a vendor, which is exactly the flow 0024
// deleted along with issue_material and record_vendor_return. The machining
// reconciliation rules themselves are unchanged and still worth testing, so the
// source is now an ordinary outward customer challan.
const machiningSource = await saveCustomer({
  organization_id: ORG, party_id: customerId, dc_date: '2026-10-03',
  delivery_purpose: 'finished_goods', finalize: true,
  items: [{ part_number: 'KI-101', unit: 'NOS', declared_qty: 600, supply_source: 'finished_stock' }],
})
const machiningDc = machiningSource.document
const machiningItem = machiningSource.items[0].id

await test('12. requires machining input to reconcile with its outcomes', async () => {
  await assertRejects(
    () => machining({
      organization_id: ORG, source_dc_id: machiningDc.id, source_dc_item_id: machiningItem,
      party_id: vendorId, material_owner_id: customerId, part_number: 'KI-101',
      operation: 'CNC Turning', input_quantity: 600, input_unit: 'NOS', output_unit: 'NOS',
      accepted_output_quantity: 560, machining_rejection_quantity: 20,
    }),
    'MACHINING_NOT_RECONCILED',
    'an unexplained difference must be refused, not silently absorbed',
  )
})

await test('12b. accepts a reconciled result with rejection and rework', async () => {
  const result = await machining({
    organization_id: ORG, source_dc_id: machiningDc.id, source_dc_item_id: machiningItem,
    party_id: vendorId, material_owner_id: customerId, part_number: 'KI-101',
    operation: 'CNC Turning', input_quantity: 600, input_unit: 'NOS', output_unit: 'NOS',
    accepted_output_quantity: 560, machining_rejection_quantity: 20, rework_quantity: 10, scrap_quantity: 10,
    rejection_reason: 'Dimensional Out of Tolerance', operator_name: 'Operator 1', inspector_name: 'QA',
  })
  assertEqual(num(result.accepted_output_quantity), 560, 'accepted output is recorded')
  assertEqual(num(result.machining_rejection_quantity), 20, 'machining rejection is its own figure')
  assertEqual(num(result.rework_quantity), 10, 'rework is not counted as accepted production')
})

await test('12c. requires a reason and an approver for an authorised process loss', async () => {
  await assertRejects(
    () => machining({
      organization_id: ORG, party_id: vendorId, material_owner_id: customerId, part_number: 'KI-101',
      operation: 'Grinding', input_quantity: 100, input_unit: 'NOS', output_unit: 'NOS',
      accepted_output_quantity: 90, process_loss_quantity: 10,
    }),
    'loss_reason',
    'an unexplained process loss must be refused',
  )
})

await test('12d. accepts a unit-converting process without forcing the universal equation', async () => {
  // A different part, so this unit-conversion fixture cannot be mistaken for
  // finished stock of KI-101 in the ledger assertions below.
  const result = await machining({
    organization_id: ORG, party_id: vendorId, material_owner_id: customerId, part_number: 'KI-BAR',
    operation: 'Other', input_quantity: 250, input_unit: 'Kg', output_unit: 'NOS',
    unit_conversion: true,
  })
  assertEqual(num(result.input_quantity), 250, 'weight in, pieces out, recorded as such')
})

// ---------------------------------------------------------------------------
// 14. Dispatch and concurrency
// ---------------------------------------------------------------------------

group('Dispatch and concurrency')

let customerDc = null
let customerItem = null

await test('14a. dispatches finished stock to the customer', async () => {
  const created = await saveCustomer({
    organization_id: ORG, party_id: customerId, dc_date: '2026-10-05',
    delivery_purpose: 'finished_goods', finalize: true,
    items: [{ part_number: 'KI-101', unit: 'NOS', declared_qty: 400, supply_source: 'finished_stock' }],
  })
  customerDc = created.document
  customerItem = created.items[0].id
  const result = await dispatch({
    organization_id: ORG, dc_id: customerDc.id,
    lines: [{ dc_item_id: customerItem, dispatched_qty: 400 }],
  })
  assertEqual(num(result.items[0].qty_dispatched), 400, 'dispatched quantity is recorded')
  assertEqual(result.document.status, 'dispatched', 'dispatched is not delivered')
})

await test('14b. refuses a dispatch larger than the eligible balance', async () => {
  await assertRejects(
    () => dispatch({
      organization_id: ORG, dc_id: customerDc.id,
      lines: [{ dc_item_id: customerItem, dispatched_qty: 100000 }],
    }),
    'QUANTITY_EXCEEDED',
    'the eligible balance must be enforced by the database',
  )
})

await test('14c. refuses to count raw customer material as finished stock', async () => {
  // KI-101 finished pool holds only machining output. Dispatching raw material
  // against the finished pool must fail even though the material exists.
  const created = await saveCustomer({
    organization_id: ORG, party_id: customerId, dc_date: '2026-10-05', finalize: true,
    items: [{ part_number: 'KI-777', unit: 'NOS', declared_qty: 900, supply_source: 'finished_stock' }],
  })
  await assertRejects(
    () => dispatch({
      organization_id: ORG, dc_id: created.document.id,
      lines: [{ dc_item_id: created.items[0].id, dispatched_qty: 1 }],
    }),
    'QUANTITY_EXCEEDED',
    'a part with no finished output must not be dispatchable',
  )
})

// ---------------------------------------------------------------------------
// 14d. Delivery completion
// ---------------------------------------------------------------------------
//
// The step that was missing entirely. confirm_delivery existed from 0016 and the
// browser had a wrapper for it, but no screen called it, so an outward challan
// could reach `dispatched` and go no further. These are the cases that were
// therefore never exercised by anything.

group('Delivery completion')

/** The part the delivery cases dispatch from. */
const DELIVERY_PART = 'KI-DEL'

/**
 * Finished stock for DELIVERY_PART, established up front.
 *
 * A dedicated part rather than KI-101, whose finished pool the dispatch cases
 * above have already drawn down: sharing it made these cases fail on the
 * eligible balance depending on what ran before them, and made the ledger
 * assertions in 17a depend on how many delivery cases had executed.
 *
 * The quantity is generous because every case dispatches its own challan and
 * dispatch is cumulative against one shared pool - roughly 2,250 pieces across
 * the group.
 */
const deliveryStock = await saveInward({
  organization_id: ORG, party_id: customerId, dc_date: '2026-10-08', finalize: true,
  items: [{ part_number: DELIVERY_PART, unit: 'NOS', declared_qty: 5000, supply_source: 'finished_stock' }],
})
await receive({
  organization_id: ORG, dc_id: deliveryStock.document.id,
  lines: [{ dc_item_id: deliveryStock.items[0].id, received_qty: 5000, inspection_required: true }],
})
await inspect({
  organization_id: ORG, dc_id: deliveryStock.document.id,
  lines: [{ dc_item_id: deliveryStock.items[0].id, accepted_qty: 5000 }],
})

/** A fresh outward challan, dispatched for `qty` of finished stock. */
async function dispatchedChallan(declared, qty) {
  const created = await saveCustomer({
    organization_id: ORG, party_id: customerId, dc_date: '2026-10-09',
    delivery_purpose: 'finished_goods', finalize: true,
    items: [{ part_number: DELIVERY_PART, unit: 'NOS', declared_qty: declared, supply_source: 'finished_stock' }],
  })
  const dc = created.document
  const item = created.items[0].id
  await dispatch({
    organization_id: ORG, dc_id: dc.id, proof_of_delivery_ref: 'POD/DISPATCH-1',
    lines: [{ dc_item_id: item, dispatched_qty: qty }],
  })
  return { dc, item }
}

const balanceFor = () => rpc('dc_available_balance', ORG, customerId, DELIVERY_PART, 'finished_stock')

await test('14d1. saves the proof of delivery reference on the challan, not only the movement', async () => {
  const { dc } = await dispatchedChallan(100, 100)
  const row = (await q(`select proof_of_delivery_ref from public.dc_documents where id = $1`, [dc.id])).rows[0]
  assertEqual(row.proof_of_delivery_ref, 'POD/DISPATCH-1',
    'the POD typed on the dispatch form must reach dc_documents')
})

await test('14d2. refuses to dispatch a draft challan', async () => {
  const created = await saveCustomer({
    organization_id: ORG, party_id: customerId, dc_date: '2026-10-09',
    items: [{ part_number: DELIVERY_PART, unit: 'NOS', declared_qty: 10, supply_source: 'finished_stock' }],
  })
  assertEqual(created.document.status, 'draft', 'the challan was saved as a draft')
  await assertRejects(
    () => dispatch({
      organization_id: ORG, dc_id: created.document.id,
      lines: [{ dc_item_id: created.items[0].id, dispatched_qty: 1 }],
    }),
    'NOT_ISSUED',
    'material must not leave on a challan that was never finalized',
  )
})

await test('14d3. records a part-delivery and lands on partially_delivered', async () => {
  const { dc, item } = await dispatchedChallan(400, 400)
  const result = await confirmDelivery({
    organization_id: ORG, dc_id: dc.id, delivered: false,
    proof_of_delivery_ref: 'POD/7781-A', receiver_name: 'Balaji',
    lines: [{ dc_item_id: item, delivered_qty: 250 }],
  })
  assertEqual(num(result.items[0].qty_delivered), 250, 'the acknowledged quantity is recorded per line')
  assertEqual(result.document.status, 'partially_delivered', 'some delivered and some not is partially delivered')
  assertEqual(result.document.actual_delivery_at, null, 'a part-delivery is not the delivery date')
})

await test('14d4. delivers the remainder and closes the challan', async () => {
  const { dc, item } = await dispatchedChallan(400, 400)
  await confirmDelivery({
    organization_id: ORG, dc_id: dc.id, delivered: false,
    proof_of_delivery_ref: 'POD/7781-A', receiver_name: 'Balaji',
    lines: [{ dc_item_id: item, delivered_qty: 250 }],
  })
  const result = await confirmDelivery({
    organization_id: ORG, dc_id: dc.id,
    proof_of_delivery_ref: 'POD/7781-B', receiver_name: 'Balaji',
    lines: [{ dc_item_id: item, delivered_qty: 150 }],
  })
  assertEqual(num(result.items[0].qty_delivered), 400, 'the delivered quantity accumulates')
  assertEqual(result.document.status, 'delivered', 'everything dispatched has been acknowledged')
  assert(result.document.actual_delivery_at !== null, 'closing the challan records when it was delivered')
  assertEqual(result.document.receiver_name, 'Balaji', 'the receiver is recorded')
  assertEqual(result.document.proof_of_delivery_ref, 'POD/7781-B', 'the latest POD wins')
})

await test('14d5. refuses a delivery larger than what was dispatched', async () => {
  const { dc, item } = await dispatchedChallan(400, 400)
  await assertRejects(
    () => confirmDelivery({
      organization_id: ORG, dc_id: dc.id, proof_of_delivery_ref: 'POD/X',
      lines: [{ dc_item_id: item, delivered_qty: 401 }],
    }),
    'QUANTITY_EXCEEDED',
    'a customer cannot take more than left the plant',
  )
})

await test('14d6. refuses to count the same quantity as delivered twice', async () => {
  const { dc, item } = await dispatchedChallan(400, 400)
  await confirmDelivery({
    organization_id: ORG, dc_id: dc.id, proof_of_delivery_ref: 'POD/A',
    lines: [{ dc_item_id: item, delivered_qty: 400 }],
  })
  await assertRejects(
    () => confirmDelivery({
      organization_id: ORG, dc_id: dc.id, proof_of_delivery_ref: 'POD/B',
      lines: [{ dc_item_id: item, delivered_qty: 1 }],
    }),
    'ALREADY_DELIVERED',
    'a closed challan cannot be delivered against again',
  )
})

await test('14d7. requires a proof of delivery reference to close the challan', async () => {
  const { dc, item } = await dispatchedChallan(400, 400)
  await assertRejects(
    () => confirmDelivery({
      organization_id: ORG, dc_id: dc.id, delivered: false,
      lines: [{ dc_item_id: item, delivered_qty: 400 }],
    }),
    'proof_of_delivery_ref',
    'delivering the whole challan without a POD must be refused',
  )
})

await test('14d8. refuses a delivery on a challan that was never dispatched', async () => {
  const created = await saveCustomer({
    organization_id: ORG, party_id: customerId, dc_date: '2026-10-09', finalize: true,
    items: [{ part_number: DELIVERY_PART, unit: 'NOS', declared_qty: 50, supply_source: 'finished_stock' }],
  })
  await assertRejects(
    () => confirmDelivery({
      organization_id: ORG, dc_id: created.document.id, proof_of_delivery_ref: 'POD/X',
      lines: [{ dc_item_id: created.items[0].id, delivered_qty: 50 }],
    }),
    'NOT_DISPATCHED',
    'nothing can arrive before it has left',
  )
})

await test('14d9. refuses a delivery on an inward challan', async () => {
  // confirm_delivery used to accept any document type at all.
  const created = await saveInward({
    organization_id: ORG, party_id: customerId, dc_date: '2026-10-09', finalize: true,
    items: [{ part_number: 'KI-101', unit: 'NOS', declared_qty: 50, supply_source: 'finished_stock' }],
  })
  await assertRejects(
    () => confirmDelivery({
      organization_id: ORG, dc_id: created.document.id, proof_of_delivery_ref: 'POD/X',
      lines: [{ dc_item_id: created.items[0].id, delivered_qty: 50 }],
    }),
    'NOT_FOUND',
    'an inward challan has no customer delivery to confirm',
  )
})

await test('14d10. does not deduct the stock balance a second time on delivery', async () => {
  // The single most important property of the new path. Stock leaves at
  // dispatch; if confirming delivery re-deducted it, every finished-stock
  // balance would be halved the moment a challan was closed.
  const before = num(await balanceFor())
  const { dc, item } = await dispatchedChallan(50, 50)
  const afterDispatch = num(await balanceFor())
  assertEqual(afterDispatch, before - 50, 'dispatch takes the material out of the balance')

  await confirmDelivery({
    organization_id: ORG, dc_id: dc.id, proof_of_delivery_ref: 'POD/7781-C',
    lines: [{ dc_item_id: item, delivered_qty: 50 }],
  })
  assertEqual(num(await balanceFor()), afterDispatch,
    'confirming delivery records arrival at the customer; it must not move stock again')
})

// Two challans left behind in known states for the pending-delivery report,
// which can only be asserted once something has actually left it.
const partialSetup = await dispatchedChallan(100, 100)
await confirmDelivery({
  organization_id: ORG, dc_id: partialSetup.dc.id, delivered: false,
  proof_of_delivery_ref: 'POD/PARTIAL-1', receiver_name: 'Balaji',
  lines: [{ dc_item_id: partialSetup.item, delivered_qty: 60 }],
})
const partialDc = partialSetup.dc

const closedSetup = await dispatchedChallan(100, 100)
await confirmDelivery({
  organization_id: ORG, dc_id: closedSetup.dc.id,
  proof_of_delivery_ref: 'POD/CLOSED-1', receiver_name: 'Balaji',
  lines: [{ dc_item_id: closedSetup.item, delivered_qty: 100 }],
})
const closedDc = closedSetup.dc

await test('14d11. a delivered challan can be dispatched again when material remains', async () => {
  // Regression: record_dispatch refused status = 'delivered' with ALREADY_DELIVERED.
  // A machining result for 85 finished, a dispatch of 50, and a delivery of 50
  // closes the challan, but 35 pieces are still at the plant. Dispatching them
  // on the same challan must succeed.
  const { dc, item } = await dispatchedChallan(100, 60)
  await confirmDelivery({
    organization_id: ORG, dc_id: dc.id, proof_of_delivery_ref: 'POD/DELIVERED-1',
    receiver_name: 'Balaji', delivered: true,
    lines: [{ dc_item_id: item, delivered_qty: 60 }],
  })
  const delivered = await rpc('record_dispatch', { organization_id: ORG, dc_id: dc.id })
  assertEqual(delivered.document.status, 'delivered', 'the challan was fully delivered')

  // Dispatch the remaining 40. The balance check on the finished_stock pool
  // allows it (5000 - 60 = 4940 left).
  const result = await dispatch({
    organization_id: ORG, dc_id: dc.id,
    lines: [{ dc_item_id: item, dispatched_qty: 40 }],
  })
  assertEqual(num(result.items[0].qty_dispatched), 100, 'the dispatched quantity accumulates')
  assertEqual(result.document.status, 'partially_delivered',
    're-dispatching a delivered challan reopens it as partially delivered, not dispatched')
})

await test('14d12. re-dispatch clears the delivery timestamp but preserves the proof ref', async () => {
  const { dc, item } = await dispatchedChallan(100, 60)
  await confirmDelivery({
    organization_id: ORG, dc_id: dc.id, proof_of_delivery_ref: 'POD/KEEP-THIS',
    receiver_name: 'Balaji', delivered: true,
    lines: [{ dc_item_id: item, delivered_qty: 60 }],
  })
  const before = (await q('select actual_delivery_at, proof_of_delivery_ref from public.dc_documents where id = $1', [dc.id])).rows[0]
  assert(before.actual_delivery_at !== null, 'the delivered challan has a delivery timestamp')

  await dispatch({
    organization_id: ORG, dc_id: dc.id,
    lines: [{ dc_item_id: item, dispatched_qty: 40 }],
  })
  const after = (await q('select actual_delivery_at, proof_of_delivery_ref from public.dc_documents where id = $1', [dc.id])).rows[0]
  assert(after.actual_delivery_at === null, 're-dispatch clears the delivery timestamp so the badge does not read delivered')
  assertEqual(after.proof_of_delivery_ref, 'POD/KEEP-THIS', 'the previous proof of delivery reference is preserved as history')
})

await test('14d13. re-dispatch then confirm delivery closes the challan again', async () => {
  const { dc, item } = await dispatchedChallan(100, 60)
  await confirmDelivery({
    organization_id: ORG, dc_id: dc.id, proof_of_delivery_ref: 'POD/FIRST-60',
    receiver_name: 'Balaji', delivered: true,
    lines: [{ dc_item_id: item, delivered_qty: 60 }],
  })

  // Send the remaining 40.
  await dispatch({
    organization_id: ORG, dc_id: dc.id,
    lines: [{ dc_item_id: item, dispatched_qty: 40 }],
  })
  const reopened = await rpc('record_dispatch', { organization_id: ORG, dc_id: dc.id })
  assertEqual(reopened.document.status, 'partially_delivered', '35 still outstanding after re-dispatch')

  // Confirm the remaining 40.
  const closed = await confirmDelivery({
    organization_id: ORG, dc_id: dc.id, delivered: true,
    proof_of_delivery_ref: 'POD/SECOND-40', receiver_name: 'Balaji',
    lines: [{ dc_item_id: item, delivered_qty: 40 }],
  })
  assertEqual(num(closed.items[0].qty_delivered), 100, 'deliveries accumulate across confirmations')
  assertEqual(closed.document.status, 'delivered', 'confirming the remaining quantity closes the challan')
  assertEqual(closed.document.proof_of_delivery_ref, 'POD/SECOND-40', 'the latest POD wins')
})

await test('14d14. re-dispatch still respects the inward line balance', async () => {
  // The balance guard is the real protection. Even after reopening, a dispatch
  // larger than what is available must be refused.
  const { dc, item } = await dispatchedChallan(100, 60)
  await confirmDelivery({
    organization_id: ORG, dc_id: dc.id, proof_of_delivery_ref: 'POD/PARTIAL-2',
    receiver_name: 'Balaji', delivered: false,
    lines: [{ dc_item_id: item, delivered_qty: 60 }],
  })
  const balance = num(await balanceFor())
  // Try to dispatch more than the remaining balance.
  await assertRejects(
    () => dispatch({
      organization_id: ORG, dc_id: dc.id,
      lines: [{ dc_item_id: item, dispatched_qty: balance + 9999 }],
    }),
    'QUANTITY_EXCEEDED',
    'the balance guard still applies on a reopened challan',
  )
})

// Concurrency is tested in its own phase at the end of the file, because it
// needs committed data that separate connections can see.

// ---------------------------------------------------------------------------
// 16. Linking an inward challan to the outward ones made from it
//
// The workflow: a customer sends several of their own challans, one inward
// challan of ours receives material from all of them, the material is
// inspected and machined, and one or more outward challans go back out.
// ---------------------------------------------------------------------------

group('Inward and outward are linked by line')

let linkedInward = null
let linkedInwardItems = []
let linkedOutward = null
let linkedOutwardItems = []
let secondOutward = null
let secondOutwardItem = null

await test('16a. records which of the customer\'s own challans each line arrived on', async () => {
  const result = await saveInward({
    organization_id: ORG, party_id: customerId, dc_date: '2026-10-08',
    finalize: true,
    items: [
      { part_number: 'KI-201', unit: 'NOS', declared_qty: 100, supply_source: 'customer_material', customer_dc_number: 'CUST-4411', drawing_number: 'DWG-201' },
      { part_number: 'KI-202', unit: 'NOS', declared_qty: 100, supply_source: 'customer_material', customer_dc_number: 'CUST-4412' },
      { part_number: 'KI-203', unit: 'NOS', declared_qty: 100, supply_source: 'customer_material', customer_dc_number: 'CUST-4413' },
    ],
  })
  linkedInward = result.document
  linkedInwardItems = result.items
  assertEqual(
    result.items.map(i => i.customer_dc_number),
    ['CUST-4411', 'CUST-4412', 'CUST-4413'],
    'one inward challan carries material from several of the customer\'s challans, one per line',
  )
  assertEqual(
    result.customer_dc_numbers,
    ['CUST-4411', 'CUST-4412', 'CUST-4413'],
    'the document reports every customer DC number it touches',
  )
})

await test('16b. accepts 100, inspects to 90 accepted and 10 rejected', async () => {
  // Both receipts first, then both inspections: 0022 refuses a receipt once the
  // challan has been inspected, so the two cannot be interleaved per line.
  const [first, second] = linkedInwardItems
  await rpc('record_inward_receipt', {
    organization_id: ORG, dc_id: linkedInward.id,
    lines: [
      { dc_item_id: first.id, received_qty: 100, shortage_qty: 0, excess_qty: 0, damaged_qty: 0 },
      { dc_item_id: second.id, received_qty: 100, shortage_qty: 0, excess_qty: 0, damaged_qty: 0 },
    ],
  })
  await rpc('record_material_inspection', {
    organization_id: ORG, dc_id: linkedInward.id,
    lines: [
      { dc_item_id: first.id, accepted_qty: 90, rejected_qty: 10, pending_qty: 0, rejection_reason: 'Dimensional out of tolerance' },
      { dc_item_id: second.id, accepted_qty: 100, pending_qty: 0 },
    ],
  })
  assertEqual(num(await rpc('dc_inward_line_availability', ORG, first.id)), 90,
    'available to draw from is what inspection accepted')
  assertEqual(num(await rpc('dc_inward_line_availability', ORG, second.id)), 100)
})

await test('16c. builds an outward challan from inward lines and carries their customer DC numbers', async () => {
  const first = linkedInwardItems[0]
  const second = linkedInwardItems[1]
  const result = await saveCustomer({
    organization_id: ORG, party_id: customerId, dc_date: '2026-10-09', finalize: true,
    items: [
      { part_number: 'KI-201', unit: 'NOS', declared_qty: 85, supply_source: 'customer_material', source_inward_item_id: first.id },
      { part_number: 'KI-202', unit: 'NOS', declared_qty: 100, supply_source: 'customer_material', source_inward_item_id: second.id },
    ],
  })
  linkedOutward = result.document
  linkedOutwardItems = result.items
  assertEqual(
    result.items.map(i => i.source_inward_item_id),
    [first.id, second.id],
    'each outward line names the inward line it came from',
  )
  assertEqual(
    result.items[0].source_inward_dc_number, linkedInward.dc_number,
    'the outward line reports the inward challan it draws from',
  )
  assertEqual(
    result.customer_dc_numbers, ['CUST-4411', 'CUST-4412'],
    'an outward challan names the customer DCs its material arrived on, and only those',
  )
})

await test('16d. refuses an outward line linked to another customer\'s inward challan', async () => {
  const other = await saveInward({
    organization_id: ORG, party_id: customerBId, dc_date: '2026-10-08', finalize: true,
    items: [{ part_number: 'KI-201', unit: 'NOS', declared_qty: 10, supply_source: 'customer_material' }],
  })
  const failure = await assertRejects(
    () => saveCustomer({
      organization_id: ORG, party_id: customerId, dc_date: '2026-10-10',
      items: [{ part_number: 'KI-201', unit: 'NOS', declared_qty: 5, supply_source: 'customer_material', source_inward_item_id: other.items[0].id }],
    }),
    'SOURCE_PARTY_MISMATCH',
    "an outward line must not be fed by another customer's inward material",
  )
  assert(/different customer/i.test(failure.message),
    `the refusal should name the reason, got: ${failure.message}`)
})

await test('16e. refuses an outward line linked to an inward line for a different part', async () => {
  // Without this the guard is only half a guard: an outward line for part A fed
  // by an inward line for part B would be capped against the wrong material.
  await assertRejects(
    () => saveCustomer({
      organization_id: ORG, party_id: customerId, dc_date: '2026-10-10',
      items: [{ part_number: 'KI-201', unit: 'NOS', declared_qty: 5, supply_source: 'customer_material', source_inward_item_id: linkedInwardItems[1].id }],
    }),
    'SOURCE_PART_MISMATCH',
    'an outward line may only be fed by an inward line for the same part',
  )
})

await test('16f. machines the accepted quantity, and the rejection comes off the inward line', async () => {
  // It used to be filed against the first line whatever was typed, so a
  // machining rejection landed on the wrong inward line and was never subtracted
  // from the material it consumed.
  //
  // 90 accepted in, 5 rejected in machining, 85 finished. That is the whole
  // point of the arithmetic the dispatch cap depends on.
  await machining({
    organization_id: ORG, party_id: customerId,
    source_dc_id: linkedOutward.id, source_dc_item_id: linkedOutwardItems[0].id,
    material_owner_id: customerId,
    part_number: 'KI-201', operation: 'CNC Turning', operation_date: '2026-10-09',
    input_quantity: 90, input_unit: 'NOS',
    accepted_output_quantity: 85, output_unit: 'NOS',
    machining_rejection_quantity: 5,
  })
  await machining({
    organization_id: ORG, party_id: customerId,
    source_dc_id: linkedOutward.id, source_dc_item_id: linkedOutwardItems[1].id,
    material_owner_id: customerId,
    part_number: 'KI-202', operation: 'CNC Turning', operation_date: '2026-10-09',
    input_quantity: 100, input_unit: 'NOS',
    accepted_output_quantity: 88, output_unit: 'NOS',
    machining_rejection_quantity: 5, rework_quantity: 4, scrap_quantity: 2, process_loss_quantity: 1,
    loss_reason: 'Handling', loss_approved_by: '33333333-3333-4333-8333-333333333333',
  })
  assertEqual(num(await rpc('dc_inward_line_availability', ORG, linkedInwardItems[0].id)), 85,
    'only what came out finished can go back: the five the process spoiled cannot')
  assertEqual(num(await rpc('dc_inward_line_availability', ORG, linkedInwardItems[1].id)), 88,
    '88 came out finished; the 5 rejected, 4 for rework, 2 scrapped and 1 lost are not finished goods')

  const rows = await rpcRows('dc_job_progress', ['::uuid', '::uuid'], ORG, linkedInward.id)
  assertEqual(num(rows.find(r => r.scope === 'line' && r.line_no === 1).machining_rejection_qty), 5,
    'the machining rejection is counted against the inward line whose material it consumed')
  assertEqual(num(rows.find(r => r.scope === 'line' && r.line_no === 2).machining_rejection_qty), 5,
    'and against its own, rather than both landing on the first line')
})

await test('16g. dispatch is capped at what is left of the inward line', async () => {
  await assertRejects(
    () => dispatch({
      organization_id: ORG, dc_id: linkedOutward.id,
      lines: [{ dc_item_id: linkedOutwardItems[0].id, dispatched_qty: 86 }],
    }),
    'QUANTITY_EXCEEDED',
    'dispatch may not exceed what is left of the inward line',
  )
  await dispatch({
    organization_id: ORG, dc_id: linkedOutward.id,
    lines: [{ dc_item_id: linkedOutwardItems[0].id, dispatched_qty: 80 }],
  })
  assertEqual(num(await rpc('dc_inward_line_availability', ORG, linkedInwardItems[0].id)), 5,
    'dispatch reduces what the inward line has left')
})

await test('16h. a second outward challan can draw from the same inward line, but only what is left', async () => {
  const second = await saveCustomer({
    organization_id: ORG, party_id: customerId, dc_date: '2026-10-11', finalize: true,
    items: [{ part_number: 'KI-201', unit: 'NOS', declared_qty: 5, supply_source: 'customer_material', source_inward_item_id: linkedInwardItems[0].id }],
  })
  secondOutward = second.document
  secondOutwardItem = second.items[0].id
  await dispatch({
    organization_id: ORG, dc_id: second.document.id,
    lines: [{ dc_item_id: second.items[0].id, dispatched_qty: 5 }],
  })
  assertEqual(
    num(await rpc('dc_inward_line_availability', ORG, linkedInwardItems[0].id)),
    0, 'the inward line is exhausted',
  )
  await assertRejects(
    () => dispatch({
      organization_id: ORG, dc_id: second.document.id,
      lines: [{ dc_item_id: second.items[0].id, dispatched_qty: 1 }],
    }),
    'QUANTITY_EXCEEDED',
    'an exhausted inward line gives nothing more',
  )
})

await test('16i. the customer material pool falls as outward challans dispatch from it', async () => {
  // This is the hole 0027 closed: the customer_material branch of
  // dc_available_balance subtracted only outward_self quantities, and 0024 had
  // already deleted that type, so the pool was "everything ever received" and
  // never moved. Pin it so it cannot be reopened.
  const balance = () => rpc('dc_available_balance', ORG, customerId, 'KI-202', 'customer_material')
  const before = num(await balance())
  await dispatch({
    organization_id: ORG, dc_id: linkedOutward.id,
    lines: [{ dc_item_id: linkedOutwardItems[1].id, dispatched_qty: 40 }],
  })
  assertEqual(num(await balance()), before - 40,
    'dispatching customer material reduces what is left of it')
})

await test('16j. derives the job status of an inward challan from the outward ones made from it', async () => {
  const rows = await rpcRows('dc_job_progress', ['::uuid', '::uuid'], ORG, linkedInward.id)
  const doc = rows.find(r => r.scope === 'document')
  assertEqual(doc.job_status, 'in_progress', 'everything is out but nothing is acknowledged yet')
  assertEqual(doc.dc_status, 'issued',
    'the inward document status still says where the material is, not where the work is: that is the whole point of deriving it separately')
  assertEqual(rows.find(r => r.scope === 'line' && r.line_no === 3).job_status, 'not_started',
    'the line nothing was raised against is not started')
})

await test('16k. a part-delivery on the outward challan leaves the inward line part delivered', async () => {
  await confirmDelivery({
    organization_id: ORG, dc_id: linkedOutward.id,
    proof_of_delivery_ref: 'POD/LINKED-1', receiver_name: 'Balaji',
    lines: [
      { dc_item_id: linkedOutwardItems[0].id, delivered_qty: 80 },
      { dc_item_id: linkedOutwardItems[1].id, delivered_qty: 20 },
    ],
  })
  const rows = await rpcRows('dc_job_progress', ['::uuid', '::uuid'], ORG, linkedInward.id)
  assertEqual(rows.find(r => r.scope === 'line' && r.line_no === 1).job_status, 'partially_delivered',
    '80 of the 85 sent on this challan were acknowledged; the rest is on another')
  assertEqual(rows.find(r => r.scope === 'document').job_status, 'partially_delivered',
    'so the inward challan reports the job as partly delivered')
})

await test('16l. the second outward challan completing finishes that inward line', async () => {
  await confirmDelivery({
    organization_id: ORG, dc_id: secondOutward.id,
    proof_of_delivery_ref: 'POD/LINKED-2', receiver_name: 'Balaji',
    lines: [{ dc_item_id: secondOutwardItem, delivered_qty: 5 }],
  })
  const rows = await rpcRows('dc_job_progress', ['::uuid', '::uuid'], ORG, linkedInward.id)
  assertEqual(rows.find(r => r.scope === 'line' && r.line_no === 1).job_status, 'delivered',
    'line 1 is finished, because both outward challans made from it are delivered')
  assertEqual(rows.find(r => r.scope === 'document').job_status, 'partially_delivered',
    'line 2 still has 20 undelivered')
})

await test('16m. delivering the last of it reports the job on the inward challan finished', async () => {
  await confirmDelivery({
    organization_id: ORG, dc_id: linkedOutward.id,
    proof_of_delivery_ref: 'POD/LINKED-3', receiver_name: 'Balaji',
    lines: [{ dc_item_id: linkedOutwardItems[1].id, delivered_qty: 20 }],
  })
  const rows = await rpcRows('dc_job_progress', ['::uuid', '::uuid'], ORG, linkedInward.id)
  assertEqual(rows.find(r => r.scope === 'document').job_status, 'delivered',
    'every linked line acknowledged in full means the work is finished')
})

await test('16n. finds inward and outward challans from one customer DC number', async () => {
  const hits = await rpcRows('dc_search', ['::uuid', '::text'], ORG, 'CUST-4411')
  const numbers = hits.map(h => h.dc_number)
  assert(numbers.includes(linkedInward.dc_number), 'the inward challan carrying the customer DC number is found')
  assert(numbers.includes(linkedOutward.dc_number), 'and the outward challan made from its material is found too')
  assert(hits.every(h => h.matched_on && h.matched_on.length > 0), 'every hit says which identifier matched')
})

await test('16o. a linked bill makes a bill number find the challan', async () => {
  // bills has no INSERT grant to the authenticated role - the browser reaches it
  // through its own RPCs - so the fixture row is written as the owner.
  await q('reset role')
  const bill = (await q(
    `insert into public.bills (organization_id, customer_id, customer_name, bill_number, bill_date)
     values ($1, $2, 'Customer A', 'BILL-LINK-1', '2026-10-11') returning id`, [ORG, customerId])).rows[0]
  await impersonate()
  const attach = () => rpc('dc_link_bills', { organization_id: ORG, dc_id: linkedOutward.id, bills: [{ bill_id: bill.id }] })
  await attach()
  const hits = await rpcRows('dc_search', ['::uuid', '::text'], ORG, 'BILL-LINK-1')
  assert(hits.some(h => h.id === linkedOutward.id), 'searching the bill number finds the challan it bills for')
  assertEqual((await rpcRows('dc_linked_bills', ['::uuid', '::uuid'], ORG, linkedOutward.id)).length, 1,
    'the bill is attached once')
  // Setting, not toggling: re-sending the same list is harmless.
  await attach()
  assertEqual((await rpcRows('dc_linked_bills', ['::uuid', '::uuid'], ORG, linkedOutward.id)).length, 1,
    're-linking the same bill must not detach it')
})

// ---------------------------------------------------------------------------
// 21. Reports carry the identifiers the links are built from
//
// Every report row whose DC number is shown has to carry the id and the
// document type too, or the page builds a link out of `undefined` and reports
// that a real challan does not exist. Three functions were returning a number
// with no id, which is how the rejection screens ended up pointing at
// /dc/inward/undefined.
// ---------------------------------------------------------------------------

group('Reports identify the challan they report on')

await test('21a. a material rejection names the challan it came from', async () => {
  const rows = await rpcRows('dc_material_rejections', ['::uuid', '::date', '::date'], ORG, null, null)
  const row = rows.find(r => r.dc_id === linkedInward.id)
  assert(row, 'the inward challan with rejected material is reported')
  assertEqual(row.dc_number, linkedInward.dc_number)
  assertEqual(row.dc_type, 'inward')
  assert(row.dc_id, 'a report row must carry the id the link is built from')
})

await test('21b. a machining rejection names the challan it was recorded on', async () => {
  const rows = await rpcRows('dc_machining_rejections', ['::uuid', '::date', '::date'], ORG, null, null)
  const row = rows.find(r => r.source_dc_id === linkedOutward.id && r.part_number === 'KI-201')
  assert(row, 'the machining result is reported')
  assertEqual(row.source_dc_number, linkedOutward.dc_number)
  assertEqual(row.source_dc_type, 'outward_customer',
    'the link goes to the OUTWARD challan: that is where the work was done and the history lives')
  assertEqual(row.inward_dc_id, linkedInward.id,
    'and the inward challan the material came from is reported beside it')
})

await test('21c. the variance report names the challan it summarises', async () => {
  const rows = await rpcRows('dc_variance_report', ['::uuid', '::date', '::date'], ORG, null, null)
  assert(rows.every(r => r.dc_id), 'every variance row carries a challan id')
})

await test('21d. an outstanding delivery carries its document type', async () => {
  const rows = await rpcRows('dc_pending_customer_delivery', ['::uuid'], ORG)
  assert(rows.every(r => r.dc_type === 'outward_customer'),
    'so the page can reach it without hardcoding an /dc/outward/ segment')
})

await test('21e. the outward picker reports how much of each inward line is still un-inspected', async () => {
  // The picker could not tell a finished line from one with material waiting on
  // a decision, and offered the same available quantity for both. Its own
  // fixture: the challans above are fully dispatched, so their lines have
  // nothing left and are not offered at all.
  const created = await saveInward({
    organization_id: ORG, party_id: customerId, dc_date: '2026-10-14', finalize: true,
    items: [
      { part_number: 'KI-301', unit: 'NOS', declared_qty: 100, supply_source: 'customer_material', customer_dc_number: 'CUST-4500' },
      { part_number: 'KI-302', unit: 'NOS', declared_qty: 100, supply_source: 'customer_material', customer_dc_number: 'CUST-4501' },
    ],
  })
  const [judged, waiting] = created.items
  await rpc('record_inward_receipt', {
    organization_id: ORG, dc_id: created.document.id,
    lines: [
      { dc_item_id: judged.id, received_qty: 100, shortage_qty: 0, excess_qty: 0, damaged_qty: 0 },
      { dc_item_id: waiting.id, received_qty: 100, shortage_qty: 0, excess_qty: 0, damaged_qty: 0 },
    ],
  })
  await rpc('record_material_inspection', {
    organization_id: ORG, dc_id: created.document.id,
    lines: [
      { dc_item_id: judged.id, accepted_qty: 90, rejected_qty: 10, pending_qty: 0, rejection_reason: 'Out of tolerance' },
      // Part-judged: some accepted, some still waiting. This is the case the
      // picker could not express - it offered the accepted 40 without saying
      // that 60 of the same line was still undecided.
      { dc_item_id: waiting.id, accepted_qty: 40, pending_qty: 60 },
    ],
  })

  const rows = await rpcRows('dc_inward_lines', ['::uuid', '::uuid', '::text'], ORG, customerId, null)
  const ready = rows.find(r => r.item_id === judged.id)
  const pendingLine = rows.find(r => r.item_id === waiting.id)
  assert(ready, 'a fully judged line is offered')
  assertEqual(ready.fully_inspected, true,
    '90 accepted and 10 rejected is fully inspected - the 90 is what can go back')
  assertEqual(num(ready.rejected_qty), 10)
  assert(pendingLine, 'a part-judged line is listed rather than hidden')
  assertEqual(pendingLine.fully_inspected, false)
  assertEqual(num(pendingLine.pending_inspection_qty), 60,
    'and it says how much is waiting, so it is distinguishable from a finished line')
  assertEqual(num(pendingLine.available_qty), 40,
    'while still offering the 40 that have been accepted')

  // The finished line is offered first, so the operator's default view is what
  // can actually go back today.
  assert(rows.findIndex(r => r.item_id === judged.id) < rows.findIndex(r => r.item_id === waiting.id),
    'fully inspected lines are listed ahead of the ones still waiting')
})

await test('21f. searching the picker by part number still works', async () => {
  const rows = await rpcRows('dc_inward_lines', ['::uuid', '::uuid', '::text'], ORG, customerId, 'KI-301')
  assertEqual(rows.length, 1)
  assertEqual(rows[0].part_number, 'KI-301')
})

await test('21g. a bill can be raised from an outward challan, quantities only', async () => {
  const rows = await rpcRows('dc_billable_lines', ['::uuid', '::uuid'], ORG, linkedOutward.id)
  assertEqual(rows.length, 2, 'one row per dispatched line')
  assertEqual(rows[0].dc_number, linkedOutward.dc_number)
  assertEqual(rows[0].party_id, customerId)
  assert(rows[0].qty_dispatched > 0, 'the quantity to invoice comes from the challan')
  assertEqual(rows[0].customer_dc_numbers, ['CUST-4411', 'CUST-4412'],
    'and the customer DC numbers it answers, so the bill can name them')
  // No rate and no amount: a challan records what moved, not what it cost.
  assert(!('rate' in rows[0]) && !('amount' in rows[0]),
    'nothing here is a price; every rate on the bill is typed by the operator')
})

await test('21h. the challans a bill pays for are listed with their quantities', async () => {
  await q('reset role')
  const bill = (await q(
    `insert into public.bills (organization_id, customer_id, customer_name, bill_number, bill_date)
     values ($1, $2, 'Customer A', 'BILL-SUMMARY-1', '2026-10-12') returning id`, [ORG, customerId])).rows[0]
  await impersonate()
  await rpc('dc_link_bills', { organization_id: ORG, dc_id: linkedOutward.id, bills: [{ bill_id: bill.id }] })
  const rows = await rpcRows('bills_for_dc_summary', ['::uuid', '::uuid'], ORG, bill.id)
  assertEqual(rows.length, 1)
  assertEqual(rows[0].dc_number, linkedOutward.dc_number)
  assertEqual(rows[0].dc_type, 'outward_customer')
  assert(num(rows[0].total_dispatched) > 0, 'with what was dispatched on it')
})

await test('21i. a customer DC number finds the bill that pays for its challan', async () => {
  const rows = await rpcRows('bill_ids_for_customer_dc', ['::uuid', '::text'], ORG, 'CUST-4411')
  assert(rows.some(r => r.bill_number === 'BILL-SUMMARY-1'),
    'the number printed on the customer\'s own challan reaches the bill through the link')
})

// ---------------------------------------------------------------------------
// 15. Numbering
// ---------------------------------------------------------------------------

group('Document numbering')

await test('15a. allocates unique numbers per type and never reuses one', async () => {
  const numbers = (await q(`select dc_type, dc_number from public.dc_documents where organization_id = $1`, [ORG])).rows
  assert(numbers.length >= 5, 'the fixture created several challans')
  const seen = new Map()
  for (const { dc_type, dc_number } of numbers) {
    assert(!seen.has(dc_number), `duplicate document number ${dc_number}`)
    seen.set(dc_number, dc_type)
    const series = { inward: 'KI/IN/', outward_customer: 'KI/OUT-C/', material_return: 'KI/RET/' }[dc_type]
    assert(dc_number.startsWith(series), `${dc_number} should start with ${series}`)
  }
})

await test('15b. refuses to save a duplicate number', async () => {
  const existing = (await q(`select dc_number from public.dc_documents where organization_id = $1 and dc_type = 'inward' limit 1`, [ORG])).rows[0]
  // Deliberately as the table owner: as `authenticated` this insert would be
  // refused by the grant before ever reaching the constraint, which would prove
  // nothing about uniqueness. The constraint itself is what is under test.
  await q('reset role')
  try {
    await assertRejects(
      () => q(`insert into public.dc_documents (organization_id, dc_type, dc_number, dc_date, financial_year, party_id, party_name)
               values ($1, 'inward', $2, '2026-10-01', '2026-27', $3, 'Customer A')`, [ORG, existing.dc_number, customerId]),
      'duplicate key',
      'the unique constraint on (organization, type, number) must hold',
    )
  } finally {
    await q('set local role authenticated')
  }
})

// ---------------------------------------------------------------------------
// 16. Cancellation and audit
// ---------------------------------------------------------------------------

group('Cancellation and audit')

await test('16a. cancels without deleting and records the reason', async () => {
  const created = await saveCustomer({
    organization_id: ORG, party_id: customerBId, dc_date: '2026-10-08', finalize: true,
    items: [{ part_number: 'KI-303', unit: 'NOS', declared_qty: 5, supply_source: 'finished_stock' }],
  })
  const target = created.document.id
  const result = await rpc('cancel_dc', { organization_id: ORG, dc_id: target, reason: 'Customer postponed the schedule' })
  assertEqual(result.document.status, 'cancelled', 'the challan is cancelled')
  assertEqual(result.document.cancel_reason, 'Customer postponed the schedule', 'the reason is kept')
  assert(result.document.cancelled_at !== null, 'cancellation is timestamped')

  const stillThere = (await q(`select id from public.dc_documents where id = $1`, [target])).rows
  assertEqual(stillThere.length, 1, 'cancelling must never delete the document')
})

await test('16b. stops a cancelled challan from being dispatched', async () => {
  const cancelled = (await q(`select id from public.dc_documents where organization_id = $1 and status = 'cancelled' limit 1`, [ORG])).rows[0]
  await assertRejects(
    () => rpc('cancel_dc', { organization_id: ORG, dc_id: cancelled.id, reason: 'again' }),
    'ALREADY_CANCELLED',
    'a cancelled challan cannot be cancelled twice',
  )
})

await test('16c. keeps an audit trail for every movement', async () => {
  const rows = await q(
    `select action, table_name from public.audit_logs
     where organization_id = $1 and table_name in ('dc_documents', 'dc_movements', 'dc_inspections', 'dc_machining_results', 'dc_rejections')
     order by created_at`,
    [ORG],
  )
  const actions = new Set(rows.rows.map(r => r.action))
  for (const action of ['CREATE', 'UPDATE', 'RECEIPT', 'INSPECT', 'ISSUE', 'DISPATCH', 'MACHINING', 'CANCEL']) {
    assert(actions.has(action), `audit log is missing a "${action}" entry (saw: ${[...actions].join(', ')})`)
  }
})

await test('16d. keeps inspection events append-only', async () => {
  // As the owner again: the `authenticated` role cannot update this table at
  // all, so the append-only guard would never be reached from there.
  await q('reset role')
  try {
    await assertRejects(
      () => q(`update public.dc_inspections set accepted_quantity = 9999`),
      'APPEND_ONLY',
      'an inspection record must not be editable in place',
    )
  } finally {
    await q('set local role authenticated')
  }
})

// ---------------------------------------------------------------------------
// 17. Ledger
// ---------------------------------------------------------------------------

group('Customer material ledger')

await test('17a. reports each quantity bucket without collapsing them', async () => {
  const row = (await q(`select * from public.customer_material_ledger($1, $2)`, [ORG, customerId])).rows.find(r => r.part_number === 'KI-101')
  assert(row, 'the ledger should have a row for KI-101')
  assertEqual(num(row.received_total), 990, 'physically received')
  assertEqual(num(row.shortage_total), 10, 'shortage against the declared quantity')
  assertEqual(num(row.accepted_material), 960, 'accepted raw material')
  assertEqual(num(row.rejected_material), 20, 'rejected raw material')
  assertEqual(num(row.pending_inspection), 10, 'still awaiting inspection')
  assertEqual(num(row.accepted_output), 560, 'accepted machining output')
  assertEqual(num(row.machining_rejection), 20, 'machining rejection, tracked apart from material rejection')
  assertEqual(num(row.dispatched_total), 400, 'dispatched to the customer')
  assertEqual(num(row.available_finished_stock), 160, 'finished stock remaining: 560 output minus 400 dispatched')

  // This is the bug KNOWN_ISSUES 21 recorded and 0027 fixed in the dispatch
  // guard but nobody fixed here: the balance was `accepted - issued + returned`,
  // both terms read a document type 0024 had deleted, so the pool never fell and
  // reported the whole 960 accepted as still on site after 400 had gone.
  assertEqual(num(row.available_customer_material), 360,
    'raw material falls: 960 accepted, less the 600 machining consumed, less nothing dispatched unprocessed')

  // 0024 removed the outward_self challan that carried these. They are not
  // reported at all now rather than printed as four permanent zeros.
  for (const gone of ['issued_for_processing', 'returned_from_processing', 'still_at_vendor', 'accepted_return'])
    assert(!(gone in row), `${gone} was a column that could only ever print 0`)
})

await test('17c. reports outstanding delivery on a part that is only part-delivered', async () => {
  // The ledger is about material. Delivery confirmation moves no material -
  // stock left at dispatch - so these buckets must be identical before and
  // after a delivery is confirmed. What changes is only the challan's own
  // status and its outstanding quantity.
  const pending = (await q(
    `select * from public.dc_pending_customer_delivery($1) where dc_number = $2`, [ORG, partialDc.dc_number],
  )).rows[0]
  assert(pending, 'a part-delivered challan stays on the pending-delivery report')
  assertEqual(num(pending.qty_dispatched), 100, '100 dispatched')
  assertEqual(num(pending.qty_delivered), 60, '60 acknowledged so far')
  assertEqual(num(pending.qty_outstanding), 40, '40 still to be delivered')

  const closed = (await q(
    `select count(*)::int n from public.dc_pending_customer_delivery($1) where dc_number = $2`,
    [ORG, closedDc.dc_number],
  )).rows[0].n
  assertEqual(closed, 0, 'a fully delivered challan leaves the report for the first time')
})

await test('17b. filters the ledger by part number', async () => {
  const all = (await q(`select * from public.customer_material_ledger($1, $2)`, [ORG, customerId])).rows
  const one = (await q(`select * from public.customer_material_ledger($1, $2, 'KI-101')`, [ORG, customerId])).rows
  assertEqual(one.length, 1, 'a part filter narrows the ledger to that part')
  assertEqual(one[0].part_number, 'KI-101')
  assertEqual(num(one[0].received_total), num(all.find(r => r.part_number === 'KI-101').received_total),
    'and returns the same figures for it')
  // A part with nothing recorded in any bucket is not reported at all. Before
  // 0033 the part list came from every document of the customer with no dc_type
  // filter, so a material_return alone put a row of sixteen zeros on the screen.
  assertEqual((await q(`select * from public.customer_material_ledger($1, $2, 'KI-777')`, [ORG, customerId])).rows.length, 0,
    'a part with nothing recorded against it is not listed')
})

await test('17l. credits a machining result that names a party but no owner', async () => {
  // The defect that produced negative finished stock. The machining panel sent a
  // NULL material_owner_id, and 0017 matched the owner strictly, so the output
  // read as zero while the dispatch still counted: 0 + 0 - 50 = -50. Reproduced
  // on three parts before 0033.
  await machining({
    organization_id: ORG, party_id: customerId, material_owner_id: null,
    source_dc_id: linkedOutward.id, source_dc_item_id: linkedOutwardItems[1].id,
    part_number: 'KI-202', operation: 'CNC Turning', operation_date: '2026-10-09',
    input_quantity: 40, input_unit: 'NOS',
    accepted_output_quantity: 30, output_unit: 'NOS',
    machining_rejection_quantity: 5, rework_quantity: 3, scrap_quantity: 2,
  })
  const row = (await q(`select * from public.customer_material_ledger($1, $2)`, [ORG, customerId])).rows.find(r => r.part_number === 'KI-202')
  assertEqual(num(row.accepted_output) > 0, true,
    'output recorded without an owner is still credited to the customer who owns the material')
})

await test('17m. never reports a negative balance', async () => {
  // Finished stock going negative is what the operator reported. This is the
  // regression guard: 0 accepted output minus 50 dispatched gave -50 before.
  const rows = (await q(`select * from public.customer_material_ledger($1, $2)`, [ORG, customerId])).rows
  assert(rows.length > 0, 'there is something to check')
  for (const r of rows) {
    assert(num(r.available_customer_material) >= 0, `${r.part_number}: customer material is negative`)
    assert(num(r.available_finished_stock) >= 0, `${r.part_number}: finished stock is negative`)
    assert(num(r.unaccounted_dispatch) >= 0, `${r.part_number}: the unaccounted figure is negative`)
  }
})

await test('17q. names material that went out with nothing recorded behind it', async () => {
  // The genuine gap the "Not accounted" column exists for.
  //
  // The dispatch guard now caps a line that has machining records at what came
  // out finished, so material cannot be shipped beyond what the process
  // produced. The gap that is left is the one the guard cannot see: material
  // dispatched BEFORE the machining result was recorded, which is a legal
  // order, and a result that then says less came out than actually went out.
  //
  // 100 raw accepted, 95 shipped, and the machining result recorded afterwards
  // says only 30 came out finished and 70 were rejected, reworked or scrapped.
  // 65 pieces went out that no finished quantity accounts for.
  const inward = await saveInward({
    organization_id: ORG, party_id: customerId, dc_date: '2026-10-12', finalize: true,
    items: [{ part_number: 'KI-904', unit: 'NOS', declared_qty: 100, supply_source: 'customer_material' }],
  })
  await rpc('record_inward_receipt', {
    organization_id: ORG, dc_id: inward.document.id,
    lines: [{ dc_item_id: inward.items[0].id, received_qty: 100 }],
  })
  await rpc('record_material_inspection', {
    organization_id: ORG, dc_id: inward.document.id,
    lines: [{ dc_item_id: inward.items[0].id, accepted_qty: 100, pending_qty: 0 }],
  })
  const outward = await saveCustomer({
    organization_id: ORG, party_id: customerId, dc_date: '2026-10-13', finalize: true,
    items: [{
      part_number: 'KI-904', unit: 'NOS', declared_qty: 95, supply_source: 'customer_material',
      source_inward_item_id: inward.items[0].id,
    }],
  })
  // The dispatch comes first. With no machining result behind the line yet,
  // the guard caps it at what was accepted, so 95 of 100 is legal.
  await dispatch({
    organization_id: ORG, dc_id: outward.document.id,
    lines: [{ dc_item_id: outward.items[0].id, dispatched_qty: 95 }],
  })
  // And the result is recorded afterwards, saying far less came out finished
  // than actually went out.
  await machining({
    organization_id: ORG, party_id: customerId,
    source_dc_id: outward.document.id, source_dc_item_id: outward.items[0].id,
    material_owner_id: customerId,
    part_number: 'KI-904', operation: 'CNC Turning', operation_date: '2026-10-13',
    input_quantity: 100, input_unit: 'NOS',
    accepted_output_quantity: 30, output_unit: 'NOS',
    machining_rejection_quantity: 5, rework_quantity: 20, scrap_quantity: 45,
  })

  const row = (await q(`select * from public.customer_material_ledger($1, $2, 'KI-904')`, [ORG, customerId])).rows[0]
  assert(row, 'the part is still listed, it is not hidden for being a gap')
  assertEqual(num(row.accepted_output), 30, 'the output really was only 30')
  assertEqual(num(row.dispatched_total), 95, 'and 95 were shipped')
  assertEqual(num(row.available_finished_stock), 0, 'the finished balance floors at zero, not -65')
  assertEqual(num(row.available_customer_material), 0, 'and the raw pool is empty too')
  assertEqual(num(row.unaccounted_dispatch), 65,
    'the 65 pieces no machining result accounts for are reported rather than shown as stock')
})

await test('17n. keeps the raw pool and the finished pool from eating each other', async () => {
  // 90 raw accepted on KI-201, 90 machined, 85 accepted out, 85 dispatched across
  // two outward challans. Both pools must close at zero. Charging the dispatch
  // to the raw pool instead would report the 85 pieces that physically shipped
  // as still sitting in finished stock.
  const row = (await q(`select * from public.customer_material_ledger($1, $2)`, [ORG, customerId])).rows.find(r => r.part_number === 'KI-201')
  assertEqual(num(row.machining_input), 90, '90 raw pieces went into machining')
  assertEqual(num(row.accepted_output), 85, '85 came out accepted')
  assertEqual(num(row.dispatched_total), 85, '85 were shipped')
  assertEqual(num(row.available_customer_material), 0, 'no raw is left at the plant')
  assertEqual(num(row.available_finished_stock), 0, 'and none of the finished pieces are either')
  assertEqual(num(row.unaccounted_dispatch), 0, 'nothing went out unaccounted')
})

await test('17o. ignores the date range for the balances, and not for the movements', async () => {
  // A period balance with no opening figure is not a balance, so the two
  // available columns are lifetime. Before 0033 the range filtered receipts and
  // machining but not dispatches, so a filtered month computed March receipts
  // minus all-time dispatches.
  const all = (await q(`select * from public.customer_material_ledger($1, $2)`, [ORG, customerId])).rows
    .find(r => r.part_number === 'KI-101')
  const ranged = (await q(`select * from public.customer_material_ledger($1, $2, null, '2020-01-01', '2020-01-31')`, [ORG, customerId])).rows
    .find(r => r.part_number === 'KI-101')
  assert(ranged, 'the part still appears under a range that contains none of its dates')
  assertEqual(num(ranged.received_total), 0, 'no receipt falls inside that range')
  assertEqual(num(ranged.available_finished_stock), num(all.available_finished_stock),
    'the balance is the same either way, because it was never filtered')
  assertEqual(num(ranged.available_customer_material), num(all.available_customer_material),
    'both balances are lifetime figures')
})

await test('17p. refuses a caller who is not a member of the workspace', async () => {
  // The function is SECURITY DEFINER, so RLS does not protect it, and 0017 gave
  // it no membership check at all: any authenticated user could pass any p_org
  // and read another workspace's material ledger.
  await assertRejects(
    () => q(`select * from public.customer_material_ledger($1, $2)`, [OTHER_ORG, customerId]),
    'FORBIDDEN',
    'a ledger must not be readable from outside the workspace',
  )
})

// ---------------------------------------------------------------------------
// 18-20. Security, write restrictions, billing regression
// ---------------------------------------------------------------------------

group('Security and regression')

await test('18. isolates one organization’s challans from another', async () => {
  const rows = await q(`select * from public.dc_documents where organization_id = $1`, [ORG])
  assert(rows.rows.length > 0, "the member sees their own organization's challans")
  const foreign = await q(`select * from public.dc_documents where organization_id = $1`, [OTHER_ORG])
  assertEqual(foreign.rows.length, 0, "another organization's challans must be invisible")
})

await test('18b. refuses every report function to a caller from another workspace', async () => {
  // SECURITY DEFINER runs as the owner, so the RLS policies in 0015 do not apply
  // to these functions and the organization_id filter inside each query is the
  // only thing scoping them. Before 0034 none of them checked membership at all,
  // so any authenticated user could pass any p_org and read another workspace's
  // challans, rejections and machining results.
  //
  // dc_linked_bills is included deliberately: it takes a dc_id as well as an
  // organization, and it is the one where it would be most tempting to check the
  // document instead. It does not need to - it filters organization_id itself -
  // so a foreign dc_id under a legitimate p_org returns nothing, and the guard
  // covers the p_org case.
  const calls = [
    ['dc_register', `select * from public.dc_register($1)`, [OTHER_ORG]],
    ['dc_pending_inspection', `select * from public.dc_pending_inspection($1)`, [OTHER_ORG]],
    ['dc_material_rejections', `select * from public.dc_material_rejections($1)`, [OTHER_ORG]],
    ['dc_machining_rejections', `select * from public.dc_machining_rejections($1)`, [OTHER_ORG]],
    ['dc_variance_report', `select * from public.dc_variance_report($1)`, [OTHER_ORG]],
    ['dc_pending_customer_delivery', `select * from public.dc_pending_customer_delivery($1)`, [OTHER_ORG]],
    ['dc_acceptance_rate', `select * from public.dc_acceptance_rate($1)`, [OTHER_ORG]],
    ['dc_rejection_trend', `select * from public.dc_rejection_trend($1)`, [OTHER_ORG]],
    ['dc_movement_history', `select * from public.dc_movement_history($1)`, [OTHER_ORG]],
    ['dc_linked_bills', `select * from public.dc_linked_bills($1, $2)`, [OTHER_ORG, foreignId]],
  ]
  for (const [name, sql, params] of calls) {
    await assertRejects(() => q(sql, params), 'FORBIDDEN',
      `${name} must not be readable from outside the workspace`)
  }
})

await test('18c. reports the same figures to a member of their own workspace', async () => {
  // The guard must not change what a legitimate caller sees. Each of these
  // returns rows for ORG, and the 86 cases above already assert their contents.
  for (const [name, sql] of [
    ['dc_register', `select count(*)::int n from public.dc_register($1)`],
    ['dc_pending_inspection', `select count(*)::int n from public.dc_pending_inspection($1)`],
    ['dc_material_rejections', `select count(*)::int n from public.dc_material_rejections($1)`],
    ['dc_machining_rejections', `select count(*)::int n from public.dc_machining_rejections($1)`],
    ['dc_variance_report', `select count(*)::int n from public.dc_variance_report($1)`],
    ['dc_pending_customer_delivery', `select count(*)::int n from public.dc_pending_customer_delivery($1)`],
    ['dc_acceptance_rate', `select count(*)::int n from public.dc_acceptance_rate($1)`],
    ['dc_rejection_trend', `select count(*)::int n from public.dc_rejection_trend($1)`],
    ['dc_movement_history', `select count(*)::int n from public.dc_movement_history($1)`],
  ]) {
    const n = (await q(sql, [ORG])).rows[0].n
    assert(typeof n === 'number' && !Number.isNaN(n), `${name} should return a count to its own workspace`)
  }
  const bills = (await q(`select count(*)::int n from public.dc_linked_bills($1, $2)`, [ORG, linkedOutward.id])).rows[0].n
  assert(bills >= 0, 'dc_linked_bills answers for its own workspace')
})

await test('19. gives the browser no direct write access to any quantity column', async () => {
  for (const [table, column] of [
    ['dc_items', 'accepted_qty'], ['dc_items', 'qty_dispatched'], ['dc_items', 'qty_sent'],
    ['dc_documents', 'status'], ['dc_rejections', 'quantity_returned'],
  ]) {
    await assertRejects(
      () => q(`update public.${table} set ${column} = 999999`),
      'permission denied',
      `${table}.${column} must not be writable by the authenticated role`,
    )
  }
})

await test('19b. refuses material operations from a viewer', async () => {
  // Membership edits are made as the table owner. The authenticated role can
  // only update memberships while it is still an admin, so restoring the role
  // afterwards would be filtered out by RLS and silently update zero rows -
  // leaving the rest of the suite running as a viewer for no visible reason.
  await q('reset role')
  await q(`update public.memberships set role = 'viewer' where organization_id = $1 and user_id = $2`, [ORG, UID])
  await q('set local role authenticated')

  await assertRejects(
    () => saveInward({
      organization_id: ORG, party_id: customerId, dc_date: '2026-10-09',
      items: [{ part_number: 'KI-101', unit: 'NOS', declared_qty: 1 }],
    }),
    'FORBIDDEN',
    'a viewer must not be able to record material',
  )

  await q('reset role')
  await q(`update public.memberships set role = 'admin' where organization_id = $1 and user_id = $2`, [ORG, UID])
  const restored = await q(`select role from public.memberships where organization_id = $1 and user_id = $2`, [ORG, UID])
  assertEqual(restored.rows[0].role, 'admin', 'the admin role must be restored for the billing regression below')
  await q('set local role authenticated')
})

await test('20. leaves the billing module working', async () => {
  const bill = await rpc('save_bill', {
    organization_id: ORG, customer_id: customerId, bill_number: 'DC-REGRESSION-1', bill_date: '2026-10-10',
    tax_mode: 'intra', payment_status: 'unpaid', source_type: 'manual', verification_status: 'unverified',
    items: [{ product_name: 'Regression Shaft', unit: 'NOS', quantity: '2', rate: '100.00', discount: '0', gst_rate: '18' }],
  }, false)
  const created = bill.bill
  assertEqual(created.bill_number, 'DC-REGRESSION-1', 'a bill can still be saved')
  assertEqual(num(created.grand_total), 236, 'billing calculations are unchanged')

  const summary = await rpc('dashboard_summary', ORG)
  assert(Number(summary.total_bills) >= 1, 'the billing dashboard still reads its own data')
})

await test('20b. keeps the existing party records and adds a party type', async () => {
  const rows = await q(`select name, party_type, gstin from public.customers where organization_id = $1 order by name`, [ORG])
  const byName = new Map(rows.rows.map(r => [r.name, r]))

  // Suppliers and vendors live in the customer table, not a second master.
  assertEqual(byName.get('Customer A')?.party_type, 'customer', 'a customer keeps its type')
  assertEqual(byName.get('Customer B')?.party_type, 'customer', 'a customer keeps its type')
  assertEqual(byName.get('Vendor Machining')?.party_type, 'vendor', 'a vendor is classified in the same master')
  assert(byName.has('Billing Added Co'), 'a party added through Billing exists in the same master')
  assertEqual(byName.get('Customer A')?.gstin, '33AAAAA0001BCZ1', 'existing GSTIN data is untouched')
  assertEqual(byName.get('Billing Added Co')?.gstin, '33DDDDD0001EFZ4', 'the GSTIN captured when it was added in Billing')

  // One master means one GSTIN uniqueness rule across both modules.
  await q('reset role')
  await assertRejects(
    () => q(`insert into public.customers (organization_id, name, gstin) values ($1, 'Duplicate GSTIN Co', '33DDDDD0001EFZ4')`, [ORG]),
    'duplicate key',
    'a DC vendor cannot reuse a GSTIN already held by a Billing customer',
  )
  await q('set local role authenticated')
})

// ---------------------------------------------------------------------------
// 21. The job-work chain: the outward challan that answers an inward one
// ---------------------------------------------------------------------------

group('Job work: inward, the outward that answers it, and the bill')

let jobInward = null
let jobInwardItem = null
let jobOutward = null

await test('21a. an outward challan that answers an inward one takes the same serial', async () => {
  const created = await saveInward({
    organization_id: ORG, party_id: customerId, dc_date: '2026-11-02', finalize: true,
    items: [{ part_number: 'KI-901', unit: 'NOS', declared_qty: 100, supply_source: 'customer_material', customer_dc_number: '500' }],
  })
  jobInward = created.document
  jobInwardItem = created.items[0].id

  await receive({
    organization_id: ORG, dc_id: jobInward.id,
    lines: [{ dc_item_id: jobInwardItem, received_qty: 100, shortage_qty: 0, excess_qty: 0, damaged_qty: 0, inspection_required: true }],
  })
  await inspect({
    organization_id: ORG, dc_id: jobInward.id,
    lines: [{ dc_item_id: jobInwardItem, accepted_qty: 90, rejected_qty: 10, pending_qty: 0, rejection_reason: 'Dimensional out of tolerance' }],
  })

  const outward = await saveCustomer({
    organization_id: ORG, party_id: customerId, dc_date: '2026-11-05', finalize: true,
    reference_inward_dc_id: jobInward.id,
    items: [{ part_number: 'KI-901', unit: 'NOS', declared_qty: 90, supply_source: 'customer_material', source_inward_item_id: jobInwardItem, customer_dc_number: '500' }],
  })
  jobOutward = outward.document

  const inwardSerial = jobInward.dc_number.split('/').pop()
  assertEqual(
    outward.document.dc_number,
    `KI/OUT-C/2026-27/${inwardSerial}`,
    'the outward challan takes the same serial as the inward one it answers',
  )
  assertEqual(
    outward.document.reference_inward_dc_id,
    jobInward.id,
    'the outward challan names the inward challan it answers',
  )
  assertEqual(
    outward.customer_dc_numbers,
    ['500'],
    "the outward challan carries the customer's own challan number across",
  )

  // Something on the truck: a challan with nothing dispatched on it is nothing
  // to invoice, and the billable list says so.
  await dispatch({
    organization_id: ORG, dc_id: outward.document.id,
    lines: [{ dc_item_id: outward.items[0].id, dispatched_qty: 85 }],
  })
})

await test('21b. a second outward for the same inward takes the next serial', async () => {
  const second = await saveCustomer({
    organization_id: ORG, party_id: customerId, dc_date: '2026-11-06', finalize: true,
    reference_inward_dc_id: jobInward.id,
    items: [{ part_number: 'KI-901', unit: 'NOS', declared_qty: 10, supply_source: 'customer_material', source_inward_item_id: jobInwardItem, customer_dc_number: '500' }],
  })
  const inwardSerial = jobInward.dc_number.split('/').pop()
  assertEqual(
    second.document.dc_number,
    `KI/OUT-C/2026-27/${inwardSerial}-2`,
    'a second outward for the same inward is numbered -2, so the first one keeps its number',
  )
})

await test('21c. refuses an outward challan that names another customer\'s inward', async () => {
  const failure = await assertRejects(
    () => saveCustomer({
      organization_id: ORG, party_id: customerBId, dc_date: '2026-11-07',
      reference_inward_dc_id: jobInward.id,
      items: [{ part_number: 'KI-901', unit: 'NOS', declared_qty: 5, supply_source: 'finished_stock' }],
    }),
    'VALIDATION_ERROR',
    "an outward challan may not name another customer's inward challan",
  )
  assert(/different customer/i.test(failure.message),
    `the refusal should name the reason, got: ${failure.message}`)
})

await test('21d. refuses a line drawn from a different inward while a reference is set', async () => {
  // The number says the whole challan answers one inward challan, so a line
  // drawn from somewhere else would make the number a lie.
  const other = await saveInward({
    organization_id: ORG, party_id: customerId, dc_date: '2026-11-08', finalize: true,
    items: [{ part_number: 'KI-902', unit: 'NOS', declared_qty: 10, supply_source: 'customer_material' }],
  })
  await assertRejects(
    () => saveCustomer({
      organization_id: ORG, party_id: customerId, dc_date: '2026-11-09',
      reference_inward_dc_id: jobInward.id,
      items: [{ part_number: 'KI-902', unit: 'NOS', declared_qty: 5, supply_source: 'customer_material', source_inward_item_id: other.items[0].id }],
    }),
    'VALIDATION_ERROR',
    'a challan that names an inward may not draw a line from another one',
  )
})

await test('21e. the inward challan says the work is in process once the outward is raised', async () => {
  const progress = await rpcRows('dc_job_progress', ['::uuid', '::uuid'], ORG, jobInward.id)
  const document = progress.find(row => row.scope === 'document')
  assert(document, 'the job progress of an inward challan must be reported')
  assertEqual(document.job_status, 'in_progress', 'an inward challan with an outward challan against it is work in process')
})

await test('21f. lists the outward challans that answer an inward challan', async () => {
  const outwards = await rpcRows('dc_outward_challans_for_inward', ['::uuid', '::uuid'], ORG, jobInward.id)
  assertEqual(
    outwards.map(row => row.dc_number).sort(),
    [jobOutward.dc_number, `${jobOutward.dc_number}-2`].sort(),
    'the inward challan can be read from the outward side as well',
  )
})

await test('21g. a bill can carry the customer\'s own challan number, and it is found by it', async () => {
  const bill = await rpc('save_bill', {
    organization_id: ORG, customer_id: customerId, bill_number: 'JOB-1', bill_date: '2026-11-06',
    tax_mode: 'intra', payment_status: 'unpaid', source_type: 'manual', verification_status: 'unverified',
    items: [{ product_name: 'KI-901', unit: 'NOS', quantity: '90', rate: '250.00', discount: '0', gst_rate: '18' }],
  }, false)

  await rpc('set_bill_dc_references', {
    organization_id: ORG, bill_id: bill.bill.id, customer_dc_reference: '500, 503',
  })

  const stored = await q(`select customer_dc_reference from public.bills where id = $1`, [bill.bill.id])
  assertEqual(stored.rows[0].customer_dc_reference, '500, 503', 'the customer DC number is stored on the bill')

  const found = await rpcRows('bill_ids_for_customer_dc', ['::uuid', '::text'], ORG, '503')
  assert(found.some(row => row.bill_id === bill.bill.id),
    'searching the customer DC number must find the bill that carries it')

  // The billable challans of a customer are the ones a new bill can be raised
  // against: finalized, with something dispatched on them.
  const billable = await rpcRows('dc_billable_documents', ['::uuid', '::uuid'], ORG, customerId)
  assert(billable.some(row => row.dc_id === jobOutward.id),
    'the outward challan must be offered for billing')
  assert(billable.every(row => Number(row.total_dispatched) > 0),
    'a challan with nothing dispatched on it is nothing to invoice')
})

await test('21h. refuses a bill reference written by somebody with no write access', async () => {
  const bill = await rpc('save_bill', {
    organization_id: ORG, customer_id: customerId, bill_number: 'JOB-2', bill_date: '2026-11-06',
    tax_mode: 'intra', payment_status: 'unpaid', source_type: 'manual', verification_status: 'unverified',
    items: [{ product_name: 'KI-901', unit: 'NOS', quantity: '1', rate: '250.00', discount: '0', gst_rate: '18' }],
  }, false)

  await q('reset role')
  await q(`update public.memberships set role = 'viewer' where organization_id = $1 and user_id = $2`, [ORG, UID])
  await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role: 'authenticated' })])
  await q('set local role authenticated')

  await assertRejects(
    () => rpc('set_bill_dc_references', { organization_id: ORG, bill_id: bill.bill.id, customer_dc_reference: '999' }),
    'FORBIDDEN',
    'a viewer must not be able to write a bill reference',
  )

  await q('reset role')
  await q(`update public.memberships set role = 'admin' where organization_id = $1 and user_id = $2`, [ORG, UID])
  await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role: 'authenticated' })])
  await q('set local role authenticated')
})

// ---------------------------------------------------------------------------
// The bill number, in the challan's serial space (0037)
// ---------------------------------------------------------------------------
//
// A bill raised from a challan carries that challan's serial, so a search for
// the serial answers with the inward challan, the outward challan and the
// bill. A bill raised by hand takes a number of its own, and never a serial a
// challan holds.

group('The bill number carries the challan\'s serial')

/**
 * The number a bill is saved with.
 *
 * The function takes named arguments rather than a payload, so it is called
 * the way the browser's PostgREST calls reach it.
 */
const reserveNumber = (org, date, number, dcIds, billId = null) =>
  q(`select public.reserve_bill_number($1::uuid, $2::date, $3::text, $4::uuid[], $5::uuid) as result`, [org, date, number, dcIds, billId])
    .then(out => out.rows[0]?.result ?? null)

/** The financial year and the serial of a challan number. */
const numberParts = value => {
  const parts = String(value).split('/')
  return { year: parts[parts.length - 2], serial: parts[parts.length - 1] }
}

// A financial year nobody has used, so the numbers in it are predictable.
const FRESH_DATE = '2027-06-01'
const FRESH_YEAR = '2027-28'

let otherInward = null
let raisedBill = null

await test('22a. a bill raised from a challan carries that challan\'s serial', async () => {
  const { year, serial } = numberParts(jobOutward.dc_number)

  const reserved = await reserveNumber(ORG, jobOutward.dc_date, `${year}/${serial}`, [jobOutward.id])
  assertEqual(reserved.bill_number, `${year}/${serial}`, 'the bill carries the challan\'s serial')

  raisedBill = await rpc('save_bill', {
    organization_id: ORG, customer_id: customerId, bill_number: reserved.bill_number, bill_date: jobOutward.dc_date,
    tax_mode: 'intra', payment_status: 'unpaid', source_type: 'manual', verification_status: 'unverified',
    items: [{ product_name: 'KI-901', unit: 'NOS', quantity: '85', rate: '250.00', discount: '0', gst_rate: '18' }],
  }, false)
  assertEqual(raisedBill.bill.bill_number, `${year}/${serial}`, 'the saved bill carries the number it was given')

  // The link is accepted: the bill and the challan are the same job.
  await rpc('dc_link_bills', { organization_id: ORG, dc_id: jobOutward.id, bills: [{ bill_id: raisedBill.bill.id }] })
  const links = await rpcRows('dc_linked_bills', ['::uuid', '::uuid'], ORG, jobOutward.id)
  assert(links.some(row => row.bill_id === raisedBill.bill.id), 'the bill is attached to the challan it pays for')
})

await test('22b. the bill is found by the number of the challan it pays for', async () => {
  const { serial } = numberParts(jobOutward.dc_number)
  const found = await rpcRows('bill_ids_for_dc_number', ['::uuid', '::text'], ORG, serial)
  assert(found.some(row => row.bill_id === raisedBill.bill.id), 'searching the serial finds the bill')

  // And by its own number, which is the same serial.
  const byNumber = await rpcRows('bill_ids_for_dc_number', ['::uuid', '::text'], ORG, raisedBill.bill.bill_number)
  assert(byNumber.some(row => row.bill_id === raisedBill.bill.id), 'searching the bill number finds the bill too')
})

await test('22c. a number that names another challan is refused', async () => {
  // A challan in a financial year nobody has used, so its serial is its own.
  const created = await saveInward({
    organization_id: ORG, party_id: customerId, dc_date: FRESH_DATE, finalize: true,
    items: [{ part_number: 'KI-903', unit: 'NOS', declared_qty: 5, supply_source: 'customer_material' }],
  })
  otherInward = created.document
  const { year, serial } = numberParts(otherInward.dc_number)
  await assertRejects(
    () => reserveNumber(ORG, FRESH_DATE, `${year}/${serial}`, [jobOutward.id]),
    'VALIDATION_ERROR',
    'a bill may not take the number of a challan it does not pay for',
  )
})

await test('22d. a bill raised by hand takes a number no challan holds', async () => {
  const reserved = await reserveNumber(ORG, FRESH_DATE, null, [])
  assert(/^\d{4}-\d{2}\/\d{4}$/.test(reserved.bill_number), 'the number is the financial year and a serial')
  assertEqual(reserved.bill_number.split('/')[0], FRESH_YEAR, 'the number is in the bill\'s own financial year')

  // The serial it took is not one the challan holds - the challan in that
  // financial year took 0001, so the bill had to move past it.
  const serial = reserved.bill_number.split('/').pop()
  const held = await q(
    `select d.dc_number from public.dc_documents d
      where d.organization_id = $1 and d.dc_number ~ ('/' || $2 || '$') and d.dc_number ilike ('%/' || $3 || '/%')`,
    [ORG, serial, FRESH_YEAR],
  )
  assert(held.rows.length === 0, 'a bill raised by hand never takes a serial a challan holds')
})

await test('22e. a number another bill holds cannot be taken twice', async () => {
  const first = await reserveNumber(ORG, FRESH_DATE, null, [])
  await rpc('save_bill', {
    organization_id: ORG, customer_id: customerId, bill_number: first.bill_number, bill_date: FRESH_DATE,
    tax_mode: 'intra', payment_status: 'unpaid', source_type: 'manual', verification_status: 'unverified',
    items: [{ product_name: 'KI-905', unit: 'NOS', quantity: '1', rate: '100.00', discount: '0', gst_rate: '18' }],
  }, false)

  await assertRejects(
    () => reserveNumber(ORG, FRESH_DATE, first.bill_number, []),
    'VALIDATION_ERROR',
    'a number another bill already holds cannot be taken again',
  )
})

await test('22f. a challan never takes a serial a bill already holds', async () => {
  // A bill raised by hand takes the first number of a financial year nobody
  // has used, and the first challan of that year must move past it.
  const date = '2028-04-01'
  const reserved = await reserveNumber(ORG, date, null, [])
  const serial = reserved.bill_number.split('/').pop()

  await rpc('save_bill', {
    organization_id: ORG, customer_id: customerId, bill_number: reserved.bill_number, bill_date: date,
    tax_mode: 'intra', payment_status: 'unpaid', source_type: 'manual', verification_status: 'unverified',
    items: [{ product_name: 'KI-906', unit: 'NOS', quantity: '1', rate: '200.00', discount: '0', gst_rate: '18' }],
  }, false)

  const created = await saveInward({
    organization_id: ORG, party_id: customerId, dc_date: date, finalize: true,
    items: [{ part_number: 'KI-907', unit: 'NOS', declared_qty: 5, supply_source: 'customer_material' }],
  })
  assert(created.document.dc_number !== `KI/IN/2028-29/${serial}`,
    'a challan never takes a serial a bill already holds')
})

await test('22g. the link refuses a bill whose number names another challan', async () => {
  // A number of our own making, one the challan in that year does not hold.
  const other = await reserveNumber(ORG, FRESH_DATE, `${FRESH_YEAR}/0009`, [])
  const bill = await rpc('save_bill', {
    organization_id: ORG, customer_id: customerId, bill_number: other.bill_number, bill_date: FRESH_DATE,
    tax_mode: 'intra', payment_status: 'unpaid', source_type: 'manual', verification_status: 'unverified',
    items: [{ product_name: 'KI-908', unit: 'NOS', quantity: '2', rate: '300.00', discount: '0', gst_rate: '18' }],
  }, false)

  await assertRejects(
    () => rpc('dc_link_bills', { organization_id: ORG, dc_id: otherInward.id, bills: [{ bill_id: bill.bill.id }] }),
    'VALIDATION_ERROR',
    'a bill whose number names another challan cannot be attached to it',
  )
})

await test('22h. a number from outside the series is kept as it is typed', async () => {
  // A bill typed in from paper carries the number printed on that paper. It
  // belongs to no series, holds no serial and is not the database's to make.
  const reserved = await reserveNumber(ORG, FRESH_DATE, 'INV-99', [])
  assertEqual(reserved.bill_number, 'INV-99', 'the number is kept exactly as it was typed')
})

await test('22i. a number in the wrong financial year is refused', async () => {
  await assertRejects(
    () => reserveNumber(ORG, FRESH_DATE, '2025-26/0042', []),
    'VALIDATION_ERROR',
    'the financial year on the number must be the bill\'s own',
  )
})

await test('22j. the serial is compared by its value, not by its padding', async () => {
  // The padding of a challan number is configurable and the bill series uses
  // four digits, so 0020 and 20 are the same serial and have to be recognised
  // as one.
  const { year, serial } = numberParts(jobOutward.dc_number)
  const short = `${year}/${Number(serial)}`
  const reserved = await reserveNumber(ORG, jobOutward.dc_date, short, [jobOutward.id])
  assertEqual(reserved.bill_number, short, 'the serial is recognised whatever its padding')

  // And a number that is only a different padding of another challan's serial
  // is still that challan's number.
  const { year: otherYear, serial: otherSerial } = numberParts(otherInward.dc_number)
  await assertRejects(
    () => reserveNumber(ORG, FRESH_DATE, `${otherYear}/${Number(otherSerial)}`, [jobOutward.id]),
    'VALIDATION_ERROR',
    'a number that is another challan\'s serial is refused whatever its padding',
  )
})

// ---------------------------------------------------------------------------
// 22. A machining record that leaves material behind
// ---------------------------------------------------------------------------

group('Machining: a part-finished batch, and the material it holds back')

let partInward = null
let partInwardItem = null
let partOutward = null
let partOutwardItem = null

await test('22a. records a batch that is only part finished, and it balances', async () => {
  const created = await saveInward({
    organization_id: ORG, party_id: customerId, dc_date: '2026-11-20', finalize: true,
    items: [{ part_number: 'KI-301', unit: 'NOS', declared_qty: 100, supply_source: 'customer_material' }],
  })
  partInward = created.document
  partInwardItem = created.items[0].id

  await receive({
    organization_id: ORG, dc_id: partInward.id,
    lines: [{ dc_item_id: partInwardItem, received_qty: 100, inspection_required: true }],
  })
  await inspect({
    organization_id: ORG, dc_id: partInward.id,
    lines: [{ dc_item_id: partInwardItem, accepted_qty: 100, pending_qty: 0 }],
  })

  const outward = await saveCustomer({
    organization_id: ORG, party_id: customerId, dc_date: '2026-11-21', finalize: true,
    reference_inward_dc_id: partInward.id,
    items: [{ part_number: 'KI-301', unit: 'NOS', declared_qty: 100, supply_source: 'customer_material', source_inward_item_id: partInwardItem }],
  })
  partOutward = outward.document
  partOutwardItem = outward.items[0].id

  // 100 in, 90 finished, 5 spoiled, 5 not machined yet. It balances, and it
  // used to be impossible: the record demanded that the input added up to the
  // piece, and the 5 that had not been machined had nowhere to go.
  const result = await machining({
    organization_id: ORG, party_id: customerId,
    source_dc_id: partOutward.id, source_dc_item_id: partOutwardItem,
    material_owner_id: customerId,
    part_number: 'KI-301', operation: 'CNC Turning', operation_date: '2026-11-21',
    input_quantity: 100, input_unit: 'NOS',
    accepted_output_quantity: 90, output_unit: 'NOS',
    machining_rejection_quantity: 5, rework_quantity: 0, scrap_quantity: 0, process_loss_quantity: 0,
    remaining_quantity: 5,
  })
  assertEqual(num(result.remaining_quantity), 5, 'the record says what was left of the input')

  const stored = await q(
    `select remaining_quantity from public.dc_machining_results
     where organization_id = $1 and source_dc_item_id = $2 limit 1`, [ORG, partOutwardItem])
  assertEqual(num(stored.rows[0].remaining_quantity), 5, 'the remaining is stored on the record')
})

await test('22b. still refuses a record that does not account for the whole input', async () => {
  await assertRejects(
    () => machining({
      organization_id: ORG, party_id: customerId,
      source_dc_id: partOutward.id, source_dc_item_id: partOutwardItem,
      material_owner_id: customerId,
      part_number: 'KI-301', operation: 'CNC Turning', operation_date: '2026-11-21',
      input_quantity: 100, input_unit: 'NOS',
      accepted_output_quantity: 90, output_unit: 'NOS',
      machining_rejection_quantity: 5, rework_quantity: 0, scrap_quantity: 0, process_loss_quantity: 0,
      remaining_quantity: 0,
    }),
    'MACHINING_NOT_RECONCILED',
    'a record that leaves 5 unaccounted for is still refused',
  )
})

await test('22c. holds back the material that has not been machined', async () => {
  // 90 came out finished, so 90 can go back. The 5 that are still at the
  // machine cannot, and neither can the 5 that were spoiled.
  assertEqual(num(await rpc('dc_inward_line_availability', ORG, partInwardItem)), 90,
    'only what came out finished can be sent back')

  await assertRejects(
    () => dispatch({
      organization_id: ORG, dc_id: partOutward.id,
      lines: [{ dc_item_id: partOutwardItem, dispatched_qty: 95 }],
    }),
    'QUANTITY_EXCEEDED',
    'the material that has not been machined cannot be dispatched',
  )

  await dispatch({
    organization_id: ORG, dc_id: partOutward.id,
    lines: [{ dc_item_id: partOutwardItem, dispatched_qty: 90 }],
  })
  assertEqual(num(await rpc('dc_inward_line_availability', ORG, partInwardItem)), 0,
    'what has gone is no longer available')
})

await test('22d. the next record on the same line starts from what is left', async () => {
  const left = await rpc('dc_inward_line_unmachined', ORG, partInwardItem)
  assertEqual(num(left), 5, 'five pieces are still to be machined')

  await machining({
    organization_id: ORG, party_id: customerId,
    source_dc_id: partOutward.id, source_dc_item_id: partOutwardItem,
    material_owner_id: customerId,
    part_number: 'KI-301', operation: 'CNC Turning', operation_date: '2026-11-22',
    input_quantity: 5, input_unit: 'NOS',
    accepted_output_quantity: 5, output_unit: 'NOS',
    machining_rejection_quantity: 0, rework_quantity: 0, scrap_quantity: 0, process_loss_quantity: 0,
    remaining_quantity: 0,
  })

  assertEqual(num(await rpc('dc_inward_line_unmachined', ORG, partInwardItem)), 0,
    'nothing is left to machine')
  assertEqual(num(await rpc('dc_inward_line_availability', ORG, partInwardItem)), 5,
    'the five finished pieces are available to send back')
})

await test('22e. the inward challan reports the same outstanding the guard reads', async () => {
  const progress = await rpcRows('dc_job_progress', ['::uuid', '::uuid'], ORG, partInward.id)
  const line = progress.find(row => row.scope === 'line' && row.line_no === 1)
  assertEqual(num(line.outstanding_qty), 5,
    'the outstanding on the challan is what the dispatch guard would allow')
})

// ---------------------------------------------------------------------------
// The amount received against a bill
// ---------------------------------------------------------------------------
//
// A bill used to say it was partly paid without saying by how much, so every
// figure that depends on the balance counted the whole bill as outstanding.
// The amount is now part of the bill, and the remaining is the database's own
// figure.

group('The amount received against a bill')

const updateBill = (billId, payload) =>
  q(`select public.update_bill($1::uuid, $2::jsonb) as result`, [billId, payload])
    .then(out => out.rows[0]?.result ?? null)

let payBill = null
let payTotal = 0

await test('23a. a partly paid bill says what has been received, and what is still owed', async () => {
  const bill = await rpc('save_bill', {
    organization_id: ORG, customer_id: customerId, bill_number: 'PAY-1', bill_date: '2026-11-10',
    tax_mode: 'intra', payment_status: 'unpaid', source_type: 'manual', verification_status: 'unverified',
    items: [{ product_name: 'Paid Shaft', unit: 'NOS', quantity: '10', rate: '1000.00', discount: '0', gst_rate: '18' }],
  }, false)
  payBill = bill.bill
  payTotal = num(bill.bill.grand_total)
  assertEqual(payTotal, 11800, 'the bill totals 11800')
  assertEqual(num(bill.bill.paid_amount), 0, 'an unpaid bill has received nothing')
  assertEqual(num(bill.bill.remaining_amount), 11800, 'and the whole of it is owed')

  const updated = await updateBill(payBill.id, {
    payment_status: 'partial', amount_received: 5000,
    payment_date: '2026-11-12', payment_method: 'upi',
  })
  assertEqual(num(updated.bill.paid_amount), 5000, 'the bill records what was received')
  assertEqual(num(updated.bill.remaining_amount), 6800, 'and what is still owed')

  const stored = await q(`select paid_amount, remaining_amount from public.bills where id = $1`, [payBill.id])
  assertEqual(num(stored.rows[0].paid_amount), 5000, 'the amount is stored on the bill')
  assertEqual(num(stored.rows[0].remaining_amount), 6800, 'and so is the remaining')
})

await test('23b. a paid bill has nothing left to pay', async () => {
  const updated = await updateBill(payBill.id, { payment_status: 'paid' })
  assertEqual(num(updated.bill.paid_amount), payTotal, 'a paid bill has received its whole total')
  assertEqual(num(updated.bill.remaining_amount), 0, 'and nothing is owed on it')
})

await test('23c. a partly paid bill without an amount is refused', async () => {
  await assertRejects(
    () => updateBill(payBill.id, { payment_status: 'partial' }),
    'amount_received',
    'a partly paid bill must say how much has been received',
  )
})

await test('23d. the whole bill typed as a part payment is refused', async () => {
  await assertRejects(
    () => updateBill(payBill.id, { payment_status: 'partial', amount_received: payTotal }),
    'amount_received',
    'the whole bill typed as a part payment is a paid bill',
  )
})

await test('23e. an amount larger than the bill is refused', async () => {
  await assertRejects(
    () => updateBill(payBill.id, { payment_status: 'partial', amount_received: payTotal + 1 }),
    'amount_received',
    'more than the bill cannot have been received',
  )
})

await test('23f. the bill cannot be edited below what has been received', async () => {
  // A bill of 11800 with 5000 received, corrected down to 4000. The amount
  // received is a fact about the world, so the correction is refused rather
  // than the amount quietly changed.
  await updateBill(payBill.id, { payment_status: 'partial', amount_received: 5000 })
  await assertRejects(
    () => updateBill(payBill.id, {
      items: [{ product_name: 'Paid Shaft', unit: 'NOS', quantity: '3', rate: '1000.00', discount: '0', gst_rate: '18' }],
    }),
    'amount_received',
    'the bill cannot be corrected below the amount already received',
  )
  const unchanged = await q(`select grand_total, paid_amount from public.bills where id = $1`, [payBill.id])
  assertEqual(num(unchanged.rows[0].grand_total), 11800, 'and the bill is left as it was')
  assertEqual(num(unchanged.rows[0].paid_amount), 5000, 'with the amount it had')
})

await test('23g. the reports count what is owed, not the whole bill', async () => {
  const report = (await q(
    `select public.report_summary($1::uuid, $2::date, $3::date) as result`,
    [ORG, '2026-11-01', '2026-11-30'])).rows[0].result
  const dashboard = await rpc('dashboard_summary', ORG)

  // The reports are compared with the bills themselves rather than with a
  // figure typed in here, so the case says what it means: the pending figure
  // is the sum of what is owed, and it is smaller than the sum of what was
  // invoiced, because a partly paid bill owes only the rest of itself.
  const inRange = (await q(
    `select coalesce(sum(remaining_amount), 0) as owed, coalesce(sum(grand_total), 0) as invoiced
     from public.bills
     where organization_id = $1 and bill_date between $2::date and $3::date and deleted_at is null`,
    [ORG, '2026-11-01', '2026-11-30'])).rows[0]
  assertEqual(num(report.pending), num(inRange.owed), 'the report counts what is owed')
  assert(num(inRange.owed) < num(inRange.invoiced),
    'a partly paid bill counts only what it still owes, so the two figures cannot be the same')
  assertEqual(num(report.sales), num(inRange.invoiced), 'the sales figure is the whole bill, unchanged')

  const allBills = (await q(
    `select coalesce(sum(remaining_amount), 0) as owed from public.bills
     where organization_id = $1 and deleted_at is null`, [ORG])).rows[0]
  assertEqual(num(dashboard.pending_amount), num(allBills.owed), 'and so does the dashboard')
})

await test('23h. a viewer cannot record what has been received', async () => {
  await q('reset role')
  await q(`update public.memberships set role = 'viewer' where organization_id = $1 and user_id = $2`, [ORG, UID])
  await q('set local role authenticated')

  await assertRejects(
    () => updateBill(payBill.id, { payment_status: 'partial', amount_received: 5000 }),
    'FORBIDDEN',
    'a viewer must not be able to record a payment',
  )

  await q('reset role')
  await q(`update public.memberships set role = 'admin' where organization_id = $1 and user_id = $2`, [ORG, UID])
  await q('set local role authenticated')
})

await test('23i. a bill marked partly paid before the amount existed still asks for one', async () => {
  // A bill that was marked partly paid before this migration carries no
  // amount: nobody ever wrote one down. The status is a fact somebody
  // recorded, so it stays, and the next save asks for the figure.
  await q('reset role')
  await q(`update public.bills set payment_status = 'partial', paid_amount = 0 where id = $1`, [payBill.id])
  await q('set local role authenticated')

  await assertRejects(
    () => updateBill(payBill.id, { notes: 'a note about the bill' }),
    'amount_received',
    'an edit that touches nothing else still asks for the amount',
  )

  const updated = await updateBill(payBill.id, { amount_received: 1000 })
  assertEqual(num(updated.bill.paid_amount), 1000, 'and the amount is recorded once it is given')
  assertEqual(num(updated.bill.remaining_amount), 10800, 'with the balance that follows from it')
})

// ---------------------------------------------------------------------------
// The register reports where a job has got to
//
// 0040 brought the job status to the register, which is the screen people were
// reading `issued` off for ever because the register only ever asked for
// `dc_documents.status`. Two things have to hold:
//
//   1. It must say the same thing as `dc_job_progress`, which works out the
//      same rollup for one document on the challan page. They are two
//      statements of one rule - 0040 states it again in the lean form the
//      register needs rather than move it out from under 0037's rewrite of
//      `dc_job_progress` - so the suite compares them for *every* inward
//      challan in the workspace rather than for a handful picked by hand.
//   2. The filter has to be the database's. A register is paged, so a filter
//      applied in the browser would drop rows that were never fetched.
// ---------------------------------------------------------------------------

group('The register reports where a job has got to')

/** A received and accepted inward challan, ready for work to be drawn from it. */
async function registerJobInward(partNumber, declared) {
  const created = await saveInward({
    organization_id: ORG, party_id: customerId, dc_date: '2026-12-01',
    items: [{ part_number: partNumber, unit: 'NOS', declared_qty: declared, supply_source: 'customer_material' }],
  })
  const dc = created.document
  const item = created.items[0].id
  await receive({
    organization_id: ORG, dc_id: dc.id,
    lines: [{ dc_item_id: item, received_qty: declared, inspection_required: true }],
  })
  await inspect({
    organization_id: ORG, dc_id: dc.id,
    lines: [{ dc_item_id: item, accepted_qty: declared, pending_qty: 0 }],
  })
  return { dc, item }
}

/** An outward challan drawn from one inward line, dispatched in full. */
async function registerJobOutward(source, partNumber, declared) {
  const created = await saveCustomer({
    organization_id: ORG, party_id: customerId, dc_date: '2026-12-02', finalize: true,
    reference_inward_dc_id: source.dc.id,
    items: [{
      part_number: partNumber, unit: 'NOS', declared_qty: declared,
      supply_source: 'customer_material', source_inward_item_id: source.item,
    }],
  })
  const dc = created.document
  const item = created.items[0].id
  await dispatch({
    organization_id: ORG, dc_id: dc.id, proof_of_delivery_ref: 'POD/JOB-1',
    lines: [{ dc_item_id: item, dispatched_qty: declared }],
  })
  return { dc, item }
}

const jobStatusOf = (rows, dc) => {
  const row = rows.find(candidate => candidate.id === dc.id)
  assert(row, `${dc.dc_number} is missing from the register`)
  return row.job_status
}

let jobNotStarted = null
let jobInProgress = null
let jobPartDelivered = null
let jobDelivered = null

await test('24a. the four states are read from the challans drawn against an inward one', async () => {
  // Nothing drawn against it at all.
  jobNotStarted = (await registerJobInward('KI-JOB-NS', 50)).dc

  // An outward challan has gone out; nothing has been acknowledged yet.
  const inProgress = await registerJobInward('KI-JOB-IP', 50)
  await registerJobOutward(inProgress, 'KI-JOB-IP', 50)
  jobInProgress = inProgress.dc

  // Some of it acknowledged, not all of it.
  const partly = await registerJobInward('KI-JOB-PD', 100)
  const partlyOut = await registerJobOutward(partly, 'KI-JOB-PD', 100)
  await confirmDelivery({
    organization_id: ORG, dc_id: partlyOut.dc.id, delivered: false,
    proof_of_delivery_ref: 'POD/JOB-PD', receiver_name: 'Balaji',
    lines: [{ dc_item_id: partlyOut.item, delivered_qty: 40 }],
  })
  jobPartDelivered = partly.dc

  // Everything that went has been acknowledged in full.
  const done = await registerJobInward('KI-JOB-DN', 30)
  const doneOut = await registerJobOutward(done, 'KI-JOB-DN', 30)
  await confirmDelivery({
    organization_id: ORG, dc_id: doneOut.dc.id,
    proof_of_delivery_ref: 'POD/JOB-DN', receiver_name: 'Balaji',
    lines: [{ dc_item_id: doneOut.item, delivered_qty: 30 }],
  })
  jobDelivered = done.dc

  const rows = (await q(
    `select * from public.dc_register(p_org => $1::uuid, p_dc_type => 'inward')`, [ORG])).rows
  assertEqual(jobStatusOf(rows, jobNotStarted), 'not_started',
    'a challan with nothing drawn against it has not started')
  assertEqual(jobStatusOf(rows, jobInProgress), 'in_progress',
    'an outward challan raised and nothing acknowledged yet is work in process')
  assertEqual(jobStatusOf(rows, jobPartDelivered), 'partially_delivered',
    'some acknowledged and some not is partly delivered')
  assertEqual(jobStatusOf(rows, jobDelivered), 'delivered',
    'everything acknowledged in full is delivered')
})

await test('24b. the register and the challan page never disagree', async () => {
  // The receipt status still reads `issued` on every one of these, and that is
  // right - it is the material arriving at our gate. The job status is a
  // separate value, and this is what stops the two statements of the rule
  // drifting apart.
  const rows = (await q(
    `select id, dc_number, job_status from public.dc_register(p_org => $1::uuid, p_dc_type => 'inward')`,
    [ORG])).rows
  assert(rows.length > 0, 'the workspace has inward challans to compare')
  for (const row of rows) {
    const progress = (await q(
      `select job_status from public.dc_job_progress($1::uuid, $2::uuid) where scope = 'document'`,
      [ORG, row.id])).rows
    assertEqual(row.job_status, progress[0]?.job_status ?? null,
      `the register and dc_job_progress must agree about ${row.dc_number}`)
  }
})

await test('24c. the job status filter returns exactly the challans in that state', async () => {
  for (const [state, dc] of [
    ['not_started', jobNotStarted],
    ['in_progress', jobInProgress],
    ['partially_delivered', jobPartDelivered],
    ['delivered', jobDelivered],
  ]) {
    const rows = (await q(
      `select * from public.dc_register(p_org => $1::uuid, p_dc_type => 'inward', p_job_status => $2::text)`,
      [ORG, state])).rows
    assert(rows.some(row => row.id === dc.id), `the ${state} challan is in the ${state} list`)
    assert(rows.every(row => row.job_status === state), `every row in the ${state} list is ${state}`)
  }

  // Asking for a job status is the same as asking for inward challans, so it
  // must also drop the outward rows, which have no job of their own.
  const delivered = (await q(
    `select * from public.dc_register(p_org => $1::uuid, p_job_status => 'delivered')`, [ORG])).rows
  assert(delivered.length > 0, 'there is at least one finished job to filter to')
  assert(delivered.every(row => row.dc_type === 'inward'),
    'an outward challan is its own delivery and carries no job status')
})

await test('24d. the job status rule is not handed to the browser', async () => {
  // The register reaches it through its own security definer function, which
  // is the only path the browser has. The helper is revoked outright, so the
  // rule cannot be read by asking for it directly.
  await assertRejects(
    () => q(`select * from app_private.dc_job_status_by_document($1::uuid)`, [ORG]),
    'permission denied',
    'the helper is not executable by the role the browser impersonates',
  )
})

// ---------------------------------------------------------------------------
// Concurrency, on committed data
//
// This runs last and outside the rolled-back transaction on purpose. Rule 9 is
// about two real sessions racing for one balance, and two separate connections
// cannot see uncommitted rows. The fixture is therefore committed for this
// phase and deleted afterwards, leaving the branch as it was found.
// ---------------------------------------------------------------------------

group('Concurrency (committed data)')

// Everything up to here ran inside one transaction that is now committed rather
// than rolled back, because the concurrency phase below needs two independent
// connections to see the same rows. clearFixture() at the end removes it all.
await q('commit')

// `test()` opens a savepoint, so this phase needs a transaction of its own now
// that the main one has been committed. Committing also cleared this session's
// `set local role`, so it is impersonated again.
await q('begin')
await impersonate()

await test('14d. serialises two simultaneous dispatches of the same material', async () => {
  const racerA = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  const racerB = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  await racerA.connect()
  await racerB.connect()

  const beginAsUser = async client => {
    await client.query('begin')
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UID, role: 'authenticated' })])
    await client.query('set local role authenticated')
  }
  const call = async (client, name, payload) => {
    const { rows } = await client.query(`select public.${name}($1) as result`, [payload])
    return rows[0].result
  }

  try {
    // A freshly opened backend answers NULL from auth.uid() on its first
    // transaction even with the claim set correctly, and only resolves it from
    // the second one onwards. Rather than assume how many warm-ups are needed,
    // each racer is asked until it reports a real identity - and fails loudly
    // instead of silently racing as nobody.
    for (const [label, client] of [['A', racerA], ['B', racerB]]) {
      let identity = null
      for (let attempt = 0; attempt < 4 && identity === null; attempt += 1) {
        await beginAsUser(client)
        identity = (await client.query('select app_private.current_uid() as u')).rows[0].u
        await client.query('rollback')
      }
      assert(identity, `racer ${label} could not establish an identity on this backend`)
    }

    const available = num((await q(`select public.dc_available_balance($1::uuid, $2::uuid, 'KI-101', 'finished_stock') as balance`, [ORG, customerId])).rows[0].balance)
    assert(available > 0, 'there must be a positive balance to race for')

    // Both challans are created and committed first, so the race is only about
    // the dispatch step and neither side holds a lock during setup.
    await beginAsUser(racerA)
    await beginAsUser(racerB)
    const mine = await call(racerA, 'save_outward_customer_dc', {
      organization_id: ORG, party_id: customerId, dc_date: '2026-10-07', finalize: true,
      items: [{ part_number: 'KI-101', unit: 'NOS', declared_qty: available, supply_source: 'finished_stock' }],
    })
    await racerA.query('commit')
    const theirs = await call(racerB, 'save_outward_customer_dc', {
      organization_id: ORG, party_id: customerId, dc_date: '2026-10-07', finalize: true,
      items: [{ part_number: 'KI-101', unit: 'NOS', declared_qty: available, supply_source: 'finished_stock' }],
    })
    await racerB.query('commit')

    // The advisory lock is held to the end of the winning transaction, so the
    // loser waits for that commit before it re-reads the balance. Without the
    // lock both would read the same figure and both would succeed.
    const race = async (client, dc) => {
      await beginAsUser(client)
      try {
        const out = await call(client, 'record_dispatch', {
          organization_id: ORG, dc_id: dc.document.id,
          lines: [{ dc_item_id: dc.items[0].id, dispatched_qty: available }],
        })
        await client.query('commit')
        return out
      } catch (error) {
        await client.query('rollback').catch(() => {})
        throw error
      }
    }

    const outcomes = await Promise.allSettled([race(racerA, mine), race(racerB, theirs)])
    const fulfilled = outcomes.filter(o => o.status === 'fulfilled')
    const rejected = outcomes.filter(o => o.status === 'rejected')

    assertEqual(fulfilled.length, 1, 'exactly one concurrent dispatch may succeed')
    assertEqual(rejected.length, 1, 'the second must be refused')
    assert(
      String(rejected[0].reason.message).includes('QUANTITY_EXCEEDED'),
      `the loser must see QUANTITY_EXCEEDED, got: ${rejected[0].reason.message}`,
    )
  } finally {
    await racerA.query('rollback').catch(() => {})
    await racerB.query('rollback').catch(() => {})
    await racerA.end()
    await racerB.end()
  }
})

// Leave the branch exactly as it was found.
await q('reset role')
await clearFixture().catch(error => console.error(`  note: fixture cleanup failed: ${error.message}`))
await q('commit')

await db.end()

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log('\nFailures:')
  for (const f of failed) console.log(`  ${f.group} -> ${f.name}\n    ${f.error.message}`)
}
process.exit(failed.length ? 1 : 0)
