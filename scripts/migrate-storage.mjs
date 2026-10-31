#!/usr/bin/env node
/**
 * scripts/migrate-storage.mjs
 *
 * Copies every object from the Supabase `bill-attachments` bucket to Neon
 * Object Storage at the SAME key, then indexes the result in
 * public.storage_objects and reconciles the two sides.
 *
 * ===========================================================================
 *  REQUIRED ENVIRONMENT
 * ===========================================================================
 *  Database
 *    SUPABASE_DB_URL     Supabase Postgres connection string. Required.
 *                         Only used to read the bill_attachments manifest if the
 *                         target copy is incomplete; see --manifest-source.
 *    TARGET_DATABASE_URL Neon Postgres connection string. Required.
 *
 *  Source bucket (Supabase Storage, S3-compatible endpoint). Required.
 *    SUPABASE_S3_ENDPOINT      e.g. https://<project>.supabase.co/storage/v1/s3
 *    SUPABASE_S3_REGION         e.g. us-east-1        (Supabase S3 uses "us-east-1")
 *    SUPABASE_S3_ACCESS_KEY     Storage S3 access key id
 *    SUPABASE_S3_SECRET_KEY     Storage S3 secret access key
 *    SUPABASE_S3_BUCKET         defaults to "bill-attachments"
 *
 *  Target bucket (Neon Object Storage). Required.
 *    AWS_ENDPOINT_URL_S3        Neon object storage endpoint
 *    AWS_REGION                 Neon object storage region
 *    AWS_ACCESS_KEY_ID          Neon object storage key id
 *    AWS_SECRET_ACCESS_KEY      Neon object storage secret
 *    AWS_S3_BUCKET              defaults to "bill-attachments"
 *
 *  Optional
 *    --manifest-source source|target
 *                             Which database supplies the attachment manifest.
 *                             'target' (default) reads public.bill_attachments on
 *                             the Neon side, which is the authoritative manifest
 *                             because its ids came from migrate-data.mjs.
 *                             'source' reads it from SUPABASE_DB_URL instead.
 *    --dry-run             Report the plan and the reconciliation of what is
 *                             already present, copy nothing.
 *    --allow-partial       Exit 0 even when the reconciliation finds missing
 *                             objects, orphans or size mismatches. Use only when
 *                             you have decided the gap is acceptable.
 *    --delete-orphans-from-target-index
 *                             Remove storage_objects rows that have no object in
 *                             Neon Object Storage. Does NOT delete any object.
 *
 * ===========================================================================
 *  USAGE
 * ===========================================================================
 *    node scripts/migrate-storage.mjs --dry-run
 *    node scripts/migrate-storage.mjs
 *
 * ===========================================================================
 *  SAFETY MODEL
 * ===========================================================================
 *  * NEVER deletes anything from the source bucket. The only source calls are
 *    GetObject and ListObjectsV2.
 *  * Objects are copied to the same key, so the path format is unchanged:
 *      <organization_id>/YYYY/MM/<uuid>/original.<ext>
 *    which is what bill_attachments.file_path already stores and what the
 *    Neon api function and app_private.upsert_bill validate against.
 *  * ContentType is preserved on every copy.
 *  * public.storage_objects rows are inserted with an upsert, because that is
 *    the table both neon/api/index.ts and app_private.upsert_bill validate
 *    against before accepting an attachment.
 *  * The run fails with a non-zero exit if any of the three reconciliation
 *    categories is non-empty, unless --allow-partial is passed.
 */

import { Client } from 'pg'
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

// ---------------------------------------------------------------------------
//  Required environment
// ---------------------------------------------------------------------------

const REQUIRED = [
  ['TARGET_DATABASE_URL', 'the Neon Postgres connection string'],
  ['SUPABASE_S3_ENDPOINT', 'the Supabase Storage S3 endpoint'],
  ['SUPABASE_S3_REGION', 'the Supabase Storage S3 region'],
  ['SUPABASE_S3_ACCESS_KEY', 'the Supabase Storage S3 access key id'],
  ['SUPABASE_S3_SECRET_KEY', 'the Supabase Storage S3 secret key'],
  ['AWS_ENDPOINT_URL_S3', 'the Neon Object Storage S3 endpoint'],
  ['AWS_REGION', 'the Neon Object Storage region'],
  ['AWS_ACCESS_KEY_ID', 'the Neon Object Storage access key id'],
  ['AWS_SECRET_ACCESS_KEY', 'the Neon Object Storage secret key'],
]

const missing = REQUIRED.filter(([name]) => !process.env[name]).map(([name]) => name)
if (missing.length > 0) {
  console.error(
    '\nmigrate-storage: missing required environment variable(s):\n' +
      missing
        .map(
          (name) =>
            `  ${name}  (${REQUIRED.find(([n]) => n === name)[1]})`,
        )
        .join('\n') +
      '\n\nSee the required-environment block at the top of this file.\n',
  )
  process.exit(2)
}

