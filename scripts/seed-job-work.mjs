#!/usr/bin/env node
/**
 * The job-work worked example, in one place: an inward challan, the outward
 * challan that answers it, and the bill that pays for it.
 *
 *   node scripts/seed-job-work.mjs
 *   node scripts/seed-job-work.mjs --org <organization id>
 *
 * This does not invent rows. Every document is created through the same RPCs
 * the browser calls, as a real organization member, so the records can only
 * exist if the quantity rules hold. A seed script that wrote straight into the
 * tables would happily produce a ledger that no valid sequence of
 * transactions could produce.
 *
 * What it makes:
 *
 *   Inward  KI/IN/2026-27/0012     the customer sends material for job work on
 *                                   their own challans 500 and 503. Both lines
 *                                   are received and inspected: 90 accepted,
 *                                   10 rejected.
 *   Outward KI/OUT-C/2026-27/0012   the same serial, because it answers that
 *                                   inward challan. 85 pieces go back, and the
 *                                   customer acknowledges them.
 *   Bill     2026-27/0012          raised from that outward challan, carrying
 *                                   the same serial, with the customer DC
 *                                   numbers on it and a link back to the
 *                                   challan.
 *
 * The serial is whatever the next free number is in that workspace - the point
 * is that the inward, the outward and the bill carry the SAME one, so the
 * three can be read as one job and a search for the serial answers with all
 * three.
 *
 * The company letterhead is not invented. If the address, phone or email are
 * empty, the script says so and leaves them empty, because a wrong address on
 * a tax invoice is worse than a blank one.
 *
 * Refuses to run against a production-looking endpoint unless
 * --allow-production is passed, for the same reason the migration runner does.
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
const orgArgumentIndex = process.argv.indexOf('--org')
const orgArgument = orgArgumentIndex >= 0 ? process.argv[orgArgumentIndex + 1] : null

// The app's own branch by default, so the records are visible in the app the
// person is looking at. --target test uses the test branch instead, and
// SEED_DATABASE_URL overrides both.
const useTestBranch = process.argv.includes('--target')
const url = process.env.SEED_DATABASE_URL
  || (useTestBranch ? fileEnv.DATABASE_URL_TEST : undefined)
  || fileEnv.SEED_DATABASE_URL
  || fileEnv.DATABASE_URL_UNPOOLED
  || fileEnv.DIRECT_DATABASE_URL
  || fileEnv.DATABASE_URL_TEST
if (!url) {
  console.error('No target database. Set SEED_DATABASE_URL, or DATABASE_URL_UNPOOLED in .env.')
  process.exit(1)
}

const host = new URL(url).hostname
if (!process.argv.includes('--allow-production') && /(^|[.-])(prod|production|live|primary|main)([.-]|$)/i.test(host)) {
  console.error(`Refusing to seed ${host}: it looks like a production endpoint. Pass --allow-production if that is genuinely intended.`)
  process.exit(1)
}

const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
const q = (sql, params) => db.query(sql, params)
const call = async (name, payload) => {
  if (payload === undefined) {
    const { rows } = await q(`select public.${name}() as result`)
    return rows[0].result
  }
  const { rows } = await q(`select public.${name}($1) as result`, [payload])
  return rows[0].result
}

await db.connect()

// ---------------------------------------------------------------------------
// The schema has to be there, including the two migrations this example needs
// ---------------------------------------------------------------------------

const ready = await q(`select to_regclass('public.dc_documents') is not null as dc, to_regprocedure('public.set_bill_dc_references(jsonb)') is not null as refs, to_regprocedure('public.reserve_bill_number(uuid,date,text,uuid[],uuid)') is not null as series`)
if (!ready.rows[0].dc) {
  console.error('The DC schema is missing. Run: npm run migrate')
  await db.end()
  process.exit(1)
}
if (!ready.rows[0].refs || !ready.rows[0].series) {
  console.error('This example needs migrations 0035, 0036 and 0037. Run: npm run migrate')
  await db.end()
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Which workspace, and who to act as
// ---------------------------------------------------------------------------

const workspaces = await q(`
  select m.organization_id, m.user_id, m.role, o.name,
         (select count(*)::int from public.dc_documents d where d.organization_id = m.organization_id) as documents
  from public.memberships m
  join public.organizations o on o.id = m.organization_id
  where m.role in ('admin', 'staff')
  order by documents desc, m.created_at
`)
if (!workspaces.rows.length) {
  console.error('No organization member on this database; the seed cannot impersonate a user.')
  await db.end()
  process.exit(1)
}
const workspace = orgArgument
  ? workspaces.rows.find(row => row.organization_id === orgArgument)
  : workspaces.rows[0]
if (!workspace) {
  console.error(`No member found for organization ${orgArgument}.`)
  await db.end()
  process.exit(1)
}

const ORG = workspace.organization_id
const USER = workspace.user_id

/**
 * A warm backend can answer NULL from auth.uid() on its first transaction even
 * with the claim set correctly, and only resolves it from the second onwards. So
 * the identity is verified rather than assumed, and retried until it appears.
 */
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

