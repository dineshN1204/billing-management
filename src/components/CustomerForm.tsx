import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { Button, Field, SelectField, TextArea } from './ui'
import { useAuth } from '../lib/auth'
import { friendlyError, isValidGstin, normalizeGstin } from '../lib/format'
import { db } from '../lib/db'
import type { Customer, PartyType } from '../lib/types'

const schema = z.object({ name: z.string().trim().min(1, 'Company name is required').max(200), gstin: z.string(), phone: z.string().max(32), email: z.union([z.literal(''), z.string().email()]), address: z.string().max(500), address_line_1: z.string().max(200), address_line_2: z.string().max(200), city: z.string().max(100), state: z.string().max(100), pincode: z.string(), country: z.string().max(100), state_code: z.union([z.literal(''), z.string().regex(/^\d{2}$/, 'State code must be two digits')]), notes: z.string().max(2000), party_type: z.enum(['customer', 'supplier', 'vendor', 'other']) })
type Values = z.infer<typeof schema>
const empty: Values = { name: '', gstin: '', phone: '', email: '', address: '', address_line_1: '', address_line_2: '', city: '', state: '', pincode: '', country: 'India', state_code: '', notes: '', party_type: 'customer' }

/**
 * One party master, four roles. Billing and the DC module read the same rows;
 * the type decides which DC pickers offer the party, so a heat-treatment vendor
 * never turns up as a delivery destination for a customer.
 *
 * It is set explicitly and never inferred from usage. Inferring it would quietly
 * move existing customers in and out of the Outward Customer DC picker the first
 * time somebody issued their material to a vendor.
 */
const PARTY_TYPES: Array<{ value: PartyType; label: string; hint: string }> = [
  { value: 'customer', label: 'Customer', hint: 'Sells to you. Appears in inward and outward customer challans.' },
  { value: 'supplier', label: 'Supplier', hint: 'Sells material to you.' },
  { value: 'vendor', label: 'Vendor / subcontractor', hint: 'Does machining, plating, heat treatment or testing for you.' },
  { value: 'other', label: 'Other', hint: 'Any other authorised party.' },
]

const roleLabel = (value: PartyType) => PARTY_TYPES.find(t => t.value === value)?.label ?? 'Customer'

export function CustomerForm({ customer, onClose, onSaved }: { customer?: Customer; onClose: () => void; onSaved: (customer: Customer) => void }) {
  const { organization } = useAuth()
  const ref = useRef<HTMLDialogElement>(null)
  const [values, setValues] = useState<Values>(customer ? { name: customer.name, gstin: customer.gstin ?? '', phone: customer.phone ?? '', email: customer.email ?? '', address: customer.address ?? '', address_line_1: customer.address_line_1 ?? '', address_line_2: customer.address_line_2 ?? '', city: customer.city ?? '', state: customer.state ?? '', pincode: customer.pincode ?? '', country: customer.country ?? 'India', state_code: customer.state_code ?? '', notes: customer.notes ?? '', party_type: customer.party_type ?? 'customer' } : empty)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [match, setMatch] = useState<Customer | null>(null)
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close() }, [])
  function set(key: keyof Values, value: string) { setValues(previous => ({ ...previous, [key]: value })); setError(''); setMatch(null) }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (!organization) return
    const parsed = schema.safeParse(values)
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the customer details.'); return }
    const gstin = normalizeGstin(values.gstin)
    if (values.pincode && !/^[1-9]\d{5}$/.test(values.pincode.replaceAll(' ', '')) && (!values.country || /^(india|in)$/i.test(values.country))) { setError('Indian PIN codes must have six digits.'); return }
    if (gstin && !isValidGstin(gstin)) { setError('Enter a valid GSTIN or leave it empty for an unverified historical customer.'); return }
    setBusy(true); setError('')
    try {
      if (!customer) {
        const { data: possible } = await db.from('customers').select('*').eq('organization_id', organization.id).is('deleted_at', null).ilike('name', values.name.trim()).limit(1)
        if (possible?.[0]) { setMatch(possible[0] as Customer); return }
      }
      const record = { name: values.name.trim(), gstin: gstin || null, phone: values.phone.trim() || null, email: values.email.trim() || null, address: values.address.trim() || null, address_line_1: values.address_line_1.trim() || null, address_line_2: values.address_line_2.trim() || null, city: values.city.trim() || null, state: values.state.trim() || null, pincode: values.pincode.trim() || null, country: values.country.trim() || null, state_code: values.state_code || null, notes: values.notes.trim() || null, party_type: values.party_type }
      const result = customer ? await db.from('customers').update(record).eq('id', customer.id).eq('organization_id', organization.id).select().single() : await db.from('customers').insert({ ...record, organization_id: organization.id }).select().single()
      if (result.error) throw result.error
      onSaved(result.data as Customer)
    } catch (cause) { setError(friendlyError(cause)) } finally { setBusy(false) }
  }
  return <dialog ref={ref} className="modal" onClose={onClose} aria-labelledby="customer-dialog-title"><form onSubmit={submit}><div className="modal-header"><div><div className="eyebrow">PARTY RECORD</div><h2 id="customer-dialog-title">{customer ? `Edit ${roleLabel(values.party_type).toLowerCase()}` : `Add ${roleLabel(values.party_type).toLowerCase()}`}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close">×</button></div><div className="form-grid"><Field label="Company name" required autoFocus maxLength={200} value={values.name} onChange={e => set('name', e.target.value)} /><SelectField label="Party type" value={values.party_type} onChange={e => set('party_type', e.target.value)} hint={PARTY_TYPES.find(t => t.value === values.party_type)?.hint}>{PARTY_TYPES.map(type => <option key={type.value} value={type.value}>{type.label}</option>)}</SelectField><Field label="GSTIN (optional)" value={values.gstin} onChange={e => set('gstin', e.target.value)} hint="Leave blank when uncertain; don't guess from an old invoice." /><Field label="Phone" type="tel" value={values.phone} onChange={e => set('phone', e.target.value)} /><Field label="Email" type="email" value={values.email} onChange={e => set('email', e.target.value)} /><Field label="State code" placeholder="e.g. 33" value={values.state_code} onChange={e => set('state_code', e.target.value)} /><Field label="City" value={values.city} onChange={e => set('city', e.target.value)} /><Field label="State" value={values.state} onChange={e => set('state', e.target.value)} /><Field label="PIN code" value={values.pincode} onChange={e => set('pincode', e.target.value)} /><Field label="Country" value={values.country} onChange={e => set('country', e.target.value)} /><Field label="Address line 1" value={values.address_line_1} onChange={e => set('address_line_1', e.target.value)} /><Field label="Address line 2" value={values.address_line_2} onChange={e => set('address_line_2', e.target.value)} /><div className="full-width"><TextArea label="Legacy address / source text" rows={2} value={values.address} onChange={e => set('address', e.target.value)} /></div><div className="full-width"><TextArea label="Notes" rows={2} value={values.notes} onChange={e => set('notes', e.target.value)} /></div></div>{match && <div className="error-box" role="alert">A party named <strong>{match.name}</strong> already exists ({roleLabel(match.party_type ?? 'customer').toLowerCase()}). Open that record rather than creating a duplicate.</div>}{error && <p role="alert" className="error-box">{error}</p>}<div className="modal-actions"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={busy || Boolean(match)} type="submit">{busy ? 'Saving...' : customer ? 'Save changes' : 'Add customer'}</Button></div></form></dialog>
}
