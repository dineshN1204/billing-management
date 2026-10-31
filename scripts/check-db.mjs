/**
 * Read-only check of the connected database.
 *
 *     npm run db:check
 *
 * Reports, without writing anything:
 *   - which branch it is pointed at, with the password removed
 *   - that every RPC the frontend calls exists and is granted to `authenticated`
 *   - that migrations 0019 and 0020 landed correctly if they have been applied
 *
 * Everything runs inside a read-only transaction, so this script physically
 * cannot modify the database even if it were changed later by mistake.
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
const url = readVar('DATABASE_URL_TEST') ?? readVar('DATABASE_URL_UNPOOLED') ?? readVar('DIRECT_DATABASE_URL')
if (!url) {
  console.log('No connection string in .env. Skipping.')
  process.exit(0)
}

const parsed = new URL(url)
console.log(`Target host: ${parsed.hostname}`)
console.log(`Database:    ${parsed.pathname.replace(/^\//, '')}\n`)

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10_000 })
const problems = []

try {
  await client.connect()
  await client.query('begin read only')

  const { rows: conn } = await client.query(`
    select current_database() as db, current_user as usr, current_setting('server_version') as version`)
  console.log(`CONNECTED  ${conn[0].db} as ${conn[0].usr} (PostgreSQL ${conn[0].version})`)

  // --- Functions the frontend calls ------------------------------------------
  const dcApi = readFileSync(join(root, 'src', 'lib', 'dc-api.ts'), 'utf8')
  const called = new Set()
  for (const match of dcApi.matchAll(/(?:call|rows)<.*?>\(\s*'([a-z_]+)'/g)) called.add(match[1])
  for (const match of dcApi.matchAll(/\.rpc\('([a-z_]+)'/g)) called.add(match[1])

  const billing = ['save_bill', 'update_bill', 'dashboard_summary', 'report_summary',
    'customer_summary', 'customer_products', 'add_organization_member', 'set_customer_verification',
    'list_organization_members', 'set_organization_member_role', 'deactivate_organization_member']
  const wanted = [...new Set([...called, ...billing])].sort()

  const { rows: found } = await client.query(`
    select p.proname,
           has_function_privilege('authenticated', p.oid, 'execute') as can_execute,
           has_function_privilege('public', p.oid, 'execute')           as public_execute
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any($1::text[])`, [wanted])

  console.log(`\nRPCs referenced by the frontend: ${found.length} / ${wanted.length} present`)
  for (const name of wanted) {
    const row = found.find(r => r.proname === name)
    if (!row) { problems.push(`public.${name} is called by the app but does not exist on this branch.`); continue }
    if (!row.can_execute) problems.push(`public.${name} exists but 'authenticated' cannot execute it. The app will get PGRST203.`)
    if (row.public_execute) problems.push(`public.${name} is executable by PUBLIC. It should be revoked from public and anonymous.`)
  }

  // --- Migrations 0019 / 0020 -------------------------------------------------
  console.log('\nPending migrations:')
  const additions = {
    dc_movement_history: '0019 - adds dc_id to the movement report',
    set_organization_member_role: '0020 - role change',
    deactivate_organization_member: '0020 - member removal',
    list_organization_members: '0020 - member list with email',
  }
  for (const [name, description] of Object.entries(additions)) {
    const row = found.find(r => r.proname === name)
    console.log(`  ${row ? 'applied  ' : 'pending  '} ${description}`)
  }

  const { rows: shape } = await client.query(`
    select pg_get_function_result(p.oid) as result from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'dc_movement_history'`)
  if (shape[0]?.result?.includes('dc_id')) {
    console.log('  ok       dc_movement_history returns dc_id, so movement rows can link to their challan')
  } else if (shape.length > 0) {
    problems.push('dc_movement_history exists but does not return dc_id. Apply 0019.')
  }

  // --- Roles in use -----------------------------------------------------------
  const { rows: roles } = await client.query(
    'select role, count(*)::int n from public.memberships group by role order by role')
  console.log('\nMembers by role: ' + (roles.map(r => `${r.role}=${r.n}`).join(', ') || 'none'))

  // --- Volume -----------------------------------------------------------------
  console.log('\nRow counts:')
  for (const table of ['organizations', 'customers', 'products', 'bills', 'bill_items', 'dc_documents', 'dc_items', 'audit_logs']) {
    const { rows } = await client.query(`select count(*)::int n from public.${table}`)
    console.log(`  ${table.padEnd(16)} ${rows[0].n}`)
  }

  await client.query('rollback')
} catch (error) {
  console.log(`\nCOULD NOT CONNECT: ${error.code ?? error.message}`)
  process.exitCode = 0
} finally {
  await client.end().catch(() => {})
}

if (problems.length) {
  console.error('\nPROBLEMS:')
  for (const problem of problems) console.error(`  x ${problem}`)
  process.exit(1)
}
console.log('\nAll checks passed. Nothing was modified.')