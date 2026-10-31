import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BillPaper } from '../components/BillPaper'
import type { Bill, BillItem } from '../lib/types'

const COMPANY = {
  name: 'Kallazhagar Industries',
  gstin: '33CAOPR9297L1ZL',
  address: '12 Industrial Estate, Coimbatore 641026',
  phone: '+91 422 234 5678',
  email: 'accounts@kallazhagar.in',
}

const bill = (overrides: Partial<Bill> = {}): Bill => ({
  id: 'bill-1', organization_id: 'org-1', customer_id: 'cust-1', customer_name: 'Acme Engineering',
  customer_gstin: '33AAAAA0001BCZ1', customer_phone: '+91 44 1111 2222', customer_email: 'buy@acme.in',
  customer_address: '4 Market Road, Chennai 600001',
  bill_number: '03', bill_date: '2026-10-05', place_of_supply: 'Tamil Nadu', financial_year: '2026-27',
  tax_mode: 'intra', payment_status: 'unpaid', payment_date: null, payment_method: null,
  source_type: 'manual', verification_status: 'verified', customer_dc_reference: null, notes: null,
  subtotal: 200000, discount_total: 0, taxable_amount: 200000, cgst_amount: 18000, sgst_amount: 18000,
  igst_amount: 0, tax_total: 36000, cess_amount: 0, grand_total: 236000,
  paid_amount: 0, remaining_amount: 236000,
  version: 1, cancellation_reason: null, deleted_at: null, created_at: '2026-10-05T09:00:00Z',
  ...overrides,
})

const item = (overrides: Partial<BillItem> = {}): BillItem => ({
  id: 'bi-1', line_no: 1, bill_id: 'bill-1', product_id: null, product_name: 'CNC Shaft',
  product_code: 'KI-101', hsn_code: '848310', description: 'Machined shaft', unit: 'NOS',
  quantity: 100, rate: 2000, discount: 0, gst_rate: 18,
  line_subtotal: 200000, taxable_amount: 200000, cgst_amount: 18000, sgst_amount: 18000,
  igst_amount: 0, cess_amount: 0, cess_rate: 0, line_total: 236000,
  ...overrides,
})

const REF = { customerDcNumbers: ['500', '503'], outwardDcNumbers: ['KI/OUT-C/2026-27/0005'] }

const paper = (b: Bill = bill(), items: BillItem[] = [item()], references = REF) =>
  renderToStaticMarkup(
    createElement(BillPaper, { bill: b, items, company: COMPANY, references }),
  )

describe('Bill document preview', () => {
  it('matches the PDF: tax invoice identity, amount in words and signature', () => {
    const html = paper()
    expect(html, 'the tax invoice identity is missing').toContain('TAX INVOICE')
    expect(html, 'the bill number is missing').toContain('Bill No: 03')
    expect(html, 'the amount-in-words heading is missing').toContain('AMOUNT IN WORDS')
    expect(html, 'the amount in words is missing').toContain('Rupees')
    expect(html, 'the signatory line is missing').toContain('Authorised signatory')
  })

  it('leaves every discount field off a bill that has no discount', () => {
    const html = paper()
    expect(html, 'a discount column or total was drawn for a bill with no discount').not.toContain('Discount')
  })

  it('prints the discount column and total when the bill has a discount', () => {
    const html = paper(
      bill({ discount_total: 5000, taxable_amount: 195000 }),
      [item({ discount: 5000, taxable_amount: 195000 })],
    )
    expect(html, 'the discount column is missing').toContain('Discount (Rs.)')
    expect(html, 'the discount value is missing').toContain('5,000.00')
    expect(html, 'the discount total row is missing').toContain('- 5,000.00')
  })

  it('omits a delivery-challan reference side that has no value', () => {
    const html = paper(bill(), [item()], { customerDcNumbers: ['500'], outwardDcNumbers: [] })
    expect(html, 'the customer DC side is missing').toContain('Customer DC')
    expect(html, 'the customer DC number is missing').toContain('500')
    expect(html, 'an empty outward DC side was drawn').not.toContain('Outward DC')
  })

  it('leaves the whole delivery-challan block off a bill with neither', () => {
    const html = paper(bill(), [item()], { customerDcNumbers: [], outwardDcNumbers: [] })
    expect(html, 'the challan block was drawn for a bill with no references').not.toContain('DELIVERY CHALLANS')
    expect(html, 'a customer DC side was drawn').not.toContain('Customer DC')
    expect(html, 'an outward DC side was drawn').not.toContain('Outward DC')
  })

  it('hides the amount-received and balance-due lines on an unpaid bill', () => {
    const html = paper(bill({ payment_status: 'unpaid' }))
    expect(html, 'an unpaid bill should not show Amount received').not.toContain('Amount received')
    expect(html, 'an unpaid bill should not show Balance due').not.toContain('Balance due')
  })

  it('shows the amount-received and balance-due lines on a paid bill', () => {
    const html = paper(bill({ payment_status: 'paid', paid_amount: 236000 }))
    expect(html, 'Payment status is missing').toContain('Payment status')
    expect(html, 'Amount received is missing').toContain('Amount received')
    expect(html, 'Balance due is missing').toContain('Balance due')
  })

  it('draws no icon markup (no FileText symbol)', () => {
    const html = paper()
    expect(html, 'an icon/ svg was drawn on the document').not.toContain('<svg')
  })

  it('draws a single dividing rule above the highlighted block', () => {
    const html = paper()
    // The print used to draw two rules here - the header's border-bottom plus a
    // redundant `<hr class="bill-rule">` - which the PDF never had. The markup
    // now carries only the header rule, matching the PDF's single canvas line.
    expect(html, 'the redundant bill-rule hr was left in the markup').not.toContain('bill-rule')
  })

  it('renders the rate-wise tax summary', () => {
    const html = paper()
    expect(html, 'the tax summary is missing').toContain('TAX SUMMARY')
    expect(html, 'the CGST rate is missing').toContain('18%')
  })
})
