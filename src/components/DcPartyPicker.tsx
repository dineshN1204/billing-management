import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { searchParties } from '../lib/dc-api'
import { explainError } from '../lib/format'
import type { Customer } from '../lib/types'

type Party = Pick<Customer, 'id' | 'name' | 'gstin' | 'party_type'>

const TYPE_LABEL: Record<string, string> = {
  customer: 'Customer', supplier: 'Supplier', vendor: 'Vendor', other: 'Other',
}

/**
 * Searches the existing customer database. There is no separate party master:
 * suppliers and subcontractors live in `customers` with a party_type, so this
 * one picker serves every DC and GSTIN uniqueness still holds.
 */
export function DcPartyPicker({
  organizationId,
  value,
  onChange,
  partyTypes,
  label = 'Party',
  hint,
}: {
  organizationId: string
  value: Party | null
  onChange: (party: Party | null) => void
  partyTypes?: string[]
  label?: string
  hint?: string
}) {
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<Party[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function close(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  useEffect(() => {
    if (!open || !organizationId) { setMatches([]); return }
    setBusy(true)
    setFailure('')
    const timer = window.setTimeout(async () => {
      try {
        setMatches(await searchParties(organizationId, query, partyTypes) as Party[])
      } catch (cause) {
        // Report the failure instead of showing an empty list: "no matches" and
        // "the query did not run" look the same on screen but mean very
        // different things to whoever is trying to raise a challan.
        setMatches([])
        setFailure(explainError(cause, 'The party list could not be loaded.'))
      } finally {
        setBusy(false)
      }
    }, 220)
    return () => window.clearTimeout(timer)
  }, [open, query, organizationId, partyTypes])

  return (
    <div className="field dc-picker" ref={ref}>
      <span>{label}</span>
      {value ? (
        <div className="dc-picker-selected">
          <div>
            <strong>{value.name}</strong>
            <small>
              {TYPE_LABEL[value.party_type] ?? value.party_type}
              {value.gstin ? ` · ${value.gstin}` : ''}
            </small>
          </div>
          <button type="button" aria-label="Change party" onClick={() => { onChange(null); setQuery(''); setOpen(true) }}>
            <X size={16} />
          </button>
        </div>
      ) : (
        <>
          <div className="dc-picker-input">
            <Search size={15} aria-hidden />
            <input
              value={query}
              placeholder="Search by name or GSTIN..."
              onChange={e => { setQuery(e.target.value); setOpen(true) }}
              onFocus={() => setOpen(true)}
              autoComplete="off"
            />
          </div>
          {open && (
            <ul className="dc-picker-results" role="listbox">
              {busy && <li className="muted">Searching...</li>}
              {!busy && failure && <li className="error-box">{failure}</li>}
              {!busy && !failure && matches.length === 0 && (
                <li className="muted">
                  {query.trim()
                    ? 'No party matches that. Check the spelling, or add the party under Customers.'
                    : 'No party of this type exists yet. Add one under Customers, then pick it here.'}
                </li>
              )}
              {matches.map(party => (
                <li key={party.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    onClick={() => { onChange(party); setOpen(false); setQuery('') }}
                  >
                    <strong>{party.name}</strong>
                    <small>
                      {TYPE_LABEL[party.party_type] ?? party.party_type}
                      {party.gstin ? ` · ${party.gstin}` : ''}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {hint && <small>{hint}</small>}
    </div>
  )
}