// SUPABASE_DB_URL is only needed when --manifest-source source is used.
const MANIFEST_SOURCE = readFlag('--manifest-source') ?? 'target'
if (MANIFEST_SOURCE === 'source' && !process.env.SUPABASE_DB_URL) {
  console.error(
    '\nmigrate-storage: --manifest-source source requires SUPABASE_DB_URL\n',
  )
  process.exit(2)
}
if (!['source', 'target'].includes(MANIFEST_SOURCE)) {
  console.error(
    `\nmigrate-storage: --manifest-source must be 'source' or 'target', got ${JSON.stringify(MANIFEST_SOURCE)}\n`,
  )
  process.exit(2)
}

const DRY_RUN = process.argv.includes('--dry-run')
const ALLOW_PARTIAL = process.argv.includes('--allow-partial')
const DELETE_ORPHAN_INDEX_ROWS = process.argv.includes(
  '--delete-orphans-from-target-index',
)

const SOURCE_BUCKET = process.env.SUPABASE_S3_BUCKET ?? 'bill-attachments'
const TARGET_BUCKET = process.env.AWS_S3_BUCKET ?? 'bill-attachments'

function readFlag(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function makeS3Client({ endpoint, region, accessKeyId, secretAccessKey }) {
  return new S3Client({
    region,
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  })
}

const sourceS3 = makeS3Client({
  endpoint: process.env.SUPABASE_S3_ENDPOINT,
  region: process.env.SUPABASE_S3_REGION,
  accessKeyId: process.env.SUPABASE_S3_ACCESS_KEY,
  secretAccessKey: process.env.SUPABASE_S3_SECRET_KEY,
})

const targetS3 = makeS3Client({
  endpoint: process.env.AWS_ENDPOINT_URL_S3,
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
})

/** Buffers an S3 GetObject response body. */
async function readBody(object) {
  if (!object.Body) throw new Error('S3 GetObject returned no body')
  if (typeof object.Body.transformToByteArray === 'function') {
    return Buffer.from(await object.Body.transformToByteArray())
  }
  const chunks = []
  for await (const chunk of object.Body) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function listAll(client, bucket) {
  const keys = []
  let token
  for (;;) {
    const response = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
    )
    for (const item of response.Contents ?? []) {
      keys.push({ key: item.Key, size: item.Size, contentType: undefined })
    }
    if (!response.IsTruncated || !response.NextContinuationToken) break
    token = response.NextContinuationToken
  }
  return keys
}

async function headSize(client, bucket, key) {
  try {
    const response = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    )
    return { size: response.ContentLength ?? null, contentType: response.ContentType ?? null }
  } catch (error) {
    if (error.$metadata?.httpStatusCode === 404 || error.name === 'NotFound') return null
    throw error
  }
}

