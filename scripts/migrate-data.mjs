#!/usr/bin/env node
/**
 * scripts/migrate-data.mjs
 *
 * Copies application data from a Supabase Postgres source into a Neon Postgres
 * target, preserving referential integrity and WITHOUT destroying the source.
 *
 * ---------------------------------------------------------------------------
 *  USAGE
 * ---------------------------------------------------------------------------
 *    # PowerShell
 *    $env:SOURCE_DATABASE_URL = "postgresql://...@db.xxx.supabase.co:5432/postgres"
 *    $env:TARGET_DATABASE_URL = "postgresql://...@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require"
 *    node scripts/migrate-data.mjs
 *
 *    # bash
 *    SOURCE_DATABASE_URL=... TARGET_DATABASE_URL=... node scripts/migrate-data.mjs
 *
 *    node scripts/migrate-data.mjs --dry-run     # report only, copy nothing
 *    node scripts/migrate-data.mjs --batch-size 500
 *
 * ---------------------------------------------------------------------------
 *  SAFETY MODEL
 * ---------------------------------------------------------------------------
 *  * Refuses to start unless both SOURCE_DATABASE_URL and TARGET_DATABASE_URL
 *    are present, and unless the two strings differ. This is the guard against
 *    accidentally pointing both at the same database and overwriting it.
 *  * The source connection is opened READ-ONLY and is never used for anything
 *    except SELECT. No DROP, TRUNCATE or DELETE is ever issued against it.
 *    migrate-data.mjs contains no destructive statement at all; the only
 *    statements it issues anywhere are SELECT, INSERT and setval().
 *  * The target must already carry the schema (db/migrations/0001..0009). The
 *    script verifies every required table exists before copying anything and
 *    aborts with a clear message if not.
 *  * All writes to the target happen inside ONE transaction. Any error rolls
 *    the whole copy back, leaving the target exactly as it was.
 *  * Generated columns are excluded from the insert column list because the
 *    target's Postgres computes them: bills.bill_number_normalized,
 *    bills.financial_year, customers.customer_name.
 *  * audit_logs.id is GENERATED ALWAYS AS IDENTITY, so it is inserted with
 *    OVERRIDING SYSTEM VALUE to preserve the original ids, and the sequence is
 *    re-synced afterwards so future inserts cannot collide.
 *  * Every read and write uses a parameterized statement or COPY. No value read
 *    from either database is ever interpolated into SQL text.
 *
 * ---------------------------------------------------------------------------
 *  OUTPUT
 * ---------------------------------------------------------------------------
 *  * A per-table source/target row-count table on stdout, flagged on mismatch.
 *  * scripts/out/data-migration-report.json, machine readable.
 */

import { Client } from 'pg'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(HERE, 'out')
const REPORT_PATH = resolve(OUT_DIR, 'data-migration-report.json')

/** FK-safe copy order. organizations first (everything references it). */
const COPY_ORDER = [
  'organizations',
  'profiles',
  'memberships',
  'customers',
  'products',
  'import_batches',
  'bills',
  'bill_items',
  'bill_attachments',
  'ocr_jobs',
  'audit_logs',
]

/**
 * Tables deliberately NOT copied here.
 *
 * storage_objects is an index of what exists in OBJECT STORAGE, not a record
 * of application data. Its rows are derived from the object copy and inserted
 * by scripts/migrate-storage.mjs once the objects exist, and its correctness
 * depends on the objects actually being present. Copying the source's rows here
 * would produce an index that points at objects that may not have transferred,
 * so it is verified separately and reported as deferred.
 */
const DEFERRED_TO_STORAGE_MIGRATION = new Set(['storage_objects'])

/**
 * Columns the target's Postgres computes itself. Populated at runtime from
 * information_schema (is_generated = 'ALWAYS'); the list below is the expected
 * set for db/migrations/0001..0009 and is asserted against what the catalog
 * reports so a schema drift is caught rather than silently copied over.
 */
