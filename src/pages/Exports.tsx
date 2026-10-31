import { useState } from 'react'
import { useAuth } from '../lib/auth'
import { db } from '../lib/db'
import { PageTitle, Card, Button, Loading } from '../components/ui'
import { buildCsv, downloadCsv, type CsvCell } from '../lib/csv'
import { friendlyError } from '../lib/format'
import { billRemaining } from '../lib/calculations'
import type { Bill, Customer, Product } from '../lib/types'

function downloadCSV(filename: string, headers: string[], rows: CsvCell[][]) {
  downloadCsv(filename, buildCsv(headers, rows))
}

export function Exports() {
  const { organization } = useAuth()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const exportCustomers = async () => {
    if (!organization) return
    setLoading(true)
    setError('')
    const { data, error: queryError } = await db
      .from('customers')
      .select('*')
      .eq('organization_id', organization.id)
      .is('deleted_at', null)
      .order('name')
    if (queryError) { setError(friendlyError(queryError)); setLoading(false); return }
    const headers = ['Name', 'GSTIN', 'Phone', 'Email', 'City', 'State', 'Pincode', 'Address', 'Verification']
    const rows = (data as Customer[]).map((c) => [
      c.name,
      c.gstin || '',
      c.phone || '',
      c.email || '',
      c.city || '',
      c.state || '',
      c.pincode || '',
      c.address_line_1 || c.address || '',
      c.verification_status
    ])
    downloadCSV('customers.csv', headers, rows)
    setLoading(false)
  }

  const exportProducts = async () => {
    if (!organization) return
    setLoading(true)
    setError('')
    const { data, error: queryError } = await db
      .from('products')
      .select('*')
      .eq('organization_id', organization.id)
      .is('deleted_at', null)
      .order('name')
    if (queryError) { setError(friendlyError(queryError)); setLoading(false); return }
    const headers = ['Name', 'Code', 'HSN', 'Unit', 'Default Rate', 'GST %', 'Description']
    const rows = (data as Product[]).map((p) => [
      p.name,
      p.product_code || '',
      p.hsn_code || '',
      p.unit,
      String(p.default_rate),
      String(p.gst_rate),
      p.description || ''
    ])
    downloadCSV('products.csv', headers, rows)
    setLoading(false)
  }

  const exportBills = async () => {
    if (!organization) return
    setLoading(true)
    setError('')
    const { data, error: queryError } = await db
      .from('bills')
      .select('*')
      .eq('organization_id', organization.id)
      .is('deleted_at', null)
      .order('bill_date', { ascending: false })
      .limit(5000)
    if (queryError) { setError(friendlyError(queryError)); setLoading(false); return }
    const headers = ['Bill No', 'Date', 'Customer', 'GSTIN', 'Tax Mode', 'Subtotal', 'Discount', 'Taxable', 'CGST', 'SGST', 'IGST', 'Cess', 'Total GST', 'Grand Total', 'Amount Received', 'Remaining', 'Payment Status', 'Payment Date', 'Payment Method', 'Source', 'Verification']
    const rows = (data as Bill[]).map((b) => [
      b.bill_number,
      b.bill_date,
      b.customer_name,
      b.customer_gstin || '',
      b.tax_mode,
      String(b.subtotal),
      String(b.discount_total),
      String(b.taxable_amount),
      String(b.cgst_amount),
      String(b.sgst_amount),
      String(b.igst_amount),
      String(b.cess_amount),
      String(b.tax_total),
      String(b.grand_total),
      // What has been received against the bill, and what is still owed. The
      // export is read next to the list, and the list carries the balance.
      String(b.paid_amount ?? 0),
      String(billRemaining(b)),
      b.payment_status,
      b.payment_date || '',
      b.payment_method || '',
      b.source_type,
      b.verification_status
    ])
    downloadCSV('bills.csv', headers, rows)
    setLoading(false)
  }

  return (
    <>
      <PageTitle eyebrow="DATA" title="Exports" description="Export your records as CSV (client-side generation; large datasets limited to 5000 rows for performance)." />
      <Card>
        {error && <p role="alert" className="error-box">{error}</p>}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', padding: 20 }}>
          <Button variant="secondary" disabled={loading} onClick={exportCustomers}>
            Export Customers (CSV)
          </Button>
          <Button variant="secondary" disabled={loading} onClick={exportProducts}>
            Export Products (CSV)
          </Button>
          <Button variant="secondary" disabled={loading} onClick={exportBills}>
            Export Bills (CSV - up to 5000)
          </Button>
        </div>
        {loading && <Loading label="Generating export..." />}
      </Card>
    </>
  )
}
