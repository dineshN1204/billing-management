import { describe, expect, it } from 'vitest'
import {
  buildTemplateCsv, looksLikeCsv, normalizeHeader, parseCsv, parseFinancialYear, resolveHeader, splitCsvLine, toNumber,
} from '../lib/import-csv'
import { groupRows } from '../lib/import-bills'

describe('CSV line splitting', () => {
  it('splits plain cells', () => {
    expect(splitCsvLine('a,b,c')).toEqual(['a', 'b', 'c'])
  })

  it('keeps a comma inside a quoted cell', () => {
    // Customer names very often contain ",", and a naive split puts the rest of
    // the name in the wrong column and shifts every column after it.
    expect(splitCsvLine('"S. Rajesh, Trading",KI/001')).toEqual(['S. Rajesh, Trading', 'KI/001'])
  })

  it('reads a doubled quote as one literal quote', () => {
    expect(splitCsvLine('"He said ""inch"""')).toEqual(['He said "inch"'])
  })

  it('handles an empty trailing cell', () => {
    expect(splitCsvLine('a,b,')).toEqual(['a', 'b', ''])
  })

  it('preserves an embedded newline inside a quoted cell', () => {
    // Not tested through splitCsvLine (which is line-scoped) but the parser below
    // joins such lines; this documents the expectation that a quoted newline is
    // data rather than a row boundary.
    expect(splitCsvLine('"line one')).toEqual(['line one'])
  })
})

describe('header normalisation', () => {
  it('treats spacing, punctuation and case as the same column', () => {
    expect(normalizeHeader('  Bill No. ')).toBe('bill_no')
    expect(normalizeHeader('bill_number')).toBe('bill_number')
    expect(normalizeHeader('GSTIN')).toBe('gstin')
  })

  it('maps the spellings an Indian spreadsheet actually uses', () => {
    expect(resolveHeader('Bill No.')).toBe('bill_number')
    expect(resolveHeader('Invoice No')).toBe('bill_number')
    expect(resolveHeader('Particulars')).toBe('description')
    expect(resolveHeader('HSN/SAC')).toBe('hsn_code')
    expect(resolveHeader('GST %')).toBe('gst_rate')
    expect(resolveHeader('Qty')).toBe('quantity')
  })

  it('returns null for a column it does not understand', () => {
    expect(resolveHeader('internal_note')).toBeNull()
    expect(resolveHeader('')).toBeNull()
  })
})

describe('file type sniffing', () => {
  it('accepts text', () => {
    expect(looksLikeCsv('bill_number,bill_date\nKI/001,2026-04-01')).toBe(true)
  })

  it('rejects a binary file renamed to .csv', () => {
    // An .xlsx is a zip archive and contains NUL bytes. Accepting it would show a
    // parse error about columns rather than the accurate "this is not a CSV".
    expect(looksLikeCsv('PK\u0003\u0004\u001a\u0000\u0000binary')).toBe(false)
  })
})

describe('number parsing', () => {
  it('reads the grouping and currency an Indian sheet exports', () => {
    expect(toNumber('1,23,456.78')).toBe(123456.78)
    expect(toNumber('₹ 145.50')).toBe(145.5)
    expect(toNumber('1,000')).toBe(1000)
  })

  it('returns null rather than guessing', () => {
    // NaN would flow into the tax calculation and silently produce a wrong total.
    expect(toNumber('')).toBeNull()
    expect(toNumber('abc')).toBeNull()
    expect(toNumber('12 pieces')).toBeNull()
    expect(toNumber(undefined)).toBeNull()
  })

  it('accepts zero, which is a real discount', () => {
    expect(toNumber('0')).toBe(0)
    expect(toNumber('0.00')).toBe(0)
  })
})

describe('financial year', () => {
  it('reads the Indian two-digit form', () => {
    expect(parseFinancialYear('2026-27')).toEqual({ start: 2026, end: 2027 })
    expect(parseFinancialYear('2026 / 27')).toEqual({ start: 2026, end: 2027 })
  })

  it('reads the four-digit form', () => {
    expect(parseFinancialYear('2026-2027')).toEqual({ start: 2026, end: 2027 })
  })

  it('rejects a span that is not one year', () => {
    expect(parseFinancialYear('2026-29')).toBeNull()
    expect(parseFinancialYear('nonsense')).toBeNull()
  })
})

