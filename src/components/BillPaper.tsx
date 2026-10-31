import { amountInWords } from '../lib/amount-in-words'
import { billRemaining } from '../lib/calculations'
import type { BillReferences } from '../lib/bill-references'
import { referenceText } from '../lib/bill-references'
import { displayDate, plainAmount } from '../lib/format'
import type { Company } from '../lib/bill-pdf'
import type { Bill, BillItem } from '../lib/types'

type Props = {
  bill: Bill
  items: BillItem[]
  company: Company
  references: BillReferences
}

/**
 * A labelled value line, omitted entirely when there is nothing to put beside it.
 *
 * A line reading "Payment method —" on a challan is not a neutral placeholder:
 * it reads as a gap in the record. Same gate as the PDF, and this preview is
 * what the customer is shown before the download.
 */
function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value || !value.trim()) return null
  return (
    <>
      <dt>{label}</dt><dd>{value}</dd>
    </>
  )
}

/**
 * A label and its value, side by side with a visible gap between them.
 * Matches the PDF's Customer DC / Outward DC layout so the screen, the printout
 * and the downloaded file read the same way.
 */
function RefPair({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value || !value.trim()) return null
  return (
    <div className="bill-ref-pair">
      <span className="bill-ref-label">{label}</span>
      <span className="bill-ref-value">{value}</span>
    </div>
  )
}

/**
 * The A4 tax invoice, as a document.
 *
 * It is intentionally not styled like the rest of the app: an invoice is a
 * document that gets filed, signed and sent to a customer, so it is laid out as a
 * document rather than as an application screen. The markup here mirrors
 * `buildBillDefinition` one-for-one, so the on-screen preview, the browser
 * printout and the downloaded PDF are the same document viewed three ways.
 */
