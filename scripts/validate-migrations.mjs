/**
 * Syntax-checks migrations without applying them.
 *
 *     npm run migrate:check
 *
 * Every migration is run inside a transaction that is rolled back, so the
 * database is left byte-identical. This catches the mistakes that are easy to
 * make in PL/pgSQL and impossible to see by reading - a missing semicolon, a
 * reference to a function that does not exist, a mismatched RETURNS TABLE.
 *
 * -------------------------------------------------------------------------
 * SAFETY: why the transaction control below is stripped, and do not undo it
 * -------------------------------------------------------------------------
 * An earlier version of this script wrapped each migration in BEGIN/ROLLBACK and
 * did NOT neutralise the `begin; ... commit;` inside the migration files. A
 * migration's own `COMMIT` ends the enclosing transaction, so the script's
 * ROLLBACK became a no-op and **migrations 0019 and 0020 were committed to the
 * production branch** by what was advertised as a read-only check.
 *
 * The damage was benign - 0019 replaces a read-only report function and 0020
 * adds three functions; neither touches a table or a row, and the end state was
 * exactly what the migrations intended. But a checker that can write to
 * production is not a checker, so:
 *
 *   1. transaction control is stripped before the statement is sent, and the
 *      script refuses to run if any survives;
 *   2. the script refuses to touch a production-looking endpoint unless
 *      --allow-production is passed explicitly;
 *   3. after each migration the script asserts it is still inside its own
 *      transaction, and aborts the whole run if it is not.
 *
 * This is a syntax and name-resolution check, not a behavioural test.
 * Behaviour is covered by `npm run test:db` against a test branch, which
 * impersonates a real member and therefore exercises RLS as well.
 */

import { readFileSync, readdirSync } from 'node:fs'
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
  console.error('No database connection string in .env (DATABASE_URL_TEST or DATABASE_URL_UNPOOLED).')
  process.exit(1)
}

// Refuse anything that looks like a live branch unless explicitly told otherwise.
const hostname = new URL(url).hostname
const looksProduction = /(^|[.-])(prod|production|live|primary|main)([.-]|$)/i.test(hostname)
const allowProduction = process.argv.includes('--allow-production')
if (looksProduction && !allowProduction) {
  console.error(`Refusing to check against what looks like production: ${hostname}`)
  console.error('Pass --allow-production if you are certain. Note that this script now')
  console.error('cannot commit, but a syntax check is better run on a test branch anyway.')
  process.exit(1)
}

const migrationDir = join(root, 'db', 'migrations')
const files = readdirSync(migrationDir).filter(name => name.endsWith('.sql')).sort()
if (files.length === 0) {
  console.error('No migrations found.')
  process.exit(1)
}

/**
 * Removes transaction control from the SQL.
 *
 * `begin;` / `commit;` / `rollback;` / `start transaction;` as standalone
 * statements are what let a migration escape the checker's transaction. They
 * become comments, which keeps the line numbers intact for error reporting.
 *
 * A `begin` inside a `DO $$ ... $$` body is a PL/pgSQL block, not transaction
 * control, so only line-anchored statements are touched.
 */
function neutraliseTransactionControl(sql) {
  const lines = sql.split('\n')
  const rewritten = lines.map((line, index) => {
    const match = line.match(/^(\s*)(begin|commit|rollback|start\s+transaction|end\s+transaction)\s*;\s*(--.*)?$/i)
    if (!match) return line
    return `${match[1]}-- [migrate:check] transaction control removed on line ${index + 1}: ${match[2]}`
  })
  return rewritten.join('\n')
}

/**
 * Fails loudly if any transaction control survived neutralisation.
 *
 * Runs on the *rewritten* text: the point is to prove nothing slipped through,
 * not to object to transaction control being present in the file. Migrations in
 * this project are expected to wrap themselves in begin/commit.
 */
function assertNoTransactionControl(sql, file) {
  const lines = sql.split('\n')
  const offender = lines.findIndex(line =>
    /^\s*(begin|commit|rollback|start\s+transaction|end\s+transaction)\s*;\s*(--.*)?$/i.test(line))
  if (offender >= 0) {
    failures += 1
    console.error(`  FAIL      ${file}`)
    console.error(`            transaction control survived neutralisation on line ${offender + 1}; refusing to run it.`)
    return false
  }
  return true
}

function isAlreadyApplied(message) {
  return /already exists/i.test(message)
}

function isPrivilegeLimit(message) {
  return /permission denied to change default privileges/i.test(message)
}

/** A later migration replaced this function, so replaying the earlier one cannot work. */
function isSuperseded(message) {
  return /cannot change return type of existing function/i.test(message)
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10_000 })
await client.connect()
console.log(`Checking ${files.length} migration(s) against ${hostname}.`)
console.log('Nothing will be committed.\n')

let failures = 0
let alreadyApplied = 0
let privilegeLimited = 0
let superseded = 0

for (const file of files) {
  const raw = readFileSync(join(migrationDir, file), 'utf8')
  const sql = neutraliseTransactionControl(raw)
  if (!assertNoTransactionControl(sql, file)) continue

  await client.query('begin')
  try {
    // A temp table created inside this transaction is the probe. If anything in
    // the migration commits, the probe survives the ROLLBACK and the whole run
    // stops rather than continuing to run unprotected.
    await client.query('create temporary table _migrate_check_probe (id int)')

    await client.query(sql)

    await client.query('rollback')

    const { rows: probe } = await client.query(
      `select to_regclass('pg_temp._migrate_check_probe') is null as gone`)
    if (probe[0]?.gone !== true) {
      throw new Error('the rollback did not take effect - a statement committed the transaction. ABORTING.')
    }

    console.log(`  ok        ${file}`)
  } catch (error) {
    try { await client.query('rollback') } catch { /* already aborted */ }
    const message = String(error.message ?? error)

    if (isAlreadyApplied(message)) { alreadyApplied += 1; console.log(`  applied   ${file}  (objects already on this branch)`); continue }
    if (isPrivilegeLimit(message)) { privilegeLimited += 1; console.log(`  skipped   ${file}  (needs a privileged role)`); continue }
    if (isSuperseded(message)) { superseded += 1; console.log(`  superseded ${file}  (a later migration replaced its function)`); continue }

    failures += 1
    console.error(`  FAIL      ${file}`)
    if (/rollback did not take effect/.test(message)) {
      console.error('            A MIGRATION COMMITTED. Stop and investigate before running anything else.')
    }
    console.error(`            ${message}`)
    const position = error.position ?? error.internalPosition
    if (position) console.error(`            near line ${sql.slice(0, position).split('\n').length} of ${file}`)
  }
}

await client.end()

console.log(
  `\n${files.length} checked: ${files.length - alreadyApplied - privilegeLimited - superseded - failures} apply cleanly, `
  + `${alreadyApplied} already on this branch, ${superseded} superseded by a later migration, `
  + `${privilegeLimited} need a privileged role, ${failures} failed.`
)
console.log('Nothing was committed.')

if (failures > 0) process.exit(1)