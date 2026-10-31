/**
 * One-off: route the remaining `cause instanceof Error ? ... : String(...)`
 * sites through describeError.
 *
 *     node scripts/use-describe-error.mjs
 *
 * Every one of these printed "[object Object]" when a rejection was a plain
 * object. Kept as a script so the change is reviewable as a single diff rather
 * than twenty scattered edits, and so it can be re-run if the pattern reappears.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** [file, old, new] - the fallback text is preserved in every case. */
const edits = [
  ['src/components/DocumentCapture.tsx',
    `onError(cause instanceof Error ? cause.message : 'That photo could not be prepared.')`,
    `onError(describeError(cause, 'That photo could not be prepared.'))`],
  ['src/pages/DcDashboard.tsx',
    `return cause instanceof Error ? cause.message : String(cause ?? 'Dashboard data is unavailable.')`,
    `return describeError(cause, 'Dashboard data is unavailable.')`],
  ['src/pages/DcList.tsx',
    `if (active) setError(cause instanceof Error ? cause.message : 'Could not load challans.')`,
    `if (active) setError(describeError(cause, 'Could not load challans.'))`],
  ['src/pages/DcLedger.tsx',
    `if (active) setError(cause instanceof Error ? cause.message : 'Could not load the ledger.')`,
    `if (active) setError(describeError(cause, 'Could not load the ledger.'))`],
  ['src/pages/DcReports.tsx',
    `if (active) setError(cause instanceof Error ? cause.message : 'Could not build this report.')`,
    `if (active) setError(describeError(cause, 'Could not build this report.'))`],
  ['src/pages/DcReports.tsx',
    `setError(cause instanceof Error ? cause.message : 'Could not load DC settings.')`,
    `setError(describeError(cause, 'Could not load DC settings.'))`],
  ['src/pages/DcReports.tsx',
    `setError(cause instanceof Error ? cause.message : 'Could not save the numbering settings.')`,
    `setError(describeError(cause, 'Could not save the numbering settings.'))`],
  ['src/pages/DcReports.tsx',
    `setError(cause instanceof Error ? cause.message : 'Could not add the option.')`,
    `setError(describeError(cause, 'Could not add the option.'))`],
  ['src/pages/DcOperations.tsx',
    `setError(cause instanceof Error ? cause.message : 'Could not load rejections.')`,
    `setError(describeError(cause, 'Could not load rejections.'))`],
  ['src/pages/DcOperations.tsx',
    `.catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Could not load.') })`,
    `.catch(cause => { if (active) setError(describeError(cause, 'Could not load.')) })`],
  ['src/pages/DcOperations.tsx',
    `.catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Could not load movements.') })`,
    `.catch(cause => { if (active) setError(describeError(cause, 'Could not load movements.')) })`],
  ['src/pages/DcOperations.tsx',
    '`${[\'material at vendors\', \'customer delivery\', \'pending inspection\', \'material rejections\'][index]}: ${String(step.reason?.message ?? step.reason)}`',
    '`${[\'material at vendors\', \'customer delivery\', \'pending inspection\', \'material rejections\'][index]}: ${describeError(step.reason, \'request failed\')}`'],
  ['src/pages/Scan.tsx',
    `setError(cause instanceof Error ? cause.message : 'That file could not be prepared.')`,
    `setError(describeError(cause, 'That file could not be prepared.'))`],
  ['src/lib/dc-api.ts',
    `  const message = cause instanceof Error ? cause.message : String(cause ?? 'unknown error')\n  return message.split('\\n')[0]?.slice(0, 160) ?? 'unknown error'`,
    `  return describeError(cause, 'unknown error').split('\\n')[0]?.slice(0, 160) ?? 'unknown error'`],
  ['src/lib/membership.ts',
    `  const message = error instanceof Error ? error.message : String(error ?? '')`,
    `  const message = describeError(error, '')`],
]

let applied = 0
const touched = new Set()

for (const [file, oldText, newText] of edits) {
  const path = join(root, file)
  const before = readFileSync(path, 'utf8')
  if (!before.includes(oldText)) {
    console.log(`  SKIP (no match) ${file}: ${oldText.slice(0, 60)}...`)
    continue
  }
  writeFileSync(path, before.split(oldText).join(newText), 'utf8')
  applied += 1
  touched.add(file)
  console.log(`  ok ${file}`)
}

console.log(`\n${applied}/${edits.length} replacements across ${touched.size} files.`)
console.log('Add `describeError` to the format import in each of those files next.')
console.log(touched.size ? [...touched].join('\n') : '')