console.log(`\nTarget: ${host}  db=${new URL(url).pathname.replace(/^\//, '')}`)
console.log(`Workspace: ${workspace.name} (${ORG})  as ${workspace.role} ${USER}\n`)

await impersonate()
await call('dc_bootstrap_options')

// ---------------------------------------------------------------------------
// The company letterhead
// ---------------------------------------------------------------------------

const company = (await q(`select name, gstin, address, phone, email, state_code from public.organizations where id = $1`, [ORG])).rows[0]
const missing = [
  company.address ? null : 'address',
  company.phone ? null : 'phone',
  company.email ? null : 'email',
].filter(Boolean)
if (missing.length) {
  console.log('Company details still to fill in: ' + missing.join(', ') + '.')
  console.log('They are not invented here. Open Company settings and type them; the invoice PDF')
  console.log('prints whatever is on file, and says so when a piece is missing.\n')
} else {
  console.log(`Company details are complete: ${company.name}, GSTIN ${company.gstin}\n`)
}

// ---------------------------------------------------------------------------
// The customer
// ---------------------------------------------------------------------------

const CUSTOMER_NAME = 'Acme Engineering'
const existingCustomer = await q(
  `select id from public.customers where organization_id = $1 and lower(name) = lower($2) and deleted_at is null`,
  [ORG, CUSTOMER_NAME],
)
let customerId = existingCustomer.rows[0]?.id
if (!customerId) {
  await q('reset role')
  const created = await q(
    `insert into public.customers (organization_id, name, gstin, party_type, phone, email, address_line_1, city, state, pincode, state_code, created_by)
     values ($1, $2, '33AAAAA0001BCZ1', 'customer', '9876500011', 'accounts@acme-engineering.in', '4 Market Road', 'Chennai', 'Tamil Nadu', '600001', '33', $3)
     returning id`,
    [ORG, CUSTOMER_NAME, USER],
  )
  customerId = created.rows[0].id
  await impersonate()
  console.log(`Created the customer ${CUSTOMER_NAME}.`)
} else {
  console.log(`Using the existing customer ${CUSTOMER_NAME}.`)
}

// ---------------------------------------------------------------------------
// 1. The inward challan
// ---------------------------------------------------------------------------