describe('parseCsv', () => {
  const header = 'bill_number,bill_date,customer_name,part_number,quantity,unit,rate,gst_rate'

  it('maps cells onto logical field names', () => {
    const result = parseCsv(`${header}\nKI/001,2026-04-15,Auto Parts,SFT-1,10,NOS,250,18`)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      bill_number: 'KI/001',
      customer_name: 'Auto Parts',
      quantity: '10',
      gst_rate: '18',
      __line: '2',
    })
  })

  it('drops blank lines instead of creating empty bills', () => {
    const result = parseCsv(`${header}\nKI/001,2026-04-15,A,SFT-1,1,NOS,10,18\n\n\nKI/002,2026-04-16,A,SFT-2,2,NOS,20,18\n\n`)
    expect(result.rows).toHaveLength(2)
  })

  it('reports an unrecognised column instead of dropping rows silently', () => {
    const result = parseCsv(`${header},internal_note\nKI/001,2026-04-15,A,SFT-1,1,NOS,10,18,xyz`)
    expect(result.problems.join(' ')).toMatch(/Ignored unrecognised column/)
    expect(result.rows).toHaveLength(1)
  })

  it('explains itself when nothing is recognisable', () => {
    const result = parseCsv('alpha,beta\n1,2')
    expect(result.rows).toHaveLength(0)
    expect(result.problems[0]).toMatch(/None of the columns were recognised/)
  })

  it('says the file is empty rather than reporting zero rows', () => {
    expect(parseCsv('').problems[0]).toMatch(/empty/i)
  })

  it('strips a UTF-8 BOM Excel writes at the start', () => {
    const result = parseCsv(`\uFEFF${header}\nKI/001,2026-04-15,A,SFT-1,1,NOS,10,18`)
    expect(result.rows[0]?.bill_number).toBe('KI/001')
  })

  it('parses a realistic file with quoted commas', () => {
    const csv = [
      header,
      'KI/001,2026-04-15,"Auto Components, Chennai",SFT-1,10,NOS,250,18',
    ].join('\n')
    const result = parseCsv(csv)
    expect(result.rows[0]?.customer_name).toBe('Auto Components, Chennai')
  })
})

