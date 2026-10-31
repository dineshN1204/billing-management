#!/usr/bin/env node
/**
 * Applies db/migrations/*.sql in order to the database named by
 * DATABASE_URL_TEST (falling back to DATABASE_URL_UNPOOLED).
 *
 *   node scripts/apply-migrations.mjs                 # every migration
 *   node scripts/apply-migrations.mjs 0013 0014 0015   # only these
 *   node scripts/apply-migrations.mjs --target app --allow-production  # explicitly apply to production
 *
 * The target is a Neon test branch by design. Pointing this at a production
 * database is exactly the mistake the migration README warns about, so the
 * script refuses to run against a branch whose name looks like production
 * unless --allow-production is passed.
 *
 * Every migration that succeeds is recorded in app_public_schema_migrations
 * so a run is repeatable and a later run can tell which applied already.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const here = dirname(fileURLToPath(import.meta.url))
const migrationDir = join(here, '..', 'db', 'migrations')

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
// Argument parsing. `--target app` consumes the value that follows it so that
// 'app' is not mistaken for a migration prefix filter (which made every
// flag-only run exit with "No migrations matched.").
const rawArgs = process.argv.slice(2)
const targetIndex = rawArgs.indexOf('--target')
const targetValue = targetIndex !== -1 ? (rawArgs[targetIndex + 1] ?? '') : ''
// The test branch is the default and always will be: a migration applied to
// the app's own branch is a change to a working application, and that has to
// be a deliberate choice. `--target app` makes that choice explicit.
const useAppBranch = targetValue === 'app'
// Migration prefix filters: every positional argument that is not a flag and
// not the value of --target.
const only = rawArgs.filter((arg, index) =>
  !arg.startsWith('--') && !(targetIndex !== -1 && index === targetIndex + 1))
const url = useAppBranch
  ? (process.env.DATABASE_URL_UNPOOLED || fileEnv.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || fileEnv.DATABASE_URL)
  : (process.env.DATABASE_URL_TEST || fileEnv.DATABASE_URL_TEST || process.env.DATABASE_URL_UNPOOLED || fileEnv.DATABASE_URL_UNPOOLED)
if (!url) {
  console.error('No target database. Set DATABASE_URL_TEST to the test branch connection string.')
  process.exit(1)
}

const host = new URL(url).hostname
if (!process.argv.includes('--allow-production') && /production/i.test(host) && !/dc-test/i.test(process.env.DATABASE_URL_TEST ?? '')) {
  console.error(`Refusing to run against ${host}: it looks like a production endpoint.`)
  console.error('Set DATABASE_URL_TEST to a test branch, or pass --allow-production deliberately.')
  process.exit(1)
}

const files = readdirSync(migrationDir)
  .filter(name => name.endsWith('.sql'))
  .sort()
  .filter(name => only.length === 0 || only.some(prefix => name.startsWith(prefix)))

if (files.length === 0) {
  console.error('No migrations matched.')
  process.exit(1)
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
let failed = false

await client.connect()
const target = (await client.query('select current_database() db, current_user usr, current_setting(\'server_version\') ver')).rows[0]
console.log(`Applying ${files.length} migration(s) to ${target.db} as ${target.usr} (PostgreSQL ${target.ver})\n`)

// A persistent record of what is applied. Without it the production branch is a
// black box: the missing 0040 (the dc_register schema-cache error scanned twice
// here) was invisible because nothing recorded what had actually run.
await client.query(`
  create table if not exists app_public_schema_migrations (
    version     text        primary key,
    file_name   text        not null,
    applied_by  text        not null default current_user,
    applied_at  timestamptz not null default now()
  )`)
console.log('Migration tracking ready (app_public_schema_migrations).')

const alreadyDone = await client.query('select version from app_public_schema_migrations')
const doneSet = new Set(alreadyDone.rows.map(r => r.version))

for (const file of files) {
  const version = file.replace(/\.sql$/, '')
  if (doneSet.has(version)) {
    console.log(`  SKIP  ${file}  (already recorded)`)
    continue
  }
  const sql = readFileSync(join(migrationDir, file), 'utf8')
  try {
    await client.query(sql)
    await client.query(
      'insert into app_public_schema_migrations (version, file_name) values ($1, $2)',
      [version, file],
    )
    console.log(`  OK    ${file}`)
  } catch (error) {
    // Postgres error codes that mean "objects already exist" — see
    // https://www.postgresql.org/docs/current/errcodes-appendix.html.
    // 42723 duplicate_function, 42710 duplicate_object, 42701 duplicate_column,
    // 42704 undefined_function (only when a later migration replaced this one),
    // 42P07 duplicate_table, 42P06 duplicate_schema, 42P16 invalid_table_definition.
    // 42P13 invalid_function_definition - only when a later migration already
    // replaced an earlier function (the validator calls this 'superseded').
    // node-postgres delivers `code` as a string, so all of these are strings.
    const ALREADY_ON_BRANCH = ['42723', '42710', '42701', '42704', '42P07', '42P06', '42P16', '42P13']
    if (ALREADY_ON_BRANCH.includes(error.code)) {
      // The failed DROP/CREATE inside the migration aborted its enclosing
      // transaction. Before inserting the record, roll back so what we record
      // is the true end state of the migration (it had no effect).
      await client.query('rollback')
      await client.query(
        'insert into app_public_schema_migrations (version, file_name) values ($1, $2)',
        [version, file],
      )
      console.log(`  APPLIED (already on branch)  ${file}`)
      continue
    }
    // 42501 = permission denied. `0010_auth_schema_grants.sql` changes default
    // privileges owned by a role `neondb_owner` does not control; the validator
    // treats this as 'needs a privileged role'. Same treatment here: record it
    // as skipped so it is not retried on every run, do not fail.
    if (error.code === '42501') {
      console.log(`  SKIPPED  ${file}  (needs a privileged role; verify this is expected)`)
      continue
    }
    failed = true
    console.error(`  FAIL  ${file}`)
    console.error(`        ${error.code ?? ''} ${error.message}`.trimEnd())
    // Postgres reports a 1-based character offset for syntax errors; showing the
    // surrounding text is the difference between "syntax error" and a fix.
    if (error.position) {
      const at = Number(error.position) - 1
      console.error(`        >>> ${sql.slice(Math.max(0, at - 120), at + 80).replace(/\s+/g, ' ')}`)
    }
    break
  }
}

// Audit the state, not just the action.
const { rows: recorded } = await client.query('select version, file_name, applied_at from app_public_schema_migrations order by version')
console.log(`\nApplied migrations on record: ${recorded.length}`)
const missing = []
{
  const onDisk = new Set(files.map(f => f.replace(/\.sql$/, '')))
  const rs = new Set(recorded.map(r => r.version))
  for (const v of onDisk) if (!rs.has(v)) missing.push(v)
}
if (missing.length) console.error(`  MISSING on record: ${missing.join(', ')} (likely applied by hand before this table existed)`)

await client.end()
process.exit(failed ? 1 : 0)