const today = new Date()
const daysAgo = n => {
  const d = new Date(today)
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

console.log('\nCreating the inward challan...')
const inward = await call('save_inward_dc', {
  organization_id: ORG,
  party_id: customerId,
  dc_date: daysAgo(6),
  receipt_type: 'customer_owned',
  purpose: 'Customer material received for CNC job work',
  remarks: 'Two of the customer\'s own challans received together, and inspected on the gate.',
  mode_of_transport: 'Customer Vehicle',
  vehicle_number: 'TN 39 AB 4417',
  received_by: 'S. Kumar (stores)',
  prepared_by: 'Stores',
  authorized_by: 'Plant manager',
  finalize: true,
  items: [
    { part_number: 'KI-101', unit: 'NOS', declared_qty: 100, supply_source: 'customer_material', customer_dc_number: '500', drawing_number: 'KI-101-DWG', drawing_revision: 'B', batch_lot_no: 'LOT-A/226' },
    { part_number: 'KI-102', unit: 'NOS', declared_qty: 50, supply_source: 'customer_material', customer_dc_number: '503', drawing_number: 'KI-102-DWG', drawing_revision: 'A', batch_lot_no: 'LOT-B/227' },
  ],
})
console.log(`  ${inward.document.dc_number}`)

await call('record_inward_receipt', {
  organization_id: ORG,
  dc_id: inward.document.id,
  received_by: 'S. Kumar (stores)',
  unloading_remarks: 'Received against the customer\'s challans 500 and 503; quantities checked line by line.',
  lines: [
    { dc_item_id: inward.items[0].id, received_qty: 100, damaged_qty: 0, inspection_required: true },
    { dc_item_id: inward.items[1].id, received_qty: 50, damaged_qty: 0, inspection_required: true },
  ],
})

await call('record_material_inspection', {
  organization_id: ORG,
  dc_id: inward.document.id,
  responsible_person: 'QA - Ramesh',
  inspection_date: daysAgo(5),
  lines: [
    { dc_item_id: inward.items[0].id, accepted_qty: 90, rejected_qty: 10, pending_qty: 0, rejection_reason: 'Dimensional Out of Tolerance', disposition: 'return_to_customer', inspection_report_no: 'IR-2026-0912' },
    { dc_item_id: inward.items[1].id, accepted_qty: 50, rejected_qty: 0, pending_qty: 0, inspection_report_no: 'IR-2026-0913' },
  ],
})
console.log('  received and inspected: 90 + 50 accepted, 10 rejected')

// ---------------------------------------------------------------------------
// 2. The outward challan that answers it
// ---------------------------------------------------------------------------

console.log('\nCreating the outward challan...')
const outward = await call('save_outward_customer_dc', {
  organization_id: ORG,
  party_id: customerId,
  dc_date: daysAgo(2),
  delivery_purpose: 'finished_goods',
  purpose: 'Finished parts returned to the customer after job work',
  mode_of_transport: 'Company Vehicle',
  vehicle_number: 'TN 39 CZ 8890',
  driver_name: 'Ravi',
  driver_contact: '9876500099',
  prepared_by: 'Stores',
  authorized_by: 'Plant manager',
  finalize: true,
  // The inward challan this one answers. It is what gives the outward the same
  // serial, so the two read as a pair in the register.
  reference_inward_dc_id: inward.document.id,
  items: [
    { part_number: 'KI-101', unit: 'NOS', declared_qty: 85, supply_source: 'customer_material', source_inward_item_id: inward.items[0].id, customer_dc_number: '500' },
    { part_number: 'KI-102', unit: 'NOS', declared_qty: 50, supply_source: 'customer_material', source_inward_item_id: inward.items[1].id, customer_dc_number: '503' },
  ],
})
console.log(`  ${outward.document.dc_number}`)

await call('record_machining_result', {
  organization_id: ORG,
  party_id: customerId,
  source_dc_id: outward.document.id,
  source_dc_item_id: outward.items[0].id,
  material_owner_id: customerId,
  part_number: 'KI-101',
  operation: 'CNC Turning',
  operation_date: daysAgo(3),
  input_quantity: 90,
  input_unit: 'NOS',
  accepted_output_quantity: 85,
  output_unit: 'NOS',
  machining_rejection_quantity: 5,
  operator_name: 'Ravi',
  inspector_name: 'Sabari',
})

// Record machining for the second line (KI-102) to demonstrate complete coverage
// for a multi-line outward customer DC. Migration 0043 requires all job-work lines
// to have machining results before dispatch can close the challan properly.
await call('record_machining_result', {
  organization_id: ORG,
  party_id: customerId,
  source_dc_id: outward.document.id,
  source_dc_item_id: outward.items[1].id,
  material_owner_id: customerId,
  part_number: 'KI-102',
  operation: 'CNC Turning',
  operation_date: daysAgo(3),
  input_quantity: 50,
  input_unit: 'NOS',
  accepted_output_quantity: 50,
  output_unit: 'NOS',
  machining_rejection_quantity: 0,
  operator_name: 'Ravi',
  inspector_name: 'Sabari',
})

await call('record_dispatch', {
  organization_id: ORG,
  dc_id: outward.document.id,
  vehicle_number: 'TN 39 CZ 8890',
  driver_name: 'Ravi',
  dispatch_at: new Date(Date.now() - 2 * 86400000).toISOString(),
  lines: [
    { dc_item_id: outward.items[0].id, dispatched_qty: 85 },
    { dc_item_id: outward.items[1].id, dispatched_qty: 50 },
  ],
})

await call('confirm_delivery', {
  organization_id: ORG,
  dc_id: outward.document.id,
  proof_of_delivery_ref: 'POD-2026-0311',
  receiver_name: 'Stores - Acme Engineering',
  lines: [
    { dc_item_id: outward.items[0].id, delivered_qty: 85 },
    { dc_item_id: outward.items[1].id, delivered_qty: 50 },
  ],
})
console.log('  dispatched 85 + 50 and acknowledged by the customer')

// ---------------------------------------------------------------------------
// 3. The bill
// ---------------------------------------------------------------------------

console.log('\nCreating the bill...')

// The bill number a challan makes: the financial year and the challan's
// serial, so the bill and the challan it pays for carry the same number. The
// database makes the number and checks it, so it is asked for rather than
// written down here.
//
// The bill is dated the day the goods went out, so the number's financial
// year and the bill's own are the same. A bill dated a day later would not
// be, in the one week of the year where the two fall either side of 1 April.
const billDate = outward.document.dc_date
const outwardParts = String(outward.document.dc_number).split('/')
const billNumber = `${outwardParts[outwardParts.length - 2]}/${outwardParts[outwardParts.length - 1]}`
const { rows: reservedRows } = await q(
  `select public.reserve_bill_number($1::uuid, $2::date, $3::text, $4::uuid[]) as result`,
  [ORG, billDate, billNumber, [outward.document.id]],
)
const reservedNumber = reservedRows[0].result.bill_number

const bill = await call('save_bill', {
  organization_id: ORG,
  customer_id: customerId,
  bill_number: reservedNumber,
  bill_date: billDate,
  tax_mode: 'intra',
  place_of_supply: 'Tamil Nadu',
  payment_status: 'unpaid',
  source_type: 'manual',
  verification_status: 'verified',
  notes: `Job work against ${inward.document.dc_number} and ${outward.document.dc_number}.`,
  items: [
    { product_name: 'KI-101', unit: 'NOS', quantity: '85', rate: '250.00', discount: '0', gst_rate: '18' },
    { product_name: 'KI-102', unit: 'NOS', quantity: '50', rate: '180.00', discount: '0', gst_rate: '18' },
  ],
}, false)
console.log(`  ${bill.bill.bill_number}  total ${bill.bill.grand_total}`)

// The link between the bill and the challan it pays for, and the customer's own
// challan numbers on the bill.
await call('dc_link_bills', {
  organization_id: ORG,
  dc_id: outward.document.id,
  bills: [{ bill_id: bill.bill.id }],
})
await call('set_bill_dc_references', {
  organization_id: ORG,
  bill_id: bill.bill.id,
  customer_dc_reference: '500, 503',
})

await q('reset role')
await q('commit')
await db.end()

console.log('\nDone. What now exists:')
console.log(`  Inward   ${inward.document.dc_number}  (customer DC 500, 503)  - fully received and inspected`)
console.log(`  Outward  ${outward.document.dc_number}  - same serial, dispatched and acknowledged`)
console.log(`  Bill     ${bill.bill.bill_number}  - linked to the outward challan, customer DC 500, 503`)
console.log('\nOpen the outward challan and press "Bill this challan" to see the bill form filled in')
console.log('from the challan, and open the bill for its PDF.')
