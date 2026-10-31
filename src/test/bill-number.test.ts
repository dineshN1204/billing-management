import { describe, expect, it } from 'vitest'
import { billNumberForChallan, isSeriesNumber, numberSerial, pickNumberedChallan } from '../lib/bill-number'

describe('reading a number', () => {
  it('takes the serial from a challan number', () => {
    expect(numberSerial('KI/IN/2026-27/0001')).toBe('0001')
    expect(numberSerial('KI/OUT-C/2026-27/0020')).toBe('0020')
  })

  it('takes the serial from a series number', () => {
    expect(numberSerial('2026-27/0020')).toBe('0020')
  })

  it('keeps the suffix on a second outward made from the same inward', () => {
    expect(numberSerial('KI/OUT-C/2026-27/0020-2')).toBe('0020-2')
  })

  it('finds no serial in a number from outside', () => {
    // A bill typed in from paper carries the number printed on that paper.
    // It belongs to no series and holds no serial, so it never competes for
    // one.
    expect(numberSerial('INV-99')).toBeNull()
    expect(numberSerial('')).toBeNull()
    expect(numberSerial(null)).toBeNull()
  })

  it('finds no serial when the segment before the number is not a financial year', () => {
    expect(numberSerial('KI/OUT-C/2026/0020')).toBeNull()
  })
})

describe('knowing a number of ours', () => {
  it('accepts a financial year and a serial', () => {
    expect(isSeriesNumber('2026-27/0020')).toBe(true)
    expect(isSeriesNumber('2026-27/0020-2')).toBe(true)
  })

  it('does not accept a number with a prefix and a segment', () => {
    // This is how a bill was numbered before 0037. It names no series, so
    // the rule that a bill carries its challan's serial does not apply to it
    // and an existing bill keeps its number.
    expect(isSeriesNumber('KI/2026-27/0031')).toBe(false)
  })

  it('does not accept a number from outside', () => {
    expect(isSeriesNumber('INV-99')).toBe(false)
    expect(isSeriesNumber('')).toBe(false)
  })
})

describe('the number a challan makes', () => {
  it('is the financial year and the challan\'s serial', () => {
    expect(billNumberForChallan('KI/IN/2026-27/0001', '2026-27')).toBe('2026-27/0001')
    expect(billNumberForChallan('KI/OUT-C/2026-27/0020', '2026-27')).toBe('2026-27/0020')
  })

  it('carries the suffix of a second outward made from the same inward', () => {
    expect(billNumberForChallan('KI/OUT-C/2026-27/0020-2', '2026-27')).toBe('2026-27/0020-2')
  })

  it('takes the financial year from the bill, not from the challan', () => {
    // A challan received in March and billed in April: the number and the
    // financial year printed beside it on the invoice must not disagree.
    expect(billNumberForChallan('KI/IN/2025-26/0005', '2026-27')).toBe('2026-27/0005')
  })

  it('makes no number out of a challan that holds no serial', () => {
    expect(billNumberForChallan('EXT-9', '2026-27')).toBeNull()
  })
})

describe('the challan a bill number names', () => {
  const challan = (dc_number: string, dc_date = '2026-10-05') => ({ dc_number, dc_date })

  it('is the one with the lowest serial', () => {
    // A bill covering two outward challans carries one of the two serials.
    expect(pickNumberedChallan([challan('KI/OUT-C/2026-27/0021'), challan('KI/OUT-C/2026-27/0020')])?.dc_number)
      .toBe('KI/OUT-C/2026-27/0020')
  })

  it('compares the serial as a number, not as text', () => {
    expect(pickNumberedChallan([challan('KI/OUT-C/2026-27/0100'), challan('KI/OUT-C/2026-27/0099')])?.dc_number)
      .toBe('KI/OUT-C/2026-27/0099')
  })

  it('puts the first outward before the second made from the same inward', () => {
    expect(pickNumberedChallan([challan('KI/OUT-C/2026-27/0020-2'), challan('KI/OUT-C/2026-27/0020')])?.dc_number)
      .toBe('KI/OUT-C/2026-27/0020')
  })

  it('ignores a challan whose number holds no serial', () => {
    expect(pickNumberedChallan([challan('EXT-9'), challan('KI/OUT-C/2026-27/0020')])?.dc_number)
      .toBe('KI/OUT-C/2026-27/0020')
  })

  it('has nothing to pick when no challan holds a serial', () => {
    expect(pickNumberedChallan([challan('EXT-9')])).toBeNull()
    expect(pickNumberedChallan([])).toBeNull()
  })
})
