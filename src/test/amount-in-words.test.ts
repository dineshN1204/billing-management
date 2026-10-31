import { describe, expect, it } from 'vitest'
import { amountInWords, rupeesInWords } from '../lib/amount-in-words'

describe('the amount on an invoice, in words', () => {
  it('writes the Indian scale, not the western one', () => {
    // 1,00,000 is one lakh here. Writing "One Hundred Thousand" on an invoice
    // issued in India would read as an error.
    expect(rupeesInWords(100000)).toBe('One Lakh')
    expect(rupeesInWords(10000000)).toBe('One Crore')
    expect(rupeesInWords(12345678)).toBe('One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight')
  })

  it('writes the smaller groups the way they are spoken', () => {
    expect(rupeesInWords(0)).toBe('Zero')
    expect(rupeesInWords(7)).toBe('Seven')
    expect(rupeesInWords(19)).toBe('Nineteen')
    expect(rupeesInWords(20)).toBe('Twenty')
    expect(rupeesInWords(99)).toBe('Ninety Nine')
    expect(rupeesInWords(100)).toBe('One Hundred')
    expect(rupeesInWords(1000)).toBe('One Thousand')
    expect(rupeesInWords(15000)).toBe('Fifteen Thousand')
    expect(rupeesInWords(100000)).toBe('One Lakh')
    expect(rupeesInWords(1500000)).toBe('Fifteen Lakh')
  })

  it('writes rupees and paise, and says Only', () => {
    expect(amountInWords(0)).toBe('Rupees Zero and Zero Paise Only')
    expect(amountInWords(100)).toBe('Rupees One Hundred and Zero Paise Only')
    expect(amountInWords(100.5)).toBe('Rupees One Hundred and Fifty Paise Only')
    expect(amountInWords(1234.78)).toBe('Rupees One Thousand Two Hundred Thirty Four and Seventy Eight Paise Only')
  })

  it('rounds the paise to the nearest paisa', () => {
    // A half-rupee is not a thing that can be written on a bill, and rounding
    // it the same way the totals are rounded keeps the words and the figures
    // in agreement. 100.999 is a hundred rupees and one paisa, not a hundred
    // rupees and a hundred paise.
    expect(amountInWords(100.999)).toBe('Rupees One Hundred One and Zero Paise Only')
    expect(amountInWords(99.994)).toBe('Rupees Ninety Nine and Ninety Nine Paise Only')
    expect(amountInWords(0.999)).toBe('Rupees One and Zero Paise Only')
  })

  it('says nothing at all about a figure that is not a number', () => {
    // The bill total is a number in the database, but a NaN that reached the
    // page would print "Rupees NaN and NaN Paise Only" on a customer's invoice.
    expect(amountInWords(Number.NaN)).toBe('')
    expect(amountInWords(Number.POSITIVE_INFINITY)).toBe('')
  })

  it('keeps a minus sign on a negative amount', () => {
    expect(amountInWords(-100)).toBe('Minus Rupees One Hundred and Zero Paise Only')
  })
})
