import { useEffect, useState } from 'react'
import { Button, Card, Field, TextArea } from './ui'
import { db } from '../lib/db'
import { friendlyError, isValidGstin, normalizeGstin } from '../lib/format'
import type { Organization } from '../lib/membership'

/**
 * The company details that print on every invoice and delivery challan.
 *
 * Why this screen exists
 * ----------------------
 * The `organizations` table has carried a GSTIN, an address, a phone number and
 * an email address since the first migration, and the database has always
 * allowed an admin to update them. There was simply no way to reach them from
 * the application, so every letterhead in the system printed whatever the
 * workspace happened to hold - usually nothing.
 *
 * The values are read live whenever a PDF is produced rather than copied onto
 * each bill. That is a deliberate trade: a company that moves house or corrects
 * its GSTIN wants the next invoice to carry the new details, and no business
 * here keeps the historical copies of invoices it has already sent.
 *
 * Only an admin may edit these. The database enforces that too
 * (`organizations_update` requires `app_private.is_org_admin`), so hiding the
 * controls is a convenience and never the protection.
 */
export function CompanyProfileCard({ organization, onSaved }: { organization: Organization; onSaved: () => void | Promise<void> }) {
  const [name, setName] = useState(organization.name)
  const [gstin, setGstin] = useState(organization.gstin ?? '')
  const [address, setAddress] = useState(organization.address ?? '')
  const [phone, setPhone] = useState(organization.phone ?? '')
  const [email, setEmail] = useState(organization.email ?? '')
  const [stateCode, setStateCode] = useState(organization.state_code ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // The workspace can be reloaded from the database (a refresh after a save, or
  // a session refresh), and the form must show what is actually stored rather
  // than what was typed before the reload.
  useEffect(() => {
    setName(organization.name)
    setGstin(organization.gstin ?? '')
    setAddress(organization.address ?? '')
    setPhone(organization.phone ?? '')
    setEmail(organization.email ?? '')
    setStateCode(organization.state_code ?? '')
  }, [organization])

  const canEdit = organization.role === 'admin'

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (busy || !canEdit) return
    setBusy(true); setError(''); setNotice('')
    const trimmedName = name.trim()
    if (trimmedName.length < 2) { setError('The company name is required.'); setBusy(false); return }
    const normalized = normalizeGstin(gstin)
    if (normalized && !isValidGstin(normalized)) { setError('Enter a valid 15-character GSTIN, or leave it empty.'); setBusy(false); return }
    if (stateCode.trim() && !/^\d{2}$/.test(stateCode.trim())) { setError('The state code is two digits, for example 33 for Tamil Nadu.'); setBusy(false); return }
    try {
      const { error: updateError } = await db.from('organizations').update({
        name: trimmedName,
        gstin: normalized || null,
        address: address.trim() || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
        state_code: stateCode.trim() || null,
      }).eq('id', organization.id)
      if (updateError) throw updateError
      setNotice('Company details saved. New invoices and challans will use them.')
      await onSaved()
    } catch (cause) {
      setError(friendlyError(cause))
    } finally {
      setBusy(false)
    }
  }

  const missing = [
    !normalizeGstin(gstin) ? 'GSTIN' : null,
    !address.trim() ? 'address' : null,
    !phone.trim() ? 'phone' : null,
    !email.trim() ? 'email' : null,
  ].filter((value): value is string => value !== null)

  return (
    <Card className="detail-card">
      <div className="section-heading">
        <div>
          <h2>Company details</h2>
          <p>Printed on every invoice PDF and delivery challan. Fill these in once and they appear everywhere.</p>
        </div>
      </div>

      {!canEdit && (
        <p className="muted">
          Only a company admin can change these. Ask an admin to update the company details.
        </p>
      )}

      <form onSubmit={save} className="company-form">
        <div className="form-grid">
          <div className="full-width">
            <Field label="Company name" required maxLength={120} disabled={!canEdit} value={name} onChange={e => setName(e.target.value)} />
          </div>
          <Field label="GSTIN" maxLength={15} disabled={!canEdit} value={gstin} onChange={e => setGstin(e.target.value.toUpperCase())} hint="15 characters. Leave empty only if the company is not registered for GST." />
          <Field label="State code" maxLength={2} disabled={!canEdit} value={stateCode} onChange={e => setStateCode(e.target.value)} hint="Two digits, e.g. 33 for Tamil Nadu." />
          <Field label="Phone" maxLength={32} disabled={!canEdit} value={phone} onChange={e => setPhone(e.target.value)} />
          <Field label="Email" type="email" maxLength={254} disabled={!canEdit} value={email} onChange={e => setEmail(e.target.value)} />
        </div>
        <div className="top-gap">
          <TextArea label="Address" rows={3} maxLength={500} disabled={!canEdit} value={address} onChange={e => setAddress(e.target.value)} />
        </div>

        {canEdit && missing.length > 0 && (
          <p className="muted top-gap">
            Still missing: {missing.join(', ')}. A tax invoice without a GSTIN is not a valid tax invoice, so fill
            these in before sending one to a customer.
          </p>
        )}
        {error && <p role="alert" className="error-box top-gap">{error}</p>}
        {notice && <p role="status" className="success-box top-gap">{notice}</p>}
        {canEdit && (
          <div className="top-gap">
            <Button type="submit" disabled={busy}>{busy ? 'Saving...' : 'Save company details'}</Button>
          </div>
        )}
      </form>
    </Card>
  )
}