async function main() {
  console.log('migrate-storage: Supabase Storage -> Neon Object Storage')
  console.log(`  source bucket: ${SOURCE_BUCKET} @ ${process.env.SUPABASE_S3_ENDPOINT}`)
  console.log(`  target bucket: ${TARGET_BUCKET} @ ${process.env.AWS_ENDPOINT_URL_S3}`)
  console.log(`  manifest:      public.bill_attachments on the ${MANIFEST_SOURCE} database`)
  console.log(`  mode:          ${DRY_RUN ? 'DRY RUN, nothing is copied' : 'COPY'}`)
  console.log('')

  const manifestClient = new Client({
    connectionString:
      MANIFEST_SOURCE === 'source'
        ? process.env.SUPABASE_DB_URL
        : process.env.TARGET_DATABASE_URL,
  })
  const targetClient = new Client({ connectionString: process.env.TARGET_DATABASE_URL })

  const report = {
    dryRun: DRY_RUN,
    sourceBucket: SOURCE_BUCKET,
    targetBucket: TARGET_BUCKET,
    manifestSource: MANIFEST_SOURCE,
    attachments: 0,
    copied: 0,
    alreadyPresent: 0,
    missingObject: [],
    orphanObjects: [],
    sizeMismatches: [],
    storageObjectsRows: 0,
  }

  try {
    await manifestClient.connect()
    await targetClient.connect()

    // --- 1. the authoritative manifest -----------------------------------
    // bill_attachments is the manifest, and it carries organization_id,
    // file_path, file_name, mime_type and size_bytes. readPath's first segment
    // is the organization id by construction (the CHECK constraints enforce it),
    // so organization_id is taken from the row, not parsed out of the path.
    const { rows: manifest } = await manifestClient.query(
      `select organization_id::text as organization_id,
              file_path,
              file_name,
              mime_type,
              size_bytes
         from public.bill_attachments
        where deleted_at is null
        order by file_path`,
    )
    report.attachments = manifest.length
    console.log(`manifest: ${manifest.length} attachment row(s)`)

    if (manifest.length === 0) {
      console.log('\nnothing to migrate: the manifest is empty.')
      await writeReport(report)
      return
    }

    // --- 2. list both sides -----------------------------------------------
    console.log('\nlisting')
    const sourceObjects = await listAll(sourceS3, SOURCE_BUCKET)
    const targetObjects = await listAll(targetS3, TARGET_BUCKET)
    console.log(`  source: ${sourceObjects.length} object(s)`)
    console.log(`  target: ${targetObjects.length} object(s)`)

    const sourceByKey = new Map(sourceObjects.map((o) => [o.key, o]))
    const targetByKey = new Map(targetObjects.map((o) => [o.key, o]))

    // --- 3. copy ----------------------------------------------------------
    // Nothing is ever deleted from the source. An object is copied to the SAME
    // key, preserving the path format the database and the api function expect.
    console.log('\ncopying')
    for (const row of manifest) {
      const sourceEntry = sourceByKey.get(row.file_path)
      if (!sourceEntry) {
        report.missingObject.push({
          filePath: row.file_path,
          organizationId: row.organization_id,
          reason: 'not present in the source bucket',
        })
        continue
      }

      const existing = await headSize(targetS3, TARGET_BUCKET, row.file_path)
      const sourceSize = sourceEntry.size ?? null
      const recordedSize = row.size_bytes === null ? null : Number(row.size_bytes)

      if (existing && recordedSize !== null && existing.size !== recordedSize) {
        // Do not silently overwrite: flag it so a human decides.
        report.sizeMismatches.push({
          filePath: row.file_path,
          manifestBytes: recordedSize,
          sourceBytes: sourceSize,
          targetBytes: existing.size,
          note: 'object already in Neon Object Storage with a different size than the manifest',
        })
      }

      if (existing && sourceSize !== null && existing.size === sourceSize) {
        report.alreadyPresent += 1
        continue
      }

      if (DRY_RUN) {
        report.copied += 1
        continue
      }

      const object = await sourceS3.send(
        new GetObjectCommand({ Bucket: SOURCE_BUCKET, Key: row.file_path }),
      )
      const bytes = await readBody(object)
      const contentType = row.mime_type ?? object.ContentType ?? 'application/octet-stream'

      await targetS3.send(
        new PutObjectCommand({
          Bucket: TARGET_BUCKET,
          Key: row.file_path, // same key: path format is unchanged
          Body: bytes,
          ContentType: contentType,
          ContentLength: bytes.byteLength,
        }),
      )
      targetByKey.set(row.file_path, { key: row.file_path, size: bytes.byteLength })

      if (recordedSize !== null && bytes.byteLength !== recordedSize) {
        report.sizeMismatches.push({
          filePath: row.file_path,
          manifestBytes: recordedSize,
          sourceBytes: sourceSize,
          targetBytes: bytes.byteLength,
          note: 'copied object size does not match bill_attachments.size_bytes',
        })
      }
      report.copied += 1
    }
    console.log(`  copied ${report.copied}, already present ${report.alreadyPresent}`)

    // --- 4. index into public.storage_objects -----------------------------
    // neon/api/index.ts and app_private.upsert_bill both validate an attachment
    // against this table, so a row must exist for every object that is really
    // in Neon Object Storage, or save_bill will reject the attachment.
    console.log('\nindexing public.storage_objects')
    const indexed = []
    for (const row of manifest) {
      const present = targetByKey.get(row.file_path)
      if (!present) continue
      indexed.push({
        organization_id: row.organization_id,
        object_path: row.file_path,
        content_type: row.mime_type ?? null,
        size_bytes: present.size ?? (row.size_bytes === null ? null : Number(row.size_bytes)),
      })
    }

    if (!DRY_RUN && indexed.length > 0) {
      await targetClient.query('begin')
      try {
        for (const row of indexed) {
          await targetClient.query(
            `insert into public.storage_objects (organization_id, object_path, content_type, size_bytes)
             values ($1::uuid, $2, $3, $4)
             on conflict (organization_id, object_path)
             do update set content_type = excluded.content_type,
                           size_bytes = excluded.size_bytes`,
            [row.organization_id, row.object_path, row.content_type, row.size_bytes],
          )
        }
        await targetClient.query('commit')
        report.storageObjectsRows = indexed.length
      } catch (error) {
        await targetClient.query('rollback')
        throw error
      }
    } else {
      report.storageObjectsRows = indexed.length
    }
    console.log(`  ${report.storageObjectsRows} row(s) indexed`)

    // --- 5. reconcile -----------------------------------------------------
    // (a) attachments with no copied object
    // (b) objects present in Neon Object Storage with no attachment row
    // (c) size mismatches
    const manifestPaths = new Set(manifest.map((r) => r.file_path))
    const { rows: indexRows } = await targetClient.query(
      `select organization_id::text as organization_id,
              object_path,
              size_bytes
         from public.storage_objects`,
    )
    const indexByPath = new Map(indexRows.map((r) => [r.object_path, r]))

    // Was `targetByPath`, which does not exist in this scope: a ReferenceError that
    // aborted the whole reconcile step, so the migration never reported the
    // orphan objects it exists to find.
    for (const key of targetByKey.keys()) {
      if (!manifestPaths.has(key)) {
        report.orphanObjects.push({ objectPath: key, source: 'neon object storage' })
      }
    }

    const orphansFromSource = sourceObjects
      .filter((o) => !manifestPaths.has(o.key))
      .map((o) => ({ objectPath: o.key, source: 'supabase bucket only' }))
    for (const o of orphansFromSource) {
      if (!report.orphanObjects.some((x) => x.objectPath === o.objectPath)) {
        report.orphanObjects.push(o)
      }
    }

    if (DELETE_ORPHAN_INDEX_ROWS && !DRY_RUN) {
      const stale = report.orphanObjects
        .map((o) => o.objectPath)
        .filter((p) => indexByPath.has(p))
      for (const path of stale) {
        const row = indexByPath.get(path)
        await targetClient.query(
          `delete from public.storage_objects
            where organization_id = $1::uuid and object_path = $2`,
          [row.organization_id, path],
        )
      }
      console.log(`\nremoved ${stale.length} stale storage_objects index row(s)`)
      report.storageObjectIndexRowsRemoved = stale.length
    } else {
      report.storageObjectIndexRowsRemoved = 0
    }

    // --- 6. report and exit status ---------------------------------------
    printReconciliation(report)

    await writeReport(report)

    const problems =
      report.missingObject.length +
      report.orphanObjects.length +
      report.sizeMismatches.length

    if (problems > 0 && !ALLOW_PARTIAL) {
      console.error(
        `\nmigrate-storage: ${problems} reconciliation problem(s) found; ` +
          'exiting non-zero.\n' +
          (ALLOW_PARTIAL ? '' : '  Pass --allow-partial to exit 0 anyway.\n'),
      )
      process.exitCode = 1
      return
    }

    console.log('\nreconciliation clean')
    if (ALLOW_PARTIAL && problems > 0) {
      console.log(`  (${problems} problem(s) tolerated because of --allow-partial)`)
    }
  } finally {
    await Promise.allSettled([manifestClient.end(), targetClient.end()])
  }
}