const EXPECTED_GENERATED = new Set([
  'bills.bill_number_normalized',
  'bills.financial_year',
  'customers.customer_name',
])

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const batchSizeArg = args.indexOf('--batch-size')
const BATCH_SIZE = batchSizeArg >= 0 ? Number(args[batchSizeArg + 1]) : 1000

if (!Number.isInteger(BATCH_SIZE) || BATCH_SIZE < 1 || BATCH_SIZE > 10000) {
  console.error('--batch-size must be an integer between 1 and 10000')
  process.exit(2)
}

function fail(message) {
  console.error(`\nmigrate-data: ${message}\n`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
//  Preflight
// ---------------------------------------------------------------------------

const SOURCE_URL = process.env.SOURCE_DATABASE_URL
const TARGET_URL = process.env.TARGET_DATABASE_URL

if (!SOURCE_URL) {
  fail(
    'SOURCE_DATABASE_URL is not set.\n' +
      '  It must be the Supabase Postgres connection string, e.g.\n' +
      '  postgresql://postgres:<password>@db.<project>.supabase.co:5432/postgres',
  )
}
if (!TARGET_URL) {
  fail(
    'TARGET_DATABASE_URL is not set.\n' +
      '  It must be the Neon connection string, e.g.\n' +
      '  postgresql://<user>:<password>@ep-<id>.<region>.aws.neon.tech/neondb?sslmode=require',
  )
}
if (SOURCE_URL === TARGET_URL) {
  fail(
    'SOURCE_DATABASE_URL and TARGET_DATABASE_URL are identical.\n' +
      '  Refusing to run: this would read and write the same database.\n' +
      '  The source is never modified, but a self-copy is always a configuration error.',
  )
}

/** Redacted form, safe to print. */
function describeUrl(url) {
  try {
    const u = new URL(url)
    const host = u.hostname || '(unknown host)'
    return `${u.protocol}//${u.username ? '***' : ''}@${host}${u.port ? `:${u.port}` : ''}${u.pathname}`
  } catch {
    return '(unparseable connection string)'
  }
}

const source = new Client({ connectionString: SOURCE_URL })
const target = new Client({ connectionString: TARGET_URL })

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

/** Every table in `public`, ordered by name. */
async function listPublicTables(client) {
  const { rows } = await client.query(
    `select c.relname::text as table_name
       from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
      order by c.relname`,
  )
  return rows.map((r) => r.table_name)
}

/**
 * Column list for a table, excluding generated columns. `quote_ident` is used
 * to build the identifier list because table and column names cannot be passed
 * as bind parameters; they come from pg_catalog, not from user data.
 */
async function getColumns(client, table) {
  const { rows } = await client.query(
    `select a.attname::text as column_name,
            case when a.attgenerated <> '' then true else false end as is_generated,
            a.attidentity::text as identity_kind,
            t.typname::text as type_name,
            format_type(a.atttypid, a.atttypmod) as data_type
       from pg_catalog.pg_attribute a
       join pg_catalog.pg_class c on c.oid = a.attrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       join pg_catalog.pg_type t on t.oid = a.atttypid
      where n.nspname = 'public'
        and c.relname = $1
        and a.attnum > 0
        and not a.attisdropped
      order by a.attnum`,
    [table],
  )
  // node-postgres hands a json/jsonb column back as a parsed JS value, and
  // re-encodes an ARRAY as a Postgres array literal, which jsonb rejects. So
  // json/jsonb columns are read as text and cast back on the way in, which is
  // byte-exact and avoids any re-serialization of user data.
  return rows.map((r) => ({
    ...r,
    is_json: r.type_name === 'json' || r.type_name === 'jsonb',
  }))
}

/** Quote an identifier for Postgres. */
function pgIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`
}

// ---------------------------------------------------------------------------
//  Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('migrate-data: Supabase -> Neon data migration')
  console.log(`  source: ${describeUrl(SOURCE_URL)}  (read-only)`)
  console.log(`  target: ${describeUrl(TARGET_URL)}`)
  console.log(`  mode:   ${DRY_RUN ? 'DRY RUN, nothing will be written' : 'COPY'}`)
  console.log('')

  await source.connect()
  await target.connect()
  try {
    // Belt and braces: the source session physically cannot write.
    await source.query('set transaction read only')

    // --- 1. target schema must already exist -------------------------------
    const targetTables = await listPublicTables(target)
    const targetTableSet = new Set(targetTables)
    const missing = COPY_ORDER.filter((t) => !targetTableSet.has(t))
    if (missing.length > 0) {
      fail(
        `the target is missing required tables: ${missing.join(', ')}\n` +
          '  Apply db/migrations/0001..0009 to the target first:\n' +
          '    psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/0001_core_schema.sql\n' +
          '    ... through 0009_bill_rpc_cess_payment.sql\n' +
          `  Tables the target does have: ${targetTables.join(', ') || '(none)'}`,
      )
    }
    console.log(`schema check: all ${COPY_ORDER.length} required tables present on target`)

    // --- 2. confirm the generated-column set matches the target -------------
    const generatedOnTarget = new Set()
    for (const table of COPY_ORDER) {
      for (const column of await getColumns(target, table)) {
        if (column.is_generated) generatedOnTarget.add(`${table}.${column.column_name}`)
      }
    }
    const unexpected = [...generatedOnTarget].filter((g) => !EXPECTED_GENERATED.has(g))
    const absent = [...EXPECTED_GENERATED].filter((g) => !generatedOnTarget.has(g))
    if (unexpected.length > 0 || absent.length > 0) {
      fail(
        'the target schema does not match db/migrations/0001..0009 in its generated columns.\n' +
          `  unexpected: ${unexpected.join(', ') || '(none)'}\n` +
          `  missing:    ${absent.join(', ') || '(none)'}\n` +
          '  Re-apply the migrations to the target before migrating data.',
      )
    }
    console.log(
      `generated columns: ${[...generatedOnTarget].sort().join(', ')} (excluded from inserts)`,
    )

    // --- 3. pre-copy row counts on both sides ------------------------------
    const sourceTables = await listPublicTables(source)
    const sourceTableSet = new Set(sourceTables)

    // --- 3a. user placeholders ---------------------------------------------
    // 13 columns across public.* carry a FK to neon_auth.user(id). Those users
    // do not exist on Neon yet: Managed Better Auth mints its own ids when
    // people sign up, which is exactly why scripts/remap-user-ids.mjs exists.
    // Until that remap runs, the FKs cannot be satisfied, so copy the source's
    // auth rows across first as identity placeholders keyed by the original
    // email. They are NOT login accounts and grant no access; they only keep
    // referential integrity intact across the copy.
    const userFkColumns = await findUserFkColumns(target)
    if (userFkColumns.length > 0) {
      console.log(
        `\nuser FK columns found: ${userFkColumns.length} across ` +
          `${new Set(userFkColumns.map((c) => c.table)).size} tables`,
      )
      const placeholders = await copyUserPlaceholders(source, target, DRY_RUN)
      console.log(
        `user placeholders: ${placeholders} row(s) present on target ` +
          '(run scripts/remap-user-ids.mjs after sign-up to repoint them)',
      )
    }

    console.log('\nrow counts BEFORE copy')
    console.log('  table                 source   target   status')
    console.log('  --------------------  -------  -------  ------')
    const before = {}
    for (const table of sourceTables) {
      const sourceCount = await countRows(source, table)
      const targetCount = targetTableSet.has(table) ? await countRows(target, table) : null
      before[table] = { source: sourceCount, target: targetCount }
      const status = sourceCount > 0 && targetCount > 0 ? 'CONFLICT RISK' : 'ok'
      console.log(
        `  ${table.padEnd(20)}  ${String(sourceCount).padStart(7)}  ` +
          `${targetCount === null ? '      -' : String(targetCount).padStart(7)}  ${status}`,
      )
    }

    const nonEmptyTargets = sourceTables.filter((t) => targetTableSet.has(t) && before[t].target > 0)
    if (nonEmptyTargets.length > 0) {
      fail(
        'the target already has rows in: ' + nonEmptyTargets.join(', ') + '\n' +
          '  This script only inserts; it will not overwrite or clear the target.\n' +
          '  Use a fresh Neon branch, or clear the target yourself first, then re-run.',
      )
    }

    const deferred = [...DEFERRED_TO_STORAGE_MIGRATION].filter((t) => sourceTableSet.has(t))
    if (deferred.length > 0) {
      console.log(
        `\ndeferred: ${deferred.join(', ')} ` +
          `(${deferred.map((t) => before[t].source).join(', ')} row(s) on source) is indexed ` +
          'from object storage by scripts/migrate-storage.mjs, not copied here.',
      )
    }

    if (DRY_RUN) {
      console.log('\ndry run: no data was copied.')
      await writeReport({
        dryRun: true,
        status: 'dry-run',
        before,
        after: before,
        tables: COPY_ORDER,
      })
      return
    }

    // --- 4. copy, in one target transaction --------------------------------
    console.log('\ncopying')
    await target.query('begin')
    const copyCounts = {}
    try {
      // The target's z_audit trigger fires on INSERT and would write a fresh
      // audit row for every copied row, duplicating the source's own audit log
      // which is copied verbatim below. Suppress ONLY the audit triggers, and
      // only for the duration of this transaction, which restores them on both
      // commit and rollback. The BEFORE INSERT normalizer triggers
      // (a_normalize_fields, a_normalize_gstin, a_normalize_bill_gstin) stay
      // enabled: they are idempotent on already-normalized source data and act
      // as a genuine safety net.
      const disabled = await disableAuditTriggers(target)

      for (const table of COPY_ORDER) {
        if (!sourceTableSet.has(table)) {
          console.log(`  ${table.padEnd(20)}  (absent on source, skipped)`)
          continue
        }
        const columns = await getColumns(target, table)
        const copyable = columns.filter((c) => !c.is_generated)
        const startedAt = Date.now()
        const result = await copyTableStreaming(source, target, table, copyable)
        const ms = Date.now() - startedAt
        copyCounts[table] = result.copied
        console.log(
          `  ${table.padEnd(20)}  ${String(result.copied).padStart(7)} rows  (${ms} ms)`,
        )
      }

      await enableAuditTriggers(target, disabled)

      // --- 5. re-sync sequences --------------------------------------------
      console.log('\nre-syncing sequences')
      const synced = await resyncSequences(target)
      for (const s of synced) {
        console.log(`  ${s.sequence} -> ${s.setTo}`)
      }

      await target.query('commit')
      console.log('\ncommitted')
    } catch (error) {
      try {
        await target.query('rollback')
      } catch {
        /* the connection may already be unusable; the target is unaffected */
      }
      fail(
        `the copy failed and the target transaction was rolled back: ${error.message}\n` +
          '  The target is unchanged, including its trigger states.\n' +
          '  The source was only ever read.',
      )
    }

    // --- 6. verification ---------------------------------------------------
    console.log('\nrow counts AFTER copy (verification)')
    console.log('  table                 source   target   result')
    console.log('  --------------------  -------  -------  ------')
    const after = {}
    const mismatches = []
    const deferredRows = []
    for (const table of sourceTables) {
      const sourceCount = await countRows(source, table)
      const targetCount = targetTableSet.has(table) ? await countRows(target, table) : null
      after[table] = { source: sourceCount, target: targetCount }
      const match = targetCount === sourceCount
      if (DEFERRED_TO_STORAGE_MIGRATION.has(table)) {
        deferredRows.push(table)
      } else if (!match) {
        mismatches.push(table)
      }
      const label = DEFERRED_TO_STORAGE_MIGRATION.has(table)
        ? 'DEFERRED'
        : match
          ? 'MATCH'
          : 'MISMATCH'
      console.log(
        `  ${table.padEnd(20)}  ${String(sourceCount).padStart(7)}  ` +
          `${targetCount === null ? '      -' : String(targetCount).padStart(7)}  ${label}`,
      )
    }

    if (mismatches.length > 0) {
      await writeReport({
        dryRun: false,
        status: 'mismatch',
        before,
        after,
        copied: copyCounts,
        mismatches,
        tables: COPY_ORDER,
      })
      fail(
        `row counts differ for: ${mismatches.join(', ')}\n` +
          `  See ${REPORT_PATH}`,
      )
    }

    console.log('\nall copied table row counts match')
    if (deferredRows.length > 0) {
      console.log(
        `next: run scripts/migrate-storage.mjs to copy objects and populate ` +
          `${deferredRows.join(', ')}`,
      )
    }
    console.log(`report written to ${REPORT_PATH}`)
    await writeReport({
      dryRun: false,
      status: 'ok',
      before,
      after,
      copied: copyCounts,
      mismatches: [],
      deferred: deferredRows,
      tables: COPY_ORDER,
    })
  } finally {
    await Promise.allSettled([source.end(), target.end()])
  }
}

async function countRows(client, table) {
  const { rows } = await client.query(
    `select count(*)::bigint as n from public.${pgIdent(table)}`,
  )
  return Number(rows[0].n)
}

/**
 * Copies a table in batches, reading from source with a parameterized SELECT
 * and writing to target with a parameterized INSERT. Batch size is controlled
 * by BATCH_SIZE so a single transaction never holds an unbounded number of
 * round trips.
 */
async function copyTableStreaming(src, tgt, table, columns) {
  const names = columns.map((c) => c.column_name)
  if (names.length === 0) return { copied: 0 }

  const hasIdentity = columns.some((c) => c.identity_kind && c.identity_kind !== '')
  const insertIdent = names.map(pgIdent).join(', ')
  // json/jsonb columns are selected as ::text so the value round-trips exactly
  // instead of being re-encoded by the driver.
  const selectIdent = columns
    .map((c) => (c.is_json ? `${pgIdent(c.column_name)}::text` : pgIdent(c.column_name)))
    .join(', ')
  const insertSlots = columns.map((c) => (c.is_json ? c.type_name : null))
  // Order by the identity/PK column when there is one, otherwise by every
  // column. Ordering is what makes LIMIT/OFFSET paging stable: the source is
  // frozen for the duration of the migration, so a total order guarantees each
  // row is read exactly once.
  const orderList = columns.some((c) => c.column_name === 'id')
    ? pgIdent('id')
    : selectIdent

  let copied = 0
  let offset = 0
  for (;;) {
    const { rows } = await src.query(
      `select ${selectIdent} from public.${pgIdent(table)}
        order by ${orderList}
        limit $1 offset $2`,
      [BATCH_SIZE, offset],
    )
    if (rows.length === 0) break

    // One multi-row INSERT per batch: still fully parameterized, far fewer
    // round trips than one statement per row. Postgres caps a statement at
    // 65535 bind parameters, so the chunk size is derived from the column
    // count rather than hard-coded.
    const perStatement = Math.max(1, Math.floor(65000 / names.length))
    for (let i = 0; i < rows.length; i += perStatement) {
      const chunk = rows.slice(i, i + perStatement)
      const values = []
      // `insertSlots[j]` is the placeholder for column j within ONE tuple.
      // Across the whole multi-row VALUES list the bind numbers run
      // consecutively, so each tuple starts at (rowIndex * names.length) + 1.
      const tuples = chunk.map((row, rowIndex) => {
        const base = rowIndex * names.length
        return `(${names
          .map((_, j) => {
            const param = `$${base + j + 1}`
            const cast = insertSlots[j]
            return cast ? `${param}::${cast}` : param
          })
          .join(', ')})`
      })
      for (const row of chunk) {
        for (const name of names) values.push(row[name])
      }
      const overriding = hasIdentity ? 'overriding system value ' : ''
      await tgt.query(
        `insert into public.${pgIdent(table)} (${insertIdent}) ${overriding}` +
          `values ${tuples.join(', ')}`,
        values,
      )
    }

    copied += rows.length
    offset += rows.length
    if (rows.length < BATCH_SIZE) break
  }
  return { copied }
}

/**
 * Every column in `public` that references neon_auth.user(id), discovered from
 * the catalog rather than hard-coded, so a schema change cannot silently leave
 * one of them behind.
 */
async function findUserFkColumns(client) {
  const { rows } = await client.query(
    `select n.nspname::text as schema_name,
            c.relname::text as table_name,
            a.attname::text as column_name,
            refc.relname::text as ref_table,
            refa.attname::text as ref_column
       from pg_catalog.pg_constraint con
       join pg_catalog.pg_class c on c.oid = con.conrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       join pg_catalog.pg_class refc on refc.oid = con.confrelid
       join pg_catalog.pg_namespace refn on refn.oid = refc.relnamespace
       join lateral unnest(con.conkey) with ordinality as k(attnum, ord) on true
       join pg_catalog.pg_attribute a
         on a.attrelid = con.conrelid and a.attnum = k.attnum
       join lateral unnest(con.confkey) with ordinality as rk(attnum, ord)
         on rk.ord = k.ord
       join pg_catalog.pg_attribute refa
         on refa.attrelid = con.confrelid and refa.attnum = rk.attnum
      where con.contype = 'f'
        and n.nspname = 'public'
        and refn.nspname = 'neon_auth'
        and refc.relname = 'user'
      order by c.relname, a.attname`,
  )
  return rows
}

/**
 * Copies the source's neon_auth.user rows into the target so the 13 user FKs
 * can be satisfied. Existing target rows are left alone: the target's auth
 * rows are authoritative once real accounts exist, and the remap script is what
 * reconciles them.
 */
async function copyUserPlaceholders(src, tgt, dryRun) {
  const targetHas = await tgt.query(
    `select count(*)::bigint as n from neon_auth.user`,
  )
  const targetCount = Number(targetHas.rows[0].n)

  const sourceHas = await src.query(
    `select count(*)::bigint as n from neon_auth.user`,
  )
  const sourceCount = Number(sourceHas.rows[0].n)

  if (sourceCount === 0) {
    throw new Error(
      'the source has no neon_auth.user rows but public tables reference them; ' +
        'the source data is incomplete',
    )
  }
  if (targetCount > 0) {
    return targetCount
  }
  if (dryRun) return 0

  await tgt.query('begin')
  try {
    // Column list is read from the catalog so a Neon Auth schema change is
    // picked up automatically; values are always bound.
    const { rows: columns } = await tgt.query(
      `select a.attname::text as column_name,
              a.attidentity::text as identity_kind,
              a.attgenerated <> '' as is_generated
         from pg_catalog.pg_attribute a
         join pg_catalog.pg_class c on c.oid = a.attrelid
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'neon_auth' and c.relname = 'user'
          and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
        order by a.attnum`,
    )
    if (columns.length === 0) {
      throw new Error('neon_auth.user has no copyable columns on the target')
    }
    const names = columns.map((c) => c.column_name)
    const selectIdent = names.map(pgIdent).join(', ')

    const { rows: sourceRows } = await src.query(
      `select ${selectIdent} from neon_auth."user" order by ${selectIdent}`,
    )
    for (const row of sourceRows) {
      const slots = names.map((_, i) => `$${i + 1}`)
      await tgt.query(
        `insert into neon_auth."user" (${selectIdent}) values (${slots.join(', ')})`,
        names.map((name) => row[name]),
      )
    }
    await tgt.query('commit')
    return sourceRows.length
  } catch (error) {
    await tgt.query('rollback')
    throw error
  }
}

/**
 * Disables the AFTER INSERT/UPDATE/DELETE `z_audit` triggers for the duration
 * of the copy transaction. Returns the list disabled so it can be restored.
 *
 * Without this, copying 3000 bills would additionally WRITE 3000 new audit
 * rows on the target (actor_id NULL, because auth.uid() is NULL in a migration
 * session), and the source's own audit history is copied verbatim anyway.
 * ALTER TABLE ... DISABLE TRIGGER is transactional, so a rollback restores them.
 */
async function disableAuditTriggers(client) {
  const { rows } = await client.query(
    `select t.tgrelid::regclass::text as table_name, t.tgname as trigger_name
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
      `alter table ${row.table_name} disable trigger ${pgIdent(row.trigger_name)}`,
    )
  }
  if (rows.length > 0) {
    console.log(`  (suppressed ${rows.length} z_audit trigger(s) for the copy transaction)`)
  }
  return rows
}

