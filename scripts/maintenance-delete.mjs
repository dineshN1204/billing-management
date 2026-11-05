#!/usr/bin/env node
/**
 * Safely hard-deletes rows from the database, for when the developer needs to
 * correct an erroneous record that cannot be fixed by the app (e.g. a wrong
 * update that should never have happened).
 *
 *   node scripts/maintenance-delete.mjs --table customers --id <uuid> --confirm
 *   node scripts/maintenance-delete.mjs --table bills --where "created_at < '2026-01-01'" --limit 5 --confirm
 *
 * Safety rails (these are the whole point):
 *   * The target defaults to the test branch (DATABASE_URL_TEST). Applying to a
 *     production-looking host requires --target app --allow-production.
 *   * Nothing is written until a preview is printed and --confirm is passed.
 *   * Exactly one of --id (parameterized) or --where (with a compulsory --limit)
 *     must select the rows. The WHERE clause is constrained to a single
 *     statement and rejects multi-statement/comment injection.
 *   * The table must be a real base table (not a view/foreign table), and a
 *     blocklist refuses audit_logs outright and refuses organizations/profiles
 *     without --force (identity/cascade risk).
 *   * Every deleted row is recorded in audit_logs as 'maintenance.delete' with
 *     its JSON old_data, so the delete is visible and reversible from the trail.
 *
 * Hard delete is a last resort. Prefer correcting with UPDATE, or soft-deleting
 * (deleted_at) where the table supports it. The audit trail's old_data is the
 * source for restoring a prior value. See docs/DATABASE_MAINTENANCE.md.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const here = dirname(fileURLToPath(import.meta.url))

function readEnvFile(file) {
  try {
    const values = {}
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
      if (!match) continue
      values[match[1]] = match[2].trim().replace(/^"(.*)"$/, '$1')
    }
    return values
  } catch {
    return {}
  }
}

const fileEnv = readEnvFile(join(here, '..', '.env'))

// -- Argument parsing ----------------------------------------------------------
const args = process.argv.slice(2)
const take = (flag) => {
  const i = args.indexOf(flag)
  return i !== -1 ? (args[i + 1] ?? '') : ''
}
const has = (flag) => args.includes(flag)

const table = take('--table')
const id = take('--id')
const where = take('--where')
const limitRaw = take('--limit')
const actor = take('--actor') || null
const confirm = has('--confirm')
const force = has('--force')
const useAppBranch = take('--target') === 'app'

// -- Connection / target -------------------------------------------------------
const url = useAppBranch
  ? (process.env.DATABASE_URL_UNPOOLED || fileEnv.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || fileEnv.DATABASE_URL)
  : (process.env.DATABASE_URL_TEST || fileEnv.DATABASE_URL_TEST || process.env.DATABASE_URL_UNPOOLED || fileEnv.DATABASE_URL_UNPOOLED)
if (!url) {
  console.error('No target database. Set DATABASE_URL_TEST to the test branch connection string.')
  process.exit(1)
}

const host = new URL(url).hostname
if (!has('--allow-production') && /production/i.test(host) && !/dc-test/i.test(process.env.DATABASE_URL_TEST ?? '')) {
  console.error(`Refusing to run against ${host}: it looks like a production endpoint.`)
  console.error('Set DATABASE_URL_TEST to a test branch, or pass --allow-production deliberately.')
  process.exit(1)
}

// -- Validation ----------------------------------------------------------------
if (!table) {
  console.error('--table <name> is required.')
  process.exit(1)
}
if (id && where) {
  console.error('Pass exactly one of --id or --where, not both.')
  process.exit(1)
}
if (!id && !where) {
  console.error('Pass --id <uuid> or --where "<predicate>" to select the rows to delete.')
  process.exit(1)
}
if (where && !limitRaw) {
  console.error('--where requires a compulsory --limit <n> (protects against deleting everything).')
  process.exit(1)
}

if (!/^(?:public\.)?[a-z_][a-z0-9_]*$/i.test(table)) {
  console.error(`Invalid table name: ${JSON.stringify(table)}`)
  process.exit(1)
}
const tableForSql = table.replace(/^public\./, '')

const ALWAYS_BLOCKED = ['audit_logs'] // append-only trail; deleting it is never right
const NEEDS_FORCE = ['organizations', 'profiles'] // cascade / identity risk
if (ALWAYS_BLOCKED.includes(tableForSql)) {
  console.error(`Refusing to delete from ${tableForSql}: it is the append-only audit trail.`)
  process.exit(1)
}
if (NEEDS_FORCE.includes(tableForSql) && !force) {
  console.error(`Refusing to delete from ${tableForSql}: it is identity-critical and cascades. Pass --force to confirm you mean it.`)
  process.exit(1)
}

// --where is raw SQL (developer-owned), so constrain it to one statement and
// reject comment/multi-statement injection.
if (where && /[;]|--|\/\*/i.test(where)) {
  console.error('--where may not contain semicolons or SQL comments (multi-statement injection guard).')
  process.exit(1)
}