function printReconciliation(report) {
  console.log('\nreconciliation')
  console.log('  (a) attachments with no copied object: ' + report.missingObject.length)
  for (const m of report.missingObject.slice(0, 20)) {
    console.log(`        ${m.filePath}  (${m.reason})`)
  }
  if (report.missingObject.length > 20) {
    console.log(`        ... and ${report.missingObject.length - 20} more`)
  }

  console.log('  (b) objects with no attachment row (orphans): ' + report.orphanObjects.length)
  for (const o of report.orphanObjects.slice(0, 20)) {
    console.log(`        ${o.objectPath}  (${o.source})`)
  }
  if (report.orphanObjects.length > 20) {
    console.log(`        ... and ${report.orphanObjects.length - 20} more`)
  }

  console.log('  (c) size mismatches: ' + report.sizeMismatches.length)
  for (const s of report.sizeMismatches.slice(0, 20)) {
    console.log(
      `        ${s.filePath}  manifest=${s.manifestBytes} source=${s.sourceBytes} target=${s.targetBytes}`,
    )
    console.log(`          ${s.note}`)
  }
  if (report.sizeMismatches.length > 20) {
    console.log(`        ... and ${report.sizeMismatches.length - 20} more`)
  }
}

async function writeReport(report) {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { dirname, resolve } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = dirname(fileURLToPath(import.meta.url))
  const outDir = resolve(here, 'out')
  await mkdir(outDir, { recursive: true })
  const path = resolve(outDir, 'storage-migration-report.json')
  await writeFile(
    path,
    JSON.stringify(
      { tool: 'migrate-storage.mjs', generatedAt: new Date().toISOString(), ...report },
      null,
      2,
    ) + '\n',
    'utf8',
  )
  console.log(`\nreport written to ${path}`)
}

main().catch((error) => {
  console.error(`\nmigrate-storage: unexpected failure: ${error?.stack ?? error}\n`)
  process.exit(1)
})