/**
 * One-off: add `describeError` to the `../lib/format` import in the files that
 * now use it.
 *
 *     node scripts/fix-format-imports.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const files = [
  'src/components/DocumentCapture.tsx',
  'src/pages/DcDashboard.tsx',
  'src/pages/DcList.tsx',
  'src/pages/DcLedger.tsx',
  'src/pages/DcReports.tsx',
  'src/pages/DcOperations.tsx',
  'src/pages/Scan.tsx',
  'src/lib/dc-api.ts',
  'src/lib/membership.ts',
]

for (const file of files) {
  const path = join(root, file)
  let text = readFileSync(path, 'utf8')
  if (!text.includes('describeError(')) { console.log(`  skip ${file} (does not use it)`); continue }
  if (/import \{[^}]*\bdescribeError\b[^}]*\} from '(?:\.\.\/lib|\.\/)format'/.test(text)) {
    console.log(`  ok   ${file} (already imported)`); continue
  }

  // Add to an existing named import from format, wherever it sits in the file.
  const pattern = /import \{([^}]*)\} from '((?:\.\.\/lib|\.\/)format)'/
  const match = text.match(pattern)
  if (!match) { console.log(`  MISS ${file} (no format import found)`); continue }

  const names = match[1].split(',').map(s => s.trim()).filter(Boolean)
  names.push('describeError')
  // Keep a stable, readable order rather than appending randomly.
  names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
  text = text.replace(pattern, `import { ${names.join(', ')} } from '${match[2]}'`)
  writeFileSync(path, text, 'utf8')
  console.log(`  ok   ${file}`)
}