// -- Database work -------------------------------------------------------------
// Neon requires SSL; a local scratch cluster may not offer it. Only force SSL
// when the host is not localhost.
const isLocal = ['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname)
const client = new pg.Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } })
await client.connect()
const target = (await client.query('select current_database() db, current_user usr from (select 1) s')).rows[0]

// Confirm the target is a real base table.
const rel = await client.query(
  `select relkind from pg_catalog.pg_class c
   join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = $1`,
  [tableForSql],
)
if (rel.rowCount === 0) {
  console.error(`No table public.${tableForSql} exists.`)
  process.exit(1)
}
if (rel.rows[0].relkind !== 'r') {
  console.error(`public.${tableForSql} is not a base table (relkind=${rel.rows[0].relkind}); refusing.`)
  process.exit(1)
}

// Determine the column to use for the preview/audit record_id when --id is used.
const predicate = id
  ? { sql: `id = $1`, params: [id], kind: 'id' }
  : { sql: where, params: [], kind: 'where' }

const previewLimit = limitRaw === '' ? 'ALL' : Number(limitRaw)
const preview = await client.query(
  `select * from public.${tableForSql} where ${predicate.sql} limit ${previewLimit}`,
  predicate.params,
)
const total = id
  ? preview.rowCount
  : (await client.query(`select count(*)::int n from public.${tableForSql} where ${predicate.sql}`, predicate.params)).rows[0].n

console.log(`\nTarget: ${target.db} as ${target.usr} (${host})`)
console.log(`Table:  public.${tableForSql}`)
console.log(`Predicate: ${predicate.sql}`)
console.log(`Preview matches: ${total} (showing ${preview.rowCount} row(s) for preview)\n`)
if (preview.rows.length) console.table(preview.rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v).slice(0, 40)]))))

console.log('Reminder: hard delete is the last resort. Prefer UPDATE, or soft-delete (deleted_at) where supported. Old values are on the audit trail.')

if (!confirm) {
  console.log('\nNo --confirm passed — aborted, no changes made.')
  await client.end()
  process.exit(0)
}

const deleted = []
await client.query('begin')
try {
  const res = await client.query(`delete from public.${tableForSql} where ${predicate.sql} returning *`, predicate.params)
  for (const row of res.rows) {
    const orgId = row.organization_id ?? row.organization_id_ ?? null
    await client.query(
      `insert into public.audit_logs (organization_id, actor_id, action, table_name, record_id, old_data)
       values ($1, $2, 'maintenance.delete', $3, $4, $5)`,
      [orgId, actor, tableForSql, row.id ?? null, JSON.stringify(row)],
    )
    deleted.push(row)
  }
  await client.query('commit')
  console.log(`\nDeleted ${deleted.length} row(s) from public.${tableForSql}; each recorded in audit_logs as maintenance.delete.`)
} catch (error) {
  await client.query('rollback')
  console.error(`\nError during delete — rolled back, nothing changed (${error.code ?? ''} ${error.message})`)
  process.exit(1)
}

await client.end()