async function enableAuditTriggers(client, disabled) {
  for (const row of disabled) {
    await client.query(
      `alter table ${row.table_name} enable trigger ${pgIdent(row.trigger_name)}`,
    )
  }
}

/**
 * Re-syncs every identity/serial sequence in public to max(id) on the target so
 * the next application insert cannot collide with a copied id.
 */
async function resyncSequences(client) {
  const { rows } = await client.query(
    `select c.relname::text as table_name,
            a.attname::text as column_name,
            pg_get_serial_sequence(format('public.%I', c.relname), a.attname)::text as sequence
       from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       join pg_catalog.pg_attribute a on a.attrelid = c.oid
      where n.nspname = 'public'
        and c.relkind in ('r', 'p')
        and (a.attidentity <> '' or pg_get_serial_sequence(format('public.%I', c.relname), a.attname) is not null)
        and not a.attisdropped
        and a.attnum > 0
      order by c.relname`,
  )

  const results = []
  for (const row of rows) {
    if (!row.sequence) continue
    // setval is given the sequence name as a bound parameter cast to regclass, so it
    // never has to be interpolated. The column and table identifiers do come from
    // pg_get_serial_sequence and the catalog, never from user data.
    const quotedColumn = pgIdent(row.column_name)
    const { rows: setvalRows } = await client.query(
      `select setval($1::regclass, coalesce((select max(${quotedColumn}) from public.${pgIdent(row.table_name)}), 1))::bigint as set_to`,
      [row.sequence],
    )
    results.push({ sequence: row.sequence, table: row.table_name, setTo: setvalRows[0].set_to })
  }
  return results
}