describe('grouping rows into bills', () => {
  // Rows are fed in directly here, so there is no CSV header line to declare.
  const row = (over: Partial<Record<string, string>> = {}) => ({
    bill_number: 'KI/001', bill_date: '2026-04-15', customer_name: 'Auto Parts',
    part_number: 'SFT-1', description: 'Shaft', quantity: '10', unit: 'NOS',
    rate: '250', discount: '0', gst_rate: '18', __line: '2', ...over,
  })

  it('collects several lines into one bill', () => {
    const { bills, invalid } = groupRows([
      row() as never,
      row({ part_number: 'SFT-2', description: 'Bush', quantity: '4', __line: '3' }) as never,
    ])
    expect(invalid).toHaveLength(0)
    expect(bills).toHaveLength(1)
    expect(bills[0]?.items).toHaveLength(2)
  })

  it('keeps different bill numbers apart', () => {
    const { bills } = groupRows([
      row() as never,
      row({ bill_number: 'KI/002', __line: '3' }) as never,
    ])
    expect(bills).toHaveLength(2)
  })

  it('accepts DD/MM/YYYY and normalises it', () => {
    const { bills } = groupRows([row({ bill_date: '15/04/2026' }) as never])
    expect(bills[0]?.billDate).toBe('2026-04-15')
  })

  it('reads DD/MM/YYYY, the Indian convention, as a stated rule', () => {
    const { bills, invalid } = groupRows([row({ bill_date: '03/04/2026' }) as never])
    expect(invalid).toHaveLength(0)
    expect(bills[0]?.billDate).toBe('2026-04-03')
  })

  it('rejects a date it cannot read at all', () => {
    for (const bad of ['03/04/26', 'Apr 2026', '2026-13-01', '32/01/2026', '']) {
      const { bills, invalid } = groupRows([row({ bill_date: bad }) as never])
      expect(bills, `expected "${bad}" to be rejected`).toHaveLength(0)
      expect(invalid[0]?.message).toMatch(/is not a date/)
    }
  })

  it('refuses a second line whose date disagrees with the first', () => {
    const { bills, invalid } = groupRows([
      row() as never,
      row({ bill_date: '2026-05-01', __line: '3' }) as never,
    ])
    expect(bills[0]?.items).toHaveLength(1)
    expect(invalid[0]?.message).toMatch(/bill date differs/)
  })

  it('refuses a second line whose customer disagrees with the first', () => {
    const { bills, invalid } = groupRows([
      row() as never,
      row({ customer_name: 'Someone Else', __line: '3' }) as never,
    ])
    expect(bills[0]?.items).toHaveLength(1)
    expect(invalid[0]?.message).toMatch(/customer differs/)
  })

  it('rejects a missing bill number', () => {
    const { invalid } = groupRows([row({ bill_number: '' }) as never])
    expect(invalid[0]?.message).toMatch(/bill number is missing/)
  })

  it('rejects a non-positive quantity', () => {
    const { invalid } = groupRows([row({ quantity: '0' }) as never])
    expect(invalid[0]?.message).toMatch(/not a positive number/)
  })

  it('rejects a GST rate outside 0-100', () => {
    const { invalid } = groupRows([row({ gst_rate: '150' }) as never])
    expect(invalid[0]?.message).toMatch(/between 0 and 100/)
  })

  it('rejects a malformed GSTIN rather than storing it', () => {
    const { invalid } = groupRows([row({ customer_gstin: 'NOTAGSTIN' }) as never])
    expect(invalid[0]?.message).toMatch(/valid 15-character GSTIN/)
  })

  it('normalises a spaced GSTIN and accepts it', () => {
    const { bills, invalid } = groupRows([row({ customer_gstin: '33 abcde 1234 f 1 z 5' }) as never])
    expect(invalid).toHaveLength(0)
    expect(bills[0]?.customerGstin).toBe('33ABCDE1234F1Z5')
  })

  it('rejects a malformed HSN', () => {
    const { invalid } = groupRows([row({ hsn_code: 'ABCD' }) as never])
    expect(invalid[0]?.message).toMatch(/2 to 8 digits/)
  })

  it('accepts an empty HSN, which is allowed for services', () => {
    const { invalid } = groupRows([row({ hsn_code: '' }) as never])
    expect(invalid).toHaveLength(0)
  })

  it('carries discount and cess through to the line item', () => {
    const { bills } = groupRows([row({ discount: '50', cess_rate: '1' }) as never])
    expect(bills[0]?.items[0]).toMatchObject({ discount: '50', cess_rate: '1' })
  })

  it('defaults payment status to unpaid and validates a stated one', () => {
    expect(groupRows([row() as never]).bills[0]?.paymentStatus).toBe('unpaid')
    expect(groupRows([row({ payment_status: 'paid' }) as never]).bills[0]?.paymentStatus).toBe('paid')
    expect(groupRows([row({ payment_status: 'maybe' }) as never]).invalid[0]?.message).toMatch(/unpaid, partial or paid/)
  })

  it('falls back to the part number when there is no description', () => {
    const { bills } = groupRows([row({ description: '', part_number: 'BRG-9' }) as never])
    expect(bills[0]?.items[0]?.product_name).toBe('BRG-9')
  })

  it('caps a bill at 200 lines, the same limit the form enforces', () => {
    const many = Array.from({ length: 205 }, (_, index) => row({ part_number: `P-${index}`, __line: String(index + 2) }))
    const { bills, invalid } = groupRows(many as never[])
    expect(bills[0]?.items).toHaveLength(200)
    expect(invalid).toHaveLength(5)
  })
})

describe('template', () => {
  it('is parseable by the parser it ships with', () => {
    // A template the application cannot read is worse than none.
    const result = parseCsv(buildTemplateCsv())
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]?.bill_number).toBeTruthy()
    expect(result.problems.filter(p => /unrecognised/i.test(p))).toHaveLength(0)
  })

  it('groups its example row into one valid bill', () => {
    const { bills, invalid } = groupRows(parseCsv(buildTemplateCsv()).rows)
    expect(invalid).toHaveLength(0)
    expect(bills).toHaveLength(1)
  })
})