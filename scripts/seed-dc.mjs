#!/usr/bin/env node
/**
 * Demo data for the Delivery Challan module.
 *
 *   DATABASE_URL_TEST=<neon test branch> node scripts/seed-dc.mjs
 *
 * This does not invent rows. Every challan is created through the same RPCs the
 * browser calls, as a real organization member, so the data can only exist if the
 * quantity rules hold. A seed script that wrote straight into the tables would
 * happily produce a ledger that no valid sequence of transactions could produce.
 *
 * It walks the worked example from the specification end to end, so every screen
 * has something real in it:
 *
 *   Customer A / KI-101  1000 declared -> 990 received -> 960 accepted, 20 rejected,
 *                        10 pending. 600 issued to a machining vendor, 570 returned,
 *                        560 accepted output. 400 dispatched to the customer.
 *                        Leaves 160 finished, 30 still at the vendor, 8 rejected
 *                        material still to be returned.
 *
 *   Customer B / KI-202  500 accepted, 400 sent to heat treatment and not yet
 *                        returned - the "pending at vendor" case.
 *
 *   Customer C / KI-303  A short and damaged receipt with a partial return.
 *
 * Refuses to run against a production-looking endpoint unless --allow-production
 * is passed, for the same reason the migration runner does.
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
  process.exit(1)
}
if (!process.argv.includes('--allow-production') && /production/i.test(new URL(url).hostname)) {
  console.error('Refusing to seed a production endpoint. Pass --allow-production if that is genuinely intended.')
  process.exit(1)
}

const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
const q = (sql, params) => db.query(sql, params)
const call = async (name, payload) => {
  // A function with no parameters must not be given an empty argument list.
  if (payload === undefined) {
    const { rows } = await q(`select public.${name}() as result`)
    return rows[0].result
  }
  const { rows } = await q(`select public.${name}($1) as result`, [payload])
  return rows[0].result
}

// A warm backend can answer NULL from auth.uid() on its first transaction even
// with the claim set correctly, and only resolves it from the second onwards. So
// the identity is verified rather than assumed, and retried until it appears.
async function impersonate() {
  let identity = null
  for (let attempt = 0; attempt < 4 && identity === null; attempt += 1) {
    await q('begin')
    await q(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: USER, role: 'authenticated' }),
    ])
    await q('set local role authenticated')
    identity = (await q('select app_private.current_uid() as u')).rows[0].u
    if (identity === null) await q('rollback')
  }
  if (identity === null) throw new Error('Could not establish a database identity for the seed.')
}

await db.connect()

const present = await q(`select to_regclass('public.dc_documents') is not null as ok`)
if (!present.rows[0].ok) {
  console.error('The DC schema is missing. Run: npm run migrate')
  await db.end()
  process.exit(1)
}

const member = await q(`select user_id from public.memberships order by created_at limit 1`)
if (!member.rows[0]) {
  console.error('No organization member on this branch; the seed cannot impersonate a user.')
  await db.end()
  process.exit(1)
}
const USER = member.rows[0].user_id
const ORG = (await q(
  `select organization_id from public.memberships where user_id = $1 order by created_at limit 1`, [USER],
)).rows[0].organization_id

// Dates spread across the last few months so the reports have something to show.
const today = new Date()
const daysAgo = n => {
  const d = new Date(today)
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

await impersonate()
await call('dc_bootstrap_options')

// ---------------------------------------------------------------------------
// Parties. One master, shared with Billing: these are ordinary customer rows
// with a party_type, which is exactly how a real vendor gets created.
// ---------------------------------------------------------------------------

async function ensureParty(name, party_type, gstin, city) {
  await q('reset role')
  const existing = await q(
    `select id from public.customers where organization_id = $1 and lower(name) = lower($2) and deleted_at is null`,
    [ORG, name],
  )
  let id = existing.rows[0]?.id
  if (!id) {
    const created = await q(
      `insert into public.customers (organization_id, name, gstin, party_type, city, state, state_code, pincode, created_by)
       values ($1, $2, $3, $4, $5, 'Tamil Nadu', '33', '641001', $6)
       returning id`,
      [ORG, name, gstin, party_type, city, USER],
    )
    id = created.rows[0].id
  } else {
    await q(`update public.customers set party_type = $2 where id = $1`, [id, party_type])
  }
  await impersonate()
  return id
}

const customerA = await ensureParty('Sunrise Engineering Works', 'customer', '33AAAAA0001BCZ1', 'Coimbatore')
const customerB = await ensureParty('Kumar Precision Industries', 'customer', '33BBBBB0002CDZ2', 'Coimbatore')
const customerC = await ensureParty('Anand Auto Components', 'customer', '33CCCCC0003EFZ3', 'Coimbatore')
const vendorMachining = await ensureParty('Vertex CNC Machining', 'vendor', null, 'Coimbatore')
const vendorHeat = await ensureParty('Peak Heat Treatment', 'vendor', null, 'Coimbatore')

// The org may already hold DC documents from a previous run; a second seed would
// collide on nothing but would make the ledger unreadable, so say so plainly.
const existing = await q(`select count(*)::int as n from public.dc_documents where organization_id = $1`, [ORG])
if (existing.rows[0].n > 0) {
  console.log(`\nThis workspace already holds ${existing.rows[0].n} DC document(s).`)
  console.log('Re-seeding would pile a second worked example on top of the first.')
  console.log('Delete the existing DC records first, or seed an empty workspace.')
  await q('rollback')
  await db.end()
  process.exit(1)
}

console.log('\nCreating demo challans through the live RPCs...\n')

const line = (part, unit, declared, extra = {}) => ({
  part_number: part, unit, declared_qty: declared, supply_source: 'customer_material', ...extra,
})

// ---------------------------------------------------------------------------
// 1. Customer A: the specification's worked example, in full
// ---------------------------------------------------------------------------

const inwardA = await call('save_inward_dc', {
  organization_id: ORG,
  party_id: customerA,
  dc_date: daysAgo(45),
  external_dc_number: 'SEW/DC/2026/1187',
  external_dc_date: daysAgo(45),
  receipt_type: 'customer_owned',
  purpose: 'Customer material received for CNC machining',
  remarks: 'Sealed boxes, verified against the customer challan at the gate.',
  mode_of_transport: 'Customer Vehicle',
  vehicle_number: 'TN 39 AB 4417',
  lr_number: 'LR-778812',
  received_by: 'S. Kumar (stores)',
  prepared_by: 'Stores',
  authorized_by: 'Plant manager',
  finalize: true,
  items: [line('KI-101', 'NOS', 1000, { batch_lot_no: 'LOT-A/226', drawing_number: 'KI-101-DWG', drawing_revision: 'C' })],
})

await call('record_inward_receipt', {
  organization_id: ORG,
  dc_id: inwardA.document.id,
  received_by: 'S. Kumar (stores)',
  unloading_remarks: '10 pieces short against the customer challan; noted with the transporter.',
  lines: [{ dc_item_id: inwardA.items[0].id, received_qty: 990, damaged_qty: 0, inspection_required: true }],
})

await call('record_material_inspection', {
  organization_id: ORG,
  dc_id: inwardA.document.id,
  responsible_person: 'QA - Ramesh',
  inspection_date: daysAgo(44),
  lines: [{
    dc_item_id: inwardA.items[0].id,
    accepted_qty: 960,
    rejected_qty: 20,
    pending_qty: 10,
    rejection_reason: 'Dimensional Out of Tolerance',
    disposition: 'return_to_customer',
    inspection_report_no: 'IR-2026-0912',
    remarks: '20 pieces outside tolerance at the shoulder diameter; held for customer decision.',
  }],
})

// Partial return of the rejected material: 12 of 20 go back, 8 stay outstanding.
const rejectionA = (await q(
  `select id from public.dc_rejections where organization_id = $1 order by created_at desc limit 1`, [ORG],
)).rows[0].id
await call('record_material_return', {
  organization_id: ORG,
  rejection_id: rejectionA,
  returned_qty: 12,
  mode_of_transport: 'Customer Vehicle',
  vehicle_number: 'TN 39 AB 4417',
  returned_at: `${daysAgo(43)}T10:30:00Z`,
  purpose: 'Return of rejected material pending customer decision',
  prepared_by: 'Stores',
  authorized_by: 'Plant manager',
  remarks: '12 returned on the customer vehicle; 8 retained pending the customer inspection visit.',
})

// Issue 600 to the machining vendor.
const selfA = await call('save_outward_self_dc', {
  organization_id: ORG,
  party_id: vendorMachining,
  dc_date: daysAgo(40),
  movement_type: 'subcontracting',
  purpose: 'CNC turning of customer-owned material',
  expected_return_at: `${daysAgo(20)}T12:00:00Z`,
  mode_of_transport: 'Third-Party Transport',
  transporter_name: 'Sundaram Carriers',
  vehicle_number: 'TN 45 CD 9080',
  lr_number: 'LR-880233',
  eway_bill_number: 'EWB-44120099123',
  prepared_by: 'Production',
  authorized_by: 'Plant manager',
  finalize: true,
  items: [line('KI-101', 'NOS', 600, {
    supply_source: 'customer_material',
    processing_operation: 'CNC Turning',
    material_owner_id: customerA,
  })],
})

await call('issue_material', {
  organization_id: ORG,
  dc_id: selfA.document.id,
  dispatched_at: `${daysAgo(40)}T09:00:00Z`,
  prepared_by: 'Production',
  authorized_by: 'Plant manager',
  lines: [{ dc_item_id: selfA.items[0].id, qty_sent: 600, material_owner_id: customerA }],
})

// Partial vendor return: 570 of 600 came back.
await call('record_vendor_return', {
  organization_id: ORG,
  dc_id: selfA.document.id,
  returned_at: `${daysAgo(22)}T15:00:00Z`,
  remarks: '30 pieces still under process at the vendor; balance expected next week.',
  lines: [{ dc_item_id: selfA.items[0].id, returned_qty: 570, accepted_qty: 555, rejected_qty: 15 }],
})

// Machining result, reconciling exactly.
await call('record_machining_result', {
  organization_id: ORG,
  source_dc_id: selfA.document.id,
  source_dc_item_id: selfA.items[0].id,
  party_id: vendorMachining,
  material_owner_id: customerA,
  part_number: 'KI-101',
  operation: 'CNC Turning',
  operation_date: daysAgo(22),
  input_quantity: 600,
  input_unit: 'NOS',
  accepted_output_quantity: 560,
  output_unit: 'NOS',
  machining_rejection_quantity: 20,
  rework_quantity: 10,
  scrap_quantity: 10,
  rejection_reason: 'Dimensional Out of Tolerance',
  inspection_report: 'VIR-2026-0311',
  operator_name: 'Vertex - Saravanan',
  inspector_name: 'QA - Ramesh',
  corrective_action: 'Tool offset corrected; first-off inspected before the remaining batch.',
  remarks: '600 in, 560 accepted, 20 rejected, 10 to rework, 10 scrapped.',
})

// Dispatch finished stock to the customer.
const outA = await call('save_outward_customer_dc', {
  organization_id: ORG,
  party_id: customerA,
  dc_date: daysAgo(18),
  delivery_purpose: 'finished_goods',
  customer_order_reference: 'PO-7781',
  delivery_schedule_reference: 'SCH-2026-41',
  required_date: daysAgo(15),
  mode_of_transport: 'Customer Vehicle',
  vehicle_number: 'TN 39 AB 4417',
  finalize: true,
  items: [line('KI-101', 'NOS', 400, { supply_source: 'finished_stock' })],
})

await call('record_dispatch', {
  organization_id: ORG,
  dc_id: outA.document.id,
  dispatched_at: `${daysAgo(18)}T08:30:00Z`,
  vehicle_number: 'TN 39 AB 4417',
  transporter_name: 'Customer vehicle',
  prepared_by: 'Stores',
  authorized_by: 'Plant manager',
  proof_of_delivery_ref: 'POD/SEW/7781',
  remarks: '400 pieces against PO-7781.',
  lines: [{ dc_item_id: outA.items[0].id, dispatched_qty: 400 }],
})

await call('confirm_delivery', {
  organization_id: ORG,
  dc_id: outA.document.id,
  delivered: true,
  delivered_at: `${daysAgo(17)}T11:00:00Z`,
  proof_of_delivery_ref: 'POD/SEW/7781',
  receiver_name: 'Sunrise stores - Balaji',
})

console.log('  Customer A  inward -> inspection -> partial return -> vendor -> machining -> dispatch -> delivered')

// ---------------------------------------------------------------------------
// 2. Customer B: material sitting at a vendor, nothing returned yet
// ---------------------------------------------------------------------------

const inwardB = await call('save_inward_dc', {
  organization_id: ORG,
  party_id: customerB,
  dc_date: daysAgo(28),
  external_dc_number: 'KPI/DC/882',
  receipt_type: 'customer_owned',
  purpose: 'Material for heat treatment',
  mode_of_transport: 'Company Vehicle',
  vehicle_number: 'TN 39 AB 4417',
  finalize: true,
  items: [line('KI-202', 'NOS', 500, { batch_lot_no: 'KPI-L4' })],
})

await call('record_inward_receipt', {
  organization_id: ORG,
  dc_id: inwardB.document.id,
  lines: [{ dc_item_id: inwardB.items[0].id, received_qty: 500, inspection_required: true }],
})

await call('record_material_inspection', {
  organization_id: ORG,
  dc_id: inwardB.document.id,
  responsible_person: 'QA - Ramesh',
  inspection_date: daysAgo(27),
  lines: [{ dc_item_id: inwardB.items[0].id, accepted_qty: 500, rejected_qty: 0, pending_qty: 0, remarks: 'All accepted on visual and dimensional check.' }],
})

const selfB = await call('save_outward_self_dc', {
  organization_id: ORG,
  party_id: vendorHeat,
  dc_date: daysAgo(20),
  movement_type: 'subcontracting',
  purpose: 'Heat treatment and stress relieving',
  expected_return_at: `${daysAgo(5)}T12:00:00Z`,
  mode_of_transport: 'Third-Party Transport',
  transporter_name: 'Sundaram Carriers',
  vehicle_number: 'TN 45 CD 9080',
  finalize: true,
  items: [line('KI-202', 'NOS', 400, {
    supply_source: 'customer_material',
    processing_operation: 'Heat Treatment',
    material_owner_id: customerB,
  })],
})

await call('issue_material', {
  organization_id: ORG,
  dc_id: selfB.document.id,
  dispatched_at: `${daysAgo(20)}T10:00:00Z`,
  lines: [{ dc_item_id: selfB.items[0].id, qty_sent: 400, material_owner_id: customerB }],
})

console.log('  Customer B  inward -> inspection -> issued to heat treatment, return outstanding')

// ---------------------------------------------------------------------------
// 3. Customer C: short and damaged receipt, rejection pending return
// ---------------------------------------------------------------------------

const inwardC = await call('save_inward_dc', {
  organization_id: ORG,
  party_id: customerC,
  dc_date: daysAgo(12),
  external_dc_number: 'AAC/DC/3391',
  receipt_type: 'customer_owned',
  purpose: 'Material received with transit damage',
  mode_of_transport: 'Third-Party Transport',
  vehicle_number: 'TN 48 EF 2210',
  lr_number: 'LR-902114',
  finalize: true,
  items: [line('KI-303', 'NOS', 200, { batch_lot_no: 'AAC-0912' })],
})

await call('record_inward_receipt', {
  organization_id: ORG,
  dc_id: inwardC.document.id,
  unloading_remarks: '20 pieces missing and 5 cartons water damaged in transit.',
  lines: [{ dc_item_id: inwardC.items[0].id, received_qty: 180, damaged_qty: 5, inspection_required: true }],
})

await call('record_material_inspection', {
  organization_id: ORG,
  dc_id: inwardC.document.id,
  responsible_person: 'QA - Ramesh',
  inspection_date: daysAgo(11),
  lines: [{
    dc_item_id: inwardC.items[0].id,
    accepted_qty: 150,
    rejected_qty: 25,
    pending_qty: 5,
    rejection_reason: 'Handling Damage',
    disposition: 'hold_for_decision',
    remarks: '5 damaged cartons quarantined; customer to be informed before disposition.',
  }],
})

console.log('  Customer C  inward -> shortage and damage -> rejection held for decision')

// ---------------------------------------------------------------------------
// 4. A draft and a cancelled challan, so those states are visible too
// ---------------------------------------------------------------------------

const draft = await call('save_outward_customer_dc', {
  organization_id: ORG,
  party_id: customerC,
  dc_date: daysAgo(1),
  delivery_purpose: 'sample',
  purpose: 'Approved sample for customer evaluation',
  items: [line('KI-303', 'NOS', 5, { supply_source: 'finished_stock' })],
  finalize: false,
})
console.log(`  Draft      ${draft.document.dc_number} (still a draft)`)

const cancelled = await call('save_outward_customer_dc', {
  organization_id: ORG,
  party_id: customerB,
  dc_date: daysAgo(9),
  delivery_purpose: 'replacement',
  purpose: 'Replacement pieces (superseded)',
  items: [line('KI-202', 'NOS', 25, { supply_source: 'finished_stock' })],
  finalize: true,
})
await call('cancel_dc', {
  organization_id: ORG,
  dc_id: cancelled.document.id,
  reason: 'Customer cancelled the replacement; original delivery confirmed instead.',
})
console.log(`  Cancelled  ${cancelled.document.dc_number} (recorded, not deleted)`)

// ---------------------------------------------------------------------------

const tally = await q(
  `select dc_type, count(*)::int as n from public.dc_documents where organization_id = $1 group by dc_type order by dc_type`,
  [ORG],
)
console.log('\nCreated:')
for (const row of tally.rows) console.log(`  ${row.dc_type.padEnd(18)} ${row.n}`)

const ledger = await q(`select * from public.customer_material_ledger($1, $2)`, [ORG, customerA])
const ki101 = ledger.rows.find(r => r.part_number === 'KI-101')
console.log('\nCustomer A / KI-101 ledger:')
console.log(`  received                 ${ki101.received_total}`)
console.log(`  accepted material        ${ki101.accepted_material}`)
console.log(`  rejected material        ${ki101.rejected_material}`)
console.log(`  awaiting inspection      ${ki101.pending_inspection}`)
console.log(`  issued for processing    ${ki101.issued_for_processing}`)
console.log(`  still at vendor          ${ki101.still_at_vendor}`)
console.log(`  accepted output          ${ki101.accepted_output}`)
console.log(`  machining rejection      ${ki101.machining_rejection}`)
console.log(`  dispatched to customer   ${ki101.dispatched_to_customer}`)
console.log(`  finished stock available ${ki101.available_finished_stock}`)
console.log(`  customer material        ${ki101.available_customer_material}`)

const DRY_RUN = process.argv.includes('--dry-run')
await (DRY_RUN ? q('rollback') : q('commit'))
await db.end()
console.log(DRY_RUN
  ? '\nDry run: the transaction was rolled back, so nothing was saved.'
  : '\nSeed committed. Re-running is refused once the workspace holds DC documents.')