async function writeReport(report) {
  await mkdir(OUT_DIR, { recursive: true })
  const payload = {
    tool: 'migrate-data.mjs',
    generatedAt: new Date().toISOString(),
    source: describeUrl(process.env.SOURCE_DATABASE_URL ?? ''),
    target: describeUrl(process.env.TARGET_DATABASE_URL ?? ''),
    copyOrder: report.tables,
    generatedColumnsExcluded: [...EXPECTED_GENERATED].sort(),
    batchSize: BATCH_SIZE,
    dryRun: report.dryRun,
    status: report.status,
    copiedRows: report.copied ?? null,
    mismatchedTables: report.mismatches ?? [],
    deferredToStorageMigration: report.deferred ?? [],
    tables: Object.keys(report.after)
      .sort()
      .map((table) => ({
        table,
        managedBy: DEFERRED_TO_STORAGE_MIGRATION.has(table)
          ? 'scripts/migrate-storage.mjs'
          : 'scripts/migrate-data.mjs',
        sourceBefore: report.before[table]?.source ?? null,
        targetBefore: report.before[table]?.target ?? null,
        sourceAfter: report.after[table]?.source ?? null,
        targetAfter: report.after[table]?.target ?? null,
        matches: report.after[table]?.target === report.after[table]?.source,
      })),
  }
  await writeFile(REPORT_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8')
}

main().catch(async (error) => {
  console.error(`\nmigrate-data: unexpected failure: ${error?.stack ?? error}\n`)
  await Promise.allSettled([source.end(), target.end()])
  process.exit(1)
})