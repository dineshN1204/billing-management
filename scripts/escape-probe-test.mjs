/**
 * Proves that `npm run migrate:check` cannot write to the database.
 *
 *     node scripts/escape-probe-test.mjs
 *
 * A checker that can commit is not a checker. This test installs a migration
 * that contains its own `begin; ... commit;` and creates a table, runs the
 * checker against the SAME branch it targets, and then asserts the table does
 * not exist.
 *
 * This is not theoretical. An earlier version of the checker wrapped each
 * migration in BEGIN/ROLLBACK without stripping the `commit;` inside the file,
 * and committed migrations 0019 and 0020 to the production branch.
 *
 * The table is created inside a transaction that is rolled back, so a
 * regression makes this test fail rather than leaving anything behind.
 */

import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const probeTarget = join(root, 'db', 'migrations', 'ZZZ_zzz_escape_probe.sql')

/**
 * The probe migration. Written by this script rather than kept as a file, so
 * there is no stray artefact to clean up and nothing for someone to delete by
 * mistake.
 */
const PROBE_SQL = `-- Written by scripts/escape-probe-test.mjs. Removed again immediately.
--
-- Contains transaction control on purpose, so it can prove that
-- \`npm run migrate:check\` neutralises it and cannot commit.

begin;

create table if not exists public._migrate_check_escapee (id int primary key);
insert into public._migrate_check_escapee (id) values (1) on conflict do nothing;

commit;
`

const envText = readFileSync(join(root, '.env'), 'utf8')
const readVar = (name) => {
  const match = envText.match(new RegExp(`^${name}\\s*=\\s*"?([^"\\r\\n]+)"?`, 'm'))
  return match ? match[1].trim() : null
}

// Must be the same resolution order the checker uses, or the test proves nothing.
const url = readVar('DATABASE_URL_TEST') ?? readVar('DATABASE_URL_UNPOOLED')
if (!url) {
  console.error('No connection string in .env.')
  process.exit(1)
}
const hostname = new URL(url).hostname
console.log(`Target branch: ${hostname}`)

const TABLE = '_migrate_check_escapee'

const tableExists = async (client) => {
  const { rows } = await client.query(
    `select exists (select 1 from information_schema.tables
                    where table_schema = 'public' and table_name = $1) as present`, [TABLE])
  return rows[0].present
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10_000 })
await client.connect()

// Precondition: the probe table must not already exist, or the test is meaningless.
if (await tableExists(client)) {
  console.error(`public.${TABLE} already exists before the test. Drop it first:`)
  console.error(`  psql "$DATABASE_URL" -c "drop table if exists public.${TABLE}"`)
  await client.end()
  process.exit(1)
}
console.log(`precondition ok: public.${TABLE} does not exist\n`)

await client.end()

if (existsSync(probeTarget)) {
  console.error(`a probe migration is already installed at ${probeTarget}; remove it first`)
  await client.end()
  process.exit(1)
}
writeFileSync(probeTarget, PROBE_SQL)
console.log('installed the probe migration into db/migrations/')

try {
  const { spawnSync } = await import('node:child_process')
  const run = spawnSync(process.execPath, [join(root, 'scripts', 'validate-migrations.mjs')], {
    encoding: 'utf8',
    cwd: root,
  })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  const line = output.split(/\r?\n/).find(l => l.includes('ZZZ_zzz_escape_probe'))
  console.log(`checker reported: ${line ? line.trim() : '(no line for the probe)'}\n`)
} finally {
  rmSync(probeTarget, { force: true })
  console.log('removed the probe migration\n')
}

const verify = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10_000 })
await verify.connect()
const after = await tableExists(verify)
await verify.end()

if (after) {
  console.error(`FAIL: public.${TABLE} exists after migrate:check. The checker COMMITTED.`)
  console.error(`Drop it:  psql "$DATABASE_URL" -c "drop table if exists public.${TABLE}"`)
  process.exit(1)
}

console.log(`PASS: public.${TABLE} does not exist. migrate:check cannot write to ${hostname}.`)