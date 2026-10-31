/**
 * Prints which database each .env variable points at, with credentials removed.
 *
 *     node scripts/which-db.mjs
 *
 * Several scripts accept more than one connection variable. When two of them
 * point at different branches, it matters a great deal which one wins - so this
 * says so explicitly rather than leaving it to be inferred.
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const envText = readFileSync(join(root, '.env'), 'utf8')

const variables = ['DATABASE_URL_TEST', 'DATABASE_URL_UNPOOLED', 'DATABASE_URL', 'DIRECT_DATABASE_URL']

for (const name of variables) {
  const match = envText.match(new RegExp(`^${name}\\s*=\\s*"?([^"\\r\\n]+)"?`, 'm'))
  if (!match) { console.log(`${name.padEnd(22)} (not set)`); continue }
  try {
    const url = new URL(match[1].trim())
    console.log(`${name.padEnd(22)} ${url.hostname}  db=${url.pathname.replace(/^\//, '')}`)
  } catch {
    console.log(`${name.padEnd(22)} (unparseable)`)
  }
}

console.log('\nPreference order used by the scripts:')
console.log('  migrate:check, db:check, db:audit -> DATABASE_URL_TEST, else DATABASE_URL_UNPOOLED')
console.log('  apply-migrations.mjs               -> DATABASE_URL_TEST, else DATABASE_URL_UNPOOLED')
console.log('\nIf DATABASE_URL_TEST is set, the checkers target that branch, NOT production.')