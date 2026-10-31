#!/usr/bin/env node
/**
 * scripts/remap-user-ids.mjs
 *
 * Managed Better Auth on Neon does NOT preserve Supabase user ids. When the
 * existing users sign up on Neon, Better Auth mints brand-new uuids. Every
 * column that references a user therefore has to be repointed at the new ids
 * or the data becomes orphaned.
 *
 * ---------------------------------------------------------------------------
 *  REQUIRED ENV
 * ---------------------------------------------------------------------------
 *  TARGET_DATABASE_URL   Neon connection string. Required.
 *  USER_ID_MAP            Path to the remap JSON file, if not passed as argv[2].
 *
 * ---------------------------------------------------------------------------
 *  USAGE
 * ---------------------------------------------------------------------------
 *    node scripts/remap-user-ids.mjs ./user-id-map.json
 *    node scripts/remap-user-ids.mjs              # falls back to $USER_ID_MAP
 *
 *    # dry run: report orphan counts and collisions, change nothing
 *    node scripts/remap-user-ids.mjs ./user-id-map.json --dry-run
 *
 *  The map file is a flat JSON object of old -> new uuids:
 *
 *    {
 *      "11111111-1111-4111-8111-111111111101": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
 *      "11111111-1111-4111-8111-111111111102": "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"
 *    }
 *
 *  Generate it by email, which is the only stable key across the two systems:
 *
 *    -- source (Supabase)
 *    psql "$SOURCE_DATABASE_URL" -At -F',' \
 *      -c "select u.id, u.email from auth.users u order by u.email" > users.csv
 *    -- target (Neon)
 *    psql "$TARGET_DATABASE_URL" -At -F',' \
 *      -c 'select id, email from neon_auth.user order by email' > neon-users.csv
 *    # then join on email and emit the JSON object
 *
 * ---------------------------------------------------------------------------
 *  SAFETY MODEL
 * ---------------------------------------------------------------------------
 *  * The whole remap runs in ONE transaction. Any error rolls all of it back.
 *  * Collisions are DETECTED, not silently resolved: if a row already holds the
 *    new id in the column being remapped, the script aborts before writing
 *    anything, because that would merge two users' data together.
 *  * Orphan counts are printed before and after for every user-referencing
 *    column, and the script refuses to commit if any orphan remains.
 *  * The column list is DISCOVERED from the catalog (every FK to
 *    neon_auth.user, plus profiles.id) rather than hard-coded, so a schema
 *    change cannot silently leave a column unrepointed. The expected columns
 *    from db/migrations/0001..0009 are asserted against what the catalog
 *    reports, so a drift fails loudly.
 *  * Every statement is parameterized. No value from the map file is ever
 *    interpolated into SQL text.
 */

import { Client } from 'pg'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(HERE, 'out')
const REPORT_PATH = resolve(OUT_DIR, 'user-remap-report.json')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The 14 user-referencing columns in db/migrations/0001..0009. Used as an
 * assertion against the catalog, not as the source of truth: the actual work
 * list is discovered from pg_constraint so nothing can be missed.
 */
const EXPECTED_COLUMNS = [
  'organizations.created_by',
  'profiles.id',
  'memberships.user_id',
  'customers.created_by',
  'customers.verified_by',
  'products.created_by',
  'import_batches.created_by',
  'bills.created_by',
  'bills.updated_by',
  'bills.deleted_by',
  'bills.verified_by',
  'bill_attachments.created_by',
  'ocr_jobs.created_by',
  'audit_logs.actor_id',
]

// profiles.id is the PK of profiles and carries the FK to neon_auth.user(id),
// but audit_logs.actor_id has no FK: db/migrations/0001 never adds one for it,
// because actor_id is nullable and set from auth.uid() at write time. It still
// references a user and still needs repointing, so it is listed explicitly.
const EXTRA_COLUMNS = ['audit_logs.actor_id']

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const mapPath = args.find((a) => !a.startsWith('--')) ?? process.env.USER_ID_MAP

