import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..')
const migrationDir = join(root, 'db', 'migrations')

/**
 * Regression guards for two bugs found while fixing the multi-line machining panel:
 *
 * 1. Every migration that opens a standalone `begin;` must also close with a
 *    standalone `commit;`. `0043_dc_machining_batch.sql` opened `begin;` with no
 *    `commit;`, so the apply script recorded it as applied while rolling every
 *    change back — the function never landed and the frontend kept getting PGRST202.
 * 2. Every RPC the frontend calls via `call('<name>')` must be created by
 *    `create or replace function public.<name>(` in some migration file. A form
 *    can call a function that no migration defines, and PostgREST answers
 *    "not found in the schema cache".
 */

describe('migration transaction hygiene', () => {
  const files = readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort()

  for (const file of files) {
    it(`${file} commits every transaction it opens`, () => {
      const sql = readFileSync(join(migrationDir, file), 'utf8')
      const lines = sql.split('\n')
      // Standalone transaction control statements: line-anchored, nothing else
      // on the line (a trailing comment is fine). This matches the neutralise
      // logic in scripts/validate-migrations.mjs.
      const transactionControl = lines.filter((line) =>
        /^\s*(begin|commit|rollback|start\s+transaction|end\s+transaction)\s*;\s*(--.*)?$/i.test(line),
      )
      const opens = transactionControl.filter((line) => /^\s*begin\s*;/i.test(line)).length
      const commits = transactionControl.filter((line) => /^\s*commit\s*;/i.test(line)).length
      expect(opens).toBe(commits)
    })
  }
})

describe('frontend RPC coverage by migrations', () => {
  const dcApi = readFileSync(join(root, 'src', 'lib', 'dc-api.ts'), 'utf8')
  const called = new Set<string>()
  for (const match of dcApi.matchAll(/(?:call|rows)<.*?>\(\s*'([a-z_]+)'/g)) {
    if (match[1]) called.add(match[1])
  }

  const migrations = readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort()
  const migrationSql = migrations.map((name) => readFileSync(join(migrationDir, name), 'utf8'))

  for (const name of [...called].sort()) {
    it(`RPC ${name}() is created by a migration`, () => {
      // Public schema functions only: the `call()` wrapper always targets public.
      // App-private functions (dc_available_balance, etc.) are called by name,
      // not via `call()`, and are not covered here.
      const pattern = new RegExp(
        'create\\s+or\\s+replace\\s+function\\s+public\\s*\\.\\s*' + name + '\\s*\\(',
        'i',
      )
      const defined = migrationSql.some((sql) => pattern.test(sql))
      expect(defined).toBe(true)
    })
  }
})
