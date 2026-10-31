/**
 * Read-only schema audit.
 *
 *     node scripts/audit-schema.mjs
 *
 * Answers, without writing anything:
 *   - which migrations are actually applied on this branch
 *   - whether app_private.upsert_bill is the complete body or a truncated one
 *   - whether every RPC the frontend calls exists
 *   - whether the DC functions the README documents are present
 *
 * This is how a migration bug is caught on the branch that actually serves the
 * business, instead of being discovered when someone tries to raise an invoice.
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const envText = readFileSync(join(root, '.env'), 'utf8')
const readVar = (name) => {
  const match = envText.match(new RegExp(`^${name}\\s*=\\s*"?([^"\\r\\n]+)"?`, 'm'))
  return match ? match[1].trim() : null
}
const url = readVar('DATABASE_URL_UNPOOLED') ?? readVar('DIRECT_DATABASE_URL')
if (!url) {
  console.error('No DATABASE_URL_UNPOOLED in .env.')
  process.exit(1)
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10_000 })
await client.connect()

const problems = []
const section = (title) => console.log(`\n--- ${title} ---`)

// A read-only transaction, so this script physically cannot write even if it were
// changed later by mistake.
await client.query('begin read only')

section('Connection')
const { rows: conn } = await client.query('select current_database() db, current_user usr')
console.log(`  ${conn[0].db} as ${conn[0].usr}`)

// --- Applied migrations -------------------------------------------------------
section('Applied migrations')
const { rows: tables } = await client.query(`
  select count(*)::int n from information_schema.tables
  where table_schema = 'public' and table_name = 'app_public_schema_migrations'`)
if (tables[0].n === 0) {
  console.log('  no app_public_schema_migrations table; migrations are applied by hand')
} else {
  const { rows: applied } = await client.query('select version from app_public_schema_migrations order by version')
  console.log(`  ${applied.length} recorded: ${applied.map(r => r.version).join(', ')}`)
}

// --- app_private.upsert_bill must be complete --------------------------------
section('app_private.upsert_bill (every bill write goes through this)')
const { rows: upsert } = await client.query(`
  select pg_get_functiondef(p.oid) as def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'app_private' and p.proname = 'upsert_bill'
  limit 1`)
if (upsert.length === 0) {
  problems.push('app_private.upsert_bill does not exist. No bill can be saved.')
} else {
  const body = upsert[0].def
  const marker = /__UPSERT_REST__/.test(body)
  const returns = (body.match(/\breturn\b/gi) ?? []).length
  console.log(`  present; ${body.split('\n').length} lines, ${returns} 'return' keyword(s)`)
  if (marker) {
    problems.push('app_private.upsert_bill is the TRUNCATED body from 0010 (contains __UPSERT_REST__ and no RETURN). Every save_bill/update_bill call will fail.')
  } else if (returns === 0) {
    problems.push('app_private.upsert_bill has no RETURN statement. Every save_bill/update_bill call will fail with "control reached end of function without RETURN".')
  } else {
    console.log('  looks complete')
  }
}

// --- Every RPC the frontend calls must exist ---------------------------------
section('RPCs referenced by src/lib/dc-api.ts')
const dcApi = readFileSync(join(root, 'src', 'lib', 'dc-api.ts'), 'utf8')
const called = new Set()
for (const match of dcApi.matchAll(/(?:call|rows)<.*?>\(\s*'([a-z_]+)'/g)) called.add(match[1])
for (const match of dcApi.matchAll(/db\.rpc\('([a-z_]+)'/g)) called.add(match[1])
for (const match of dcApi.matchAll(/\.rpc\('([a-z_]+)'/g)) called.add(match[1])

const names = [...called].sort()
if (names.length === 0) {
  problems.push('Could not extract any RPC names from src/lib/dc-api.ts; the audit pattern is stale.')
} else {
  const { rows: found } = await client.query(`
    select p.proname,
           p.pronargs,
           exists (select 1 from pg_proc x join pg_namespace y on y.oid = x.pronamespace
                   where y.nspname = 'public' and x.proname = p.proname) as in_public
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any($1::text[])`, [names])
  const foundNames = new Set(found.map(r => r.proname))
  for (const name of names) {
    if (!foundNames.has(name)) problems.push(`RPC ${name}() is called by the app but does not exist on this branch.`)
  }
  console.log(`  ${found.length} / ${names.length} present`)
}

// --- Billing RPCs -------------------------------------------------------------
section('Billing RPCs')
const { rows: billing } = await client.query(`
  select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in
    ('save_bill','update_bill','soft_delete_bill','restore_bill','dashboard_summary',
     'report_summary','customer_summary','customer_products','add_organization_member',
     'set_customer_verification') order by p.proname`)
const billingExpected = ['save_bill', 'update_bill', 'dashboard_summary', 'report_summary', 'customer_summary', 'customer_products', 'add_organization_member']
for (const name of billingExpected) {
  if (!billing.some(r => r.proname === name)) problems.push(`Billing RPC ${name}() is missing on this branch.`)
}
console.log(`  ${billing.map(r => r.proname).join(', ')}`)

// --- Membership roles ---------------------------------------------------------
section('Membership roles in use')
const { rows: roles } = await client.query(
  "select role, count(*)::int n from public.memberships group by role order by role")
for (const role of roles) console.log(`  ${role.role.padEnd(10)} ${role.n}`)
const { rows: roleCheck } = await client.query(`
  select pg_get_constraintdef(oid) def from pg_constraint
  where conname = 'memberships_role_check'`)
console.log(`  constraint: ${roleCheck[0]?.def ?? 'not found'}`)

// --- Row counts (business volume, no content) --------------------------------
section('Row counts')
for (const table of ['organizations', 'customers', 'products', 'bills', 'bill_items', 'dc_documents', 'dc_items', 'audit_logs']) {
  const { rows } = await client.query(`select count(*)::int n from public.${table}`)
  console.log(`  ${table.padEnd(16)} ${rows[0].n}`)
}

// --- Report -------------------------------------------------------------------
await client.query('rollback')
await client.end()

if (problems.length) {
  console.error('\nSCHEMA PROBLEMS FOUND:')
  for (const problem of problems) console.error(`  x ${problem}`)
  process.exit(1)
}
console.log('\nSchema audit passed: no problems found. (Read-only; nothing was changed.)')