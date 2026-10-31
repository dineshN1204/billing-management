import { describe, expect, it } from 'vitest'
import { buildCsv, csvCell, neutralizeFormula } from '../lib/csv'
import { firstError, isOk, settle, settleAll } from '../lib/async'
import { challanPath, landingTarget } from '../lib/navigation'
import { inspectionStatus, parseQty } from '../lib/dc-quantities'
import { money } from '../lib/format'

describe('CSV export safety', () => {
  it('neutralises spreadsheet formula injection', () => {
    // A customer name is attacker-influenced data in this application: it arrives
    // from OCR of paper bills and from phone calls. Excel, LibreOffice and Google
    // Sheets all execute a cell that begins with these characters.
    for (const hostile of [
      '=cmd|\'/c calc\'!A1',
      '+1+1',
      '-2+3+cmd|\'/c calc\'!A0',
      '@SUM(A1:A2)',
      '\t=1+1',
      '\r=1+1',
    ]) {
      expect(neutralizeFormula(hostile).startsWith("'")).toBe(true)
    }
  })

  it('leaves ordinary business values untouched', () => {
    for (const safe of ['Kallazhagar Industries', '33ABCDE1234F1Z5', '1000', 'Acme (P) Ltd', '12/04/2026', 'KI/IN/2026-27/0001']) {
      expect(neutralizeFormula(safe)).toBe(safe)
    }
  })

  it('escapes embedded quotes so a name cannot break the column layout', () => {
    expect(csvCell('S. Rajesh "Raju" & Sons')).toBe('"S. Rajesh ""Raju"" & Sons"')
  })

  it('renders an empty cell rather than the words null or undefined', () => {
    expect(csvCell(null)).toBe('""')
    expect(csvCell(undefined)).toBe('""')
    expect(csvCell(0)).toBe('"0"')
  })

  it('builds a document with one row per record and CRLF line endings', () => {
    const csv = buildCsv(['a', 'b'], [['1', '2'], ['3', '4']])
    expect(csv).toBe('"a","b"\r\n"1","2"\r\n"3","4"')
  })

  it('keeps a hostile value inside its own cell', () => {
    // Without the guard the comma and quotes inside the payload would shift every
    // following column, corrupting a whole export from one bad customer name.
    const csv = buildCsv(['name', 'amount'], [['=1,2",3', '100']])
    expect(csv).toBe('"name","amount"\r\n"\'=1,2"",3","100"')
  })
})

describe('async helpers never reject', () => {
  it('reports a success as a value', async () => {
    const result = await settle(() => Promise.resolve(42))
    expect(result.ok).toBe(true)
    if (isOk(result)) expect(result.value).toBe(42)
  })

  it('turns a rejection into a value instead of propagating it', async () => {
    // This is the whole point. A bare `Promise.all(...).then(...)` skips its
    // callback on rejection, so `setLoading(false)` never runs and the screen
    // spins forever - which is what made "refresh the page" the only known fix.
    const result = await settle(() => Promise.reject(new Error('Failed to fetch')))
    expect(result.ok).toBe(false)
    if (!result.ok) expect((result.error as Error).message).toBe('Failed to fetch')
  })

  it('runs every step even when an earlier one fails, and keeps them ordered', async () => {
    const results = await settleAll([
      () => Promise.reject(new Error('first failed')),
      () => Promise.resolve('second ok'),
      () => Promise.resolve('third ok'),
    ])
    expect(results[0]?.ok).toBe(false)
    expect(results[1]?.ok).toBe(true)
    expect(results[2]?.ok).toBe(true)
  })

  it('surfaces the first failure so a page can report which query broke', async () => {
    const results = await settleAll([
      () => Promise.resolve('ok'),
      () => Promise.reject(new Error('the real cause')),
    ])
    const cause = firstError(results)
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toBe('the real cause')
  })

  it('reports no failure when everything succeeded', async () => {
    const results = await settleAll([() => Promise.resolve(1), () => Promise.resolve(2)])
    expect(firstError(results)).toBeNull()
  })
})

describe('challan routing', () => {
  it('routes each document type to the screen that is actually mounted', () => {
    // Each type is a separate route in main.tsx. Hard-coding /dc/inward sent an
    // outward challan to the wrong detail page.
    expect(challanPath('abc', 'inward')).toBe('/dc/inward/abc')
    expect(challanPath('abc', 'outward_customer')).toBe('/dc/outward/abc')
    expect(challanPath('abc', 'material_return')).toBe('/dc/inward/abc')
  })
})

describe('post-sign-in redirect', () => {
  it('keeps the route the user actually asked for', () => {
    expect(landingTarget({ from: '/dc/inward/123' })).toBe('/dc/inward/123')
  })

  it('refuses an off-site target', () => {
    // state.from reaches this from the URL, so an absolute or protocol-relative
    // value would be an open redirect straight out of the app.
    expect(landingTarget({ from: '//evil.example' })).toBe('/')
    expect(landingTarget({ from: 'https://evil.example' })).toBe('/')
    expect(landingTarget({ from: '/\\evil.example' })).toBe('/')
  })

  it('does not bounce back into the sign-in screens', () => {
    expect(landingTarget({ from: '/signin' })).toBe('/')
    expect(landingTarget({ from: '/onboarding' })).toBe('/')
  })
})

describe('quantity parsing', () => {
  it('clamps a negative entry to zero rather than sending it to the database', () => {
    // receiptSplit clamps before displaying, so passing the raw -5 through meant
    // the screen showed one number and the submission sent another, and the whole
    // receipt batch was refused.
    expect(parseQty('-5')).toBe(0)
    expect(parseQty('  -0.001 ')).toBe(0)
    expect(parseQty('')).toBe(0)
    expect(parseQty('abc')).toBe(0)
    expect(parseQty('12.345')).toBe(12.345)
  })
})

describe('inspection status', () => {
  it('reads cumulative quantities for the decided outcomes, like the SQL CASE', () => {
    // 0016 lines 1003-1009 test accepted/rejected against the *totals on the
    // line*, not against this inspection's increment.
    expect(inspectionStatus(0, 5, 0, 0, { accepted: 100, rejected: 0, rework: 0 })).toBe('partially_accepted')
    expect(inspectionStatus(5, 0, 0, 0, { accepted: 0, rejected: 20, rework: 0 })).toBe('partially_accepted')
    expect(inspectionStatus(0, 10, 0, 0)).toBe('rejected')
  })

  it('reads the increment for rework and pending', () => {
    expect(inspectionStatus(0, 0, 3, 0)).toBe('rework_required')
    expect(inspectionStatus(5, 0, 0, 2)).toBe('partially_inspected')
    expect(inspectionStatus(5, 0, 0, 0)).toBe('accepted')
  })
})

describe('currency formatting', () => {
  it('never renders NaN', () => {
    // OCR of a hand-written bill can yield "1,234.50" or "Rs. 500", and
    // Number() turns those into NaN, which Intl renders as the NaN symbol.
    const hostile = [Number('1,234.50'), Number('Rs. 500'), Number(''), Number('₹99')]
    for (const value of hostile) expect(money(value)).not.toMatch(/NaN/i)
  })
})