function fail(message, code = 1) {
  console.error(`\nremap-user-ids: ${message}\n`)
  process.exit(code)
}

if (!mapPath) {
  fail(
    'no remap file given.\n' +
      '  Pass it as the first argument, or set USER_ID_MAP:\n' +
      '    node scripts/remap-user-ids.mjs ./user-id-map.json',
    2,
  )
}

const resolvedMapPath = isAbsolute(mapPath) ? mapPath : resolve(process.cwd(), mapPath)

if (!process.env.TARGET_DATABASE_URL) {
  fail(
    'TARGET_DATABASE_URL is not set.\n' +
      '  It must be the Neon connection string, e.g.\n' +
      '  postgresql://<user>:<password>@ep-<id>.<region>.aws.neon.tech/neondb?sslmode=require',
    2,
  )
}

/** Quote an identifier for Postgres. */
function pgIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`
}

async function loadMap() {
  let text
  try {
    text = await readFile(resolvedMapPath, 'utf8')
  } catch (error) {
    fail(`cannot read the remap file ${resolvedMapPath}: ${error.message}`, 2)
  }

  let parsed
  try {
    // Windows editors frequently write a UTF-8 BOM into the remap file; it is not
    // part of the JSON. Written as an escape rather than a literal U+FEFF so the
    // character is visible in a diff and `no-irregular-whitespace` stays useful.
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (error) {
    fail(`the remap file is not valid JSON: ${error.message}`, 2)
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('the remap file must be a JSON object of {"<old-uuid>": "<new-uuid>"}', 2)
  }

  const entries = Object.entries(parsed)
  if (entries.length === 0) {
    fail('the remap file is empty; nothing to do', 2)
  }

  const map = []
  const seenNew = new Map()
  for (const [oldId, newId] of entries) {
    if (!UUID_RE.test(oldId) || !UUID_RE.test(String(newId))) {
      fail(
        `the remap file contains a value that is not a uuid:\n` +
          `  "${oldId}": ${JSON.stringify(newId)}`,
        2,
      )
    }
    const o = oldId.toLowerCase()
    const n = String(newId).toLowerCase()
    if (o === n) {
      fail(`the remap maps ${o} to itself; that entry does nothing`, 2)
    }
    if (seenNew.has(n)) {
      fail(
        `two different old ids are mapped onto the same new id ${n}:\n` +
          `  ${seenNew.get(n)} and ${o}\n` +
          '  Each old id must get its own new id.',
        2,
      )
    }
    seenNew.set(n, o)
    map.push({ oldId: o, newId: n })
  }
  return map
}

/**
 * Discovers every column that holds a user id:
 *  - any column with an FK to neon_auth.user(id), and
 *  - profiles.id (the PK that is itself the user id), and
 *  - the explicitly listed extras (audit_logs.actor_id, which has no FK).
 */
async function discoverUserColumns(client) {
  const { rows: fkColumns } = await client.query(
    `select c.relname::text as table_name,
            a.attname::text as column_name,
            true as via_fk
       from pg_catalog.pg_constraint con
       join pg_catalog.pg_class c on c.oid = con.conrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       join pg_catalog.pg_class refc on refc.oid = con.confrelid
       join pg_catalog.pg_namespace refn on refn.oid = refc.relnamespace
       join lateral unnest(con.conkey) with ordinality as k(attnum, ord) on true
       join pg_catalog.pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
      where con.contype = 'f'
        and n.nspname = 'public'
        and refn.nspname = 'neon_auth'
        and refc.relname = 'user'
        and a.attnum > 0
        and not a.attisdropped
      order by c.relname, a.attname`,
  )

  const columns = new Map()
  for (const row of fkColumns) {
    columns.set(`${row.table_name}.${row.column_name}`, {
      table: row.table_name,
      column: row.column_name,
      viaFk: true,
    })
  }

  // profiles.id has an FK in 0001, so it is already covered. Add anything from
  // EXTRA_COLUMNS that the FK discovery missed, and warn about the reverse.
  for (const qualified of EXTRA_COLUMNS) {
    const [table, column] = qualified.split('.')
    if (!columns.has(qualified)) {
      const exists = await client.query(
        `select 1
           from pg_catalog.pg_class c
           join pg_catalog.pg_namespace n on n.oid = c.relnamespace
           join pg_catalog.pg_attribute a on a.attrelid = c.oid
          where n.nspname = 'public' and c.relname = $1
            and a.attname = $2 and a.attnum > 0 and not a.attisdropped`,
        [table, column],
      )
      if (exists.rowCount > 0) {
        columns.set(qualified, { table, column, viaFk: false })
      }
    }
  }

  return [...columns.values()].sort(
    (a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column),
  )
}

/** Rows in `column` whose value is not present in neon_auth.user. */
async function countOrphans(client, table, column) {
  const { rows } = await client.query(
    `select count(*)::bigint as n
       from public.${pgIdent(table)} t
      where t.${pgIdent(column)} is not null
        and not exists (
          select 1 from neon_auth.user u where u.id = t.${pgIdent(column)}
        )`,
  )
  return Number(rows[0].n)
}

/** Rows that already hold one of the new ids, i.e. a collision. */
async function countCollisions(client, table, column, newIds) {
  const { rows } = await client.query(
    `select t.${pgIdent(column)}::text as existing_id, count(*)::bigint as n
       from public.${pgIdent(table)} t
      where t.${pgIdent(column)} = any($1::uuid[])
      group by 1
      order by 1`,
    [newIds],
  )
  return rows.map((r) => ({ existingId: r.existing_id, rows: Number(r.n) }))
}

/** Rows in `column` holding one of the old ids, i.e. what will be rewritten. */
async function countMatches(client, table, column, oldIds) {
  const { rows } = await client.query(
    `select count(*)::bigint as n
       from public.${pgIdent(table)} t
      where t.${pgIdent(column)} = any($1::uuid[])`,
    [oldIds],
  )
  return Number(rows[0].n)
}

async function main() {
  console.log('remap-user-ids: repoint user references at the Neon auth ids')
  console.log(`  map file: ${resolvedMapPath}`)
  console.log(`  mode:     ${DRY_RUN ? 'DRY RUN, nothing will be written' : 'APPLY'}`)
  console.log('')

  const map = await loadMap()
  console.log(`map: ${map.length} user(s)`)
  for (const { oldId, newId } of map) {
    console.log(`  ${oldId} -> ${newId}`)
  }

  const client = new Client({ connectionString: process.env.TARGET_DATABASE_URL })
  await client.connect()
  const result = {
    dryRun: DRY_RUN,
    map: map.map(({ oldId, newId }) => ({ oldId, newId })),
    columns: [],
  }

  try {
    // --- 1. the target must have the Neon Auth table -----------------------
    const authTable = await client.query(
      `select to_regclass('neon_auth.user') is not null as present`,
    )
    if (!authTable.rows[0].present) {
      fail(
        'neon_auth.user does not exist on the target.\n' +
          '  Enable Neon Auth on the branch first, then re-run scripts/migrate-data.mjs\n' +
          '  so the user FKs are created, then run this script again.',
      )
    }

    // --- 2. discover and cross-check the columns ---------------------------
    const columns = await discoverUserColumns(client)
    const qualified = columns.map((c) => `${c.table}.${c.column}`)
    const missing = EXPECTED_COLUMNS.filter((c) => !qualified.includes(c))
    const unexpected = qualified.filter((c) => !EXPECTED_COLUMNS.includes(c))

    console.log(`\nuser-referencing columns discovered: ${columns.length}`)
    if (missing.length > 0 || unexpected.length > 0) {
      fail(
        'the target schema does not match db/migrations/0001..0009 in its user columns.\n' +
          `  missing:    ${missing.join(', ') || '(none)'}\n` +
          `  unexpected: ${unexpected.join(', ') || '(none)'}\n` +
          '  Every user reference must be remapped or the data is orphaned.',
      )
    }

    // --- 3. every new id must already exist as a Neon auth user ------------
    const newIds = map.map((m) => m.newId)
    const { rows: missingUsers } = await client.query(
      `select u.id::text as id
         from unnest($1::uuid[]) as u(id)
        where not exists (select 1 from neon_auth.user a where a.id = u.id)
        order by 1`,
      [newIds],
    )
    if (missingUsers.length > 0) {
      fail(
        'these new ids do not exist in neon_auth.user, so remapping would violate the FKs:\n' +
          missingUsers.map((r) => `  ${r.id}`).join('\n') +
          '\n  Have these users sign up on Neon first, then re-run.',
      )
    }

    // --- 4. orphan counts BEFORE ------------------------------------------
    console.log('\norphans BEFORE')
    console.log('  column                          rows to remap  orphans')
    console.log('  ------------------------------  ------------  -------')
    const before = []
    for (const { table, column } of columns) {
      const [orphans, matches] = await Promise.all([
        countOrphans(client, table, column),
        countMatches(client, table, column, map.map((m) => m.oldId)),
      ])
      before.push({ table, column, orphans, matches })
      console.log(
        `  ${`${table}.${column}`.padEnd(30)}  ${String(matches).padStart(12)}  ${String(orphans).padStart(7)}`,
      )
    }

    // --- 5. collision detection -------------------------------------------
    // A collision is a row that ALREADY holds one of the new ids. Rewriting the
    // old ids would then make two distinct users share rows, silently merging
    // one person's data into another's. Abort instead.
    console.log('\ncollision check')
    const collisions = []
    for (const { table, column } of columns) {
      const found = await countCollisions(client, table, column, newIds)
      if (found.length > 0) {
        collisions.push({ table, column, found })
      }
    }
    if (collisions.length > 0) {
      console.log('')
      for (const c of collisions) {
        for (const f of c.found) {
          console.log(`  ${c.table}.${c.column} already holds ${f.existingId} in ${f.rows} row(s)`)
        }
      }
      fail(
        'collisions detected: rows already hold one of the new user ids.\n' +
          '  Remapping now would merge two users\' data together, so nothing was written.\n' +
          '  Resolve the duplicate rows (or correct the map) and re-run.',
      )
    }
    console.log('  no collisions')

    if (DRY_RUN) {
      console.log('\ndry run: nothing was written.')
      result.status = 'dry-run'
      await writeReport(result)
      return
    }

    // --- 6. apply, in one transaction -------------------------------------
    await client.query('begin')
    try {
      // The z_audit trigger would write a new audit row for every rewritten
      // row, which is correct for an application write but noise for a bulk id
      // migration: the actor is the migration, not a user. It is suppressed for
      // the transaction only, and ALTER TABLE ... DISABLE TRIGGER is
      // transactional so a rollback restores it.
      const disabled = await disableAuditTriggers(client)

      // Two triggers stand between the remap and the data, both for good reason:
      //
      //  * audit_logs is append-only: app_private.block_audit_mutation rejects
      //    every UPDATE, and audit_logs.actor_id is one of the columns that has
      //    to be repointed.
      //  * app_private.enforce_immutable_columns rejects any change to id,
      //    organization_id or created_at, and profiles.id IS the user id.
      //
      // Both are lifted inside this transaction only, restored before the
      // commit, and re-verified after it. If either is left disabled the script
      // exits non-zero with the exact ALTER TABLE needed to fix it.
      const lifted = []
      lifted.push(...(await disableAuditGuard(client)))
      lifted.push(...(await disableImmutableIdGuard(client, 'profiles')))

      const applied = []
      const oldIds = map.map((m) => m.oldId)
      const newIds = map.map((m) => m.newId)
      for (const { table, column } of columns) {
        // unnest of two parallel uuid arrays gives a (old_id, new_id) relation;
        // both arrays are bound parameters, never interpolated text.
        const sql =
          `update public.${pgIdent(table)} t ` +
          `set ${pgIdent(column)} = v.new_id ` +
          `from unnest($1::uuid[], $2::uuid[]) as v(old_id, new_id) ` +
          `where t.${pgIdent(column)} = v.old_id ` +
          `returning 1`
        const { rowCount } = await client.query(sql, [oldIds, newIds])
        applied.push({ table, column, rowsUpdated: rowCount ?? 0 })
      }

      for (const row of disabled) {
        await client.query(
          `alter table ${pgIdent(row.table)} enable trigger ${pgIdent(row.trigger)}`,
        )
      }
      console.log(
        '\n  NOTE: the append-only and immutable-column guards were lifted for\n' +
          '        this transaction only (audit_logs.actor_id and profiles.id are\n' +
          '        both guarded), and are restored before the commit and verified\n' +
          '        afterwards.',
      )
      await restoreLifted(client, lifted)

      // --- 7. orphan counts AFTER, inside the same transaction -------------
      const after = []
      let remainingOrphans = 0
      for (const { table, column } of columns) {
        const orphans = await countOrphans(client, table, column)
        remainingOrphans += orphans
        after.push({ table, column, orphans })
      }

      if (remainingOrphans > 0) {
        console.log('')
        for (const a of after) {
          if (a.orphans > 0) console.log(`  ${a.table}.${a.column}: ${a.orphans} orphan(s)`)
        }
        await client.query('rollback')
        fail(
          `${remainingOrphans} orphan(s) remain after the remap, so it was rolled back.\n` +
            '  Extend the map file with the remaining users and re-run.',
        )
      }

      await client.query('commit')
      await assertLiftedRestored(client, lifted)

      console.log('\nrows updated')
      console.log('  column                          rows')
      console.log('  ------------------------------  -----')
      for (const a of applied) {
        console.log(`  ${`${a.table}.${a.column}`.padEnd(30)}  ${String(a.rowsUpdated).padStart(5)}`)
      }

      console.log('\norphans AFTER')
      console.log('  column                          orphans')
      console.log('  ------------------------------  -------')
      for (const a of after) {
        console.log(`  ${`${a.table}.${a.column}`.padEnd(30)}  ${String(a.orphans).padStart(7)}`)
      }
      console.log('\ncommitted: every user reference resolves, 0 orphans remain')
      console.log(`report written to ${REPORT_PATH}`)

      result.status = 'ok'
      result.columns = columns.map((c) => {
        const b = before.find((x) => x.table === c.table && x.column === c.column)
        const a = after.find((x) => x.table === c.table && x.column === c.column)
        const u = applied.find((x) => x.table === c.table && x.column === c.column)
        return {
          column: `${c.table}.${c.column}`,
          viaForeignKey: c.viaFk,
          rowsMatchedBefore: b?.matches ?? 0,
          rowsUpdated: u?.rowsUpdated ?? 0,
          orphansBefore: b?.orphans ?? 0,
          orphansAfter: a?.orphans ?? 0,
        }
      })
      await writeReport(result)
    } catch (error) {
      try {
        await client.query('rollback')
      } catch {
        /* connection already unusable; the target is unaffected */
      }
      fail(`the remap failed and was rolled back: ${error.message}`)
    }
  } finally {
    await client.end().catch(() => {})
  }
}

async function disableAuditTriggers(client) {
  const { rows } = await client.query(
    `select c.relname::text as table, t.tgname as trigger
       from pg_catalog.pg_trigger t
       join pg_catalog.pg_class c on c.oid = t.tgrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and t.tgname = 'z_audit'
        and not t.tgisinternal
        and t.tgenabled <> 'D'
      order by c.relname`,
  )
  for (const row of rows) {
    await client.query(
      `alter table ${pgIdent(row.table)} disable trigger ${pgIdent(row.trigger)}`,
    )
  }
  return rows
}

/**
 * Lifts the append-only guard on audit_logs so audit_logs.actor_id can be
 * repointed. Only ever called inside the remap transaction, and always paired
 * with restoreLifted before the commit.
 */
async function disableAuditGuard(client) {
  const rows = await findTriggers(client, 'audit_logs', [
    'block_audit_update',
    'block_audit_truncate',
  ])
  if (rows.length === 0) {
    throw new Error(
      'the audit_logs append-only triggers are missing; refusing to remap actor_id',
    )
  }
  await disable(client, rows)
  return rows
}

/**
 * Lifts app_private.enforce_immutable_columns on `table` so its id can be
 * repointed. profiles.id is the user id, so the guard blocks the remap.
 */
async function disableImmutableIdGuard(client, table) {
  const rows = await findTriggers(client, table, ['b_immutable_columns'])
  if (rows.length === 0) {
    throw new Error(
      `public.${table}.b_immutable_columns is missing; ` +
        'refusing to remap a table with no immutability guard to verify against',
    )
  }
  await disable(client, rows)
  return rows
}

async function findTriggers(client, table, names) {
  const { rows } = await client.query(
    `select c.relname::text as table, t.tgname as trigger, t.tgenabled as enabled
       from pg_catalog.pg_trigger t
       join pg_catalog.pg_class c on c.oid = t.tgrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = $1
        and t.tgname = any($2::text[])
        and not t.tgisinternal
        and t.tgenabled <> 'D'
      order by t.tgname`,
    [table, names],
  )
  return rows
}

async function disable(client, rows) {
  for (const row of rows) {
    await client.query(
      `alter table ${pgIdent(row.table)} disable trigger ${pgIdent(row.trigger)}`,
    )
  }
}

async function restoreLifted(client, lifted) {
  for (const row of lifted) {
    await client.query(
      `alter table ${pgIdent(row.table)} enable trigger ${pgIdent(row.trigger)}`,
    )
  }
}

/** Fails loudly if any lifted trigger was left disabled. */
async function assertLiftedRestored(client, lifted) {
  const stillOff = []
  for (const row of lifted) {
    const { rows } = await client.query(
      `select t.tgenabled as enabled
         from pg_catalog.pg_trigger t
         join pg_catalog.pg_class c on c.oid = t.tgrelid
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = $1 and t.tgname = $2`,
      [row.table, row.trigger],
    )
    if (rows.length > 0 && rows[0].enabled !== 'O') {
      stillOff.push({ ...row, enabled: rows[0].enabled })
    }
  }
  if (stillOff.length > 0) {
    fail(
      'these security triggers were left DISABLED after the remap:\n' +
        stillOff
          .map((r) => `  ${r.table}.${r.trigger} (tgenabled=${r.enabled})`)
          .join('\n') +
        '\n\n  Re-enable them manually:\n' +
        stillOff
          .map(
            (r) =>
              `  alter table public.${pgIdent(r.table)} enable trigger ${pgIdent(r.trigger)};`,
          )
          .join('\n'),
    )
  }
}

async function writeReport(result) {
  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(
    REPORT_PATH,
    JSON.stringify(
      {
        tool: 'remap-user-ids.mjs',
        generatedAt: new Date().toISOString(),
        target: process.env.TARGET_DATABASE_URL?.replace(/\/\/[^@]*@/, '//***@') ?? null,
        status: result.status,
        dryRun: result.dryRun,
        map: result.map,
        columns: result.columns,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  )
}

main().catch(async (error) => {
  console.error(`\nremap-user-ids: unexpected failure: ${error?.stack ?? error}\n`)
  process.exit(1)
})
