/**
 * One-off: replace a literal U+FEFF in a source file with its `\uFEFF` escape.
 *
 *     node scripts/fix-bom-literals.mjs <file>...
 *
 * ESLint's no-irregular-whitespace rule flags a BOM written as a literal
 * character even when it is exactly what the code means to strip. Writing it as
 * an escape keeps the behaviour and makes the character visible in a diff.
 */

import { readFileSync, writeFileSync } from 'node:fs'

const BOM = String.fromCharCode(0xfeff)
const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: node scripts/fix-bom-literals.mjs <file>...')
  process.exit(1)
}

let total = 0
for (const file of files) {
  const before = readFileSync(file, 'utf8')
  const count = before.split(BOM).length - 1
  if (count === 0) { console.log(`${file}: no literal BOM`); continue }
  const after = before.split(BOM).join('\\uFEFF')
  writeFileSync(file, after, 'utf8')
  total += count
  console.log(`${file}: replaced ${count}`)
}
console.log(`total: ${total}`)