export function BillPaper({ bill, items, company, references }: Props) {
  const hasDiscount = Number(bill.discount_total) > 0
  const hasPayment = bill.payment_status !== 'unpaid'

  const rates = [...new Set(items.map(item => Number(item.gst_rate)))].sort((a, b) => a - b)

  return (
    <div className="bill-paper">
      {/* Header: company on the left, tax-invoice identity on the right. */}
      <header className="bill-head">
        <div className="bill-company">
          <strong>{company.name}</strong>
          {company.address && <p>{company.address}</p>}
          {company.phone && <p>Phone: {company.phone}</p>}
          {company.email && <p>Email: {company.email}</p>}
          {company.gstin && <p className="mono">GSTIN: {company.gstin}</p>}
        </div>
        <div className="bill-title">
          <div className="bill-eyebrow">TAX INVOICE</div>
          <div className="bill-number">Bill No: {bill.bill_number}</div>
          <div className="bill-date">Bill Date: {displayDate(bill.bill_date)}</div>
          <div className="bill-fy">Financial year: {bill.financial_year}</div>
        </div>
      </header>

      {/* Billed-to buyer on the left, invoice details on the right. */}
      <section className="bill-party">
        <div className="bill-billed-to">
          <span className="bill-label">BILLED TO</span>
          <strong>{bill.customer_name}</strong>
          {bill.customer_address && <p>{bill.customer_address}</p>}
          {bill.customer_gstin && <p className="mono">GSTIN: {bill.customer_gstin}</p>}
          {bill.customer_phone && <p>Phone: {bill.customer_phone}</p>}
          {bill.customer_email && <p>Email: {bill.customer_email}</p>}
        </div>
        <div className="bill-details">
          <span className="bill-label">INVOICE DETAILS</span>
          <dl>
            <Detail label="Place of supply" value={bill.place_of_supply} />
            <Detail label="Tax type" value={bill.tax_mode === 'intra' ? 'CGST + SGST' : 'IGST'} />
            <Detail label="Payment status" value={bill.payment_status} />
            {bill.payment_date && <Detail label="Payment date" value={displayDate(bill.payment_date)} />}
            {bill.payment_method && <Detail label="Payment method" value={bill.payment_method} />}
            {hasPayment && (
              <>
                <Detail label="Amount received" value={plainAmount(bill.paid_amount ?? 0)} />
                <Detail label="Balance due" value={plainAmount(billRemaining(bill))} />
              </>
            )}
          </dl>
        </div>
      </section>

      {/* The challans this bill answers to. Omitted entirely when there are none,
          rather than left as a labelled gap. */}
      {(references.customerDcNumbers.length > 0 || references.outwardDcNumbers.length > 0) && (
        <section className="bill-references">
          <span className="bill-label">DELIVERY CHALLANS</span>
          <div className="bill-ref-grid">
            {references.customerDcNumbers.length > 0 && <RefPair label="Customer DC" value={referenceText(references.customerDcNumbers)} />}
            {references.outwardDcNumbers.length > 0 && <RefPair label="Outward DC" value={referenceText(references.outwardDcNumbers)} />}
          </div>
        </section>
      )}

      {/* Line items. The discount column follows the PDF: present only when the bill
          actually carries a discount. */}
      <table className="bill-items">
        <thead>
          <tr>
            <th>#</th>
            <th>Description</th>
            <th>HSN</th>
            <th>Qty</th>
            <th>Rate (Rs.)</th>
            {hasDiscount && <th>Discount (Rs.)</th>}
            <th>Taxable (Rs.)</th>
            <th>GST %</th>
            <th>Tax (Rs.)</th>
            <th>Amount (Rs.)</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={item.id}>
              <td className="num">{index + 1}</td>
              <td className="bill-desc">
                <strong>{item.product_name}</strong>
                {item.description && <small>{item.description}</small>}
              </td>
              <td className="mono">{item.hsn_code || '—'}</td>
              <td className="num">{plainAmount(item.quantity)} {item.unit}</td>
              <td className="num">{plainAmount(item.rate)}</td>
              {hasDiscount && <td className="num">{plainAmount(item.discount)}</td>}
              <td className="num">{plainAmount(item.taxable_amount)}</td>
              <td className="num">{item.gst_rate}%</td>
              <td className="num">{plainAmount(item.cgst_amount + item.sgst_amount + item.igst_amount)}</td>
              <td className="amount">{plainAmount(item.line_total)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Rate-wise tax summary. CGST and SGST are shown separately for a bill
          within the state and IGST for a bill to another state - never both. */}
      <section className="bill-tax-summary">
        <span className="bill-label">TAX SUMMARY</span>
        <table className="bill-items">
          <thead>
            <tr>
              <th>GST rate</th>
              <th>Taxable (Rs.)</th>
              {bill.tax_mode === 'intra' ? <><th>CGST (Rs.)</th><th>SGST (Rs.)</th></> : <th>IGST (Rs.)</th>}
            </tr>
          </thead>
          <tbody>
            {rates.map(rate => {
              const lines = items.filter(item => Number(item.gst_rate) === rate)
              return (
                <tr key={rate}>
                  <td className="num">{rate}%</td>
                  <td className="num">{plainAmount(lines.reduce((sum, item) => sum + Number(item.taxable_amount), 0))}</td>
                  {bill.tax_mode === 'intra'
                    ? <><td className="num">{plainAmount(lines.reduce((sum, item) => sum + Number(item.cgst_amount), 0))}</td><td className="num">{plainAmount(lines.reduce((sum, item) => sum + Number(item.sgst_amount), 0))}</td></>
                    : <td className="num">{plainAmount(lines.reduce((sum, item) => sum + Number(item.igst_amount), 0))}</td>}
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>

      {/* Amount in words on the left, the running totals on the right. */}
      <div className="bill-totals-wrap">
        <div className="bill-amount-words">
          <span className="bill-label">AMOUNT IN WORDS</span>
          <p className="bill-amount-in-words">{amountInWords(Number(bill.grand_total))}</p>
          {bill.notes && <p className="bill-note">Notes: {bill.notes}</p>}
        </div>
        <dl className="bill-totals">
          <div><dt>Subtotal</dt><dd>{plainAmount(bill.subtotal)}</dd></div>
          {hasDiscount && <div><dt>Discount</dt><dd>- {plainAmount(bill.discount_total)}</dd></div>}
          <div><dt>Taxable amount</dt><dd>{plainAmount(bill.taxable_amount)}</dd></div>
          {bill.tax_mode === 'intra'
            ? <><div><dt>CGST</dt><dd>{plainAmount(bill.cgst_amount)}</dd></div><div><dt>SGST</dt><dd>{plainAmount(bill.sgst_amount)}</dd></div></>
            : <div><dt>IGST</dt><dd>{plainAmount(bill.igst_amount)}</dd></div>}
          {Number(bill.cess_amount) > 0 && <div><dt>Cess</dt><dd>{plainAmount(bill.cess_amount)}</dd></div>}
          <div className="bill-grand-total"><dt>Grand total</dt><dd>{plainAmount(bill.grand_total)}</dd></div>
        </dl>
      </div>

      {/* Signature block, matching the PDF. */}
      <div className="bill-signature">
        <p className="bill-signed-to">For {company.name}</p>
        <p>____________________________</p>
        <small className="bill-label">Authorised signatory</small>
      </div>
    </div>
  )
}
