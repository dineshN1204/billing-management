import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
 *
 * The results list is portaled to document.body and positioned fixed under the
 * input so it overlays outside any container instead of being clipped by one.
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
  const [highlightIndex, setHighlightIndex] = useState(-1)
  const ref = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<{ top: number; left: number; width: number } | null>(null)

  useEffect(() => {
    function close(event: MouseEvent) {
      const target = event.target as Node
      if (
        ref.current && !ref.current.contains(target) &&
        !document.querySelector('.dc-picker-results')?.contains(target)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  // Mark the picker as loaded without auto-opening the dropdown. The dropdown
  // only opens when the operator focuses or clicks the input, so the field is
  // never focused by default when navigating to the page.
  useEffect(() => {
    if (!open || !organizationId) { setMatches([]); return }
    setBusy(true)
    setFailure('')
    const timer = window.setTimeout(async () => {
      try {
        const result = await searchParties(organizationId, query, partyTypes) as Party[]
        setMatches(result)
        setHighlightIndex(-1)
      } catch (cause) {
        setMatches([])
        setHighlightIndex(-1)
        setFailure(explainError(cause, 'The party list could not be loaded.'))
      } finally {
        setBusy(false)
      }
    }, 220)
    return () => window.clearTimeout(timer)
  }, [open, query, organizationId, partyTypes])

  // Position the portaled results list fixed under the picker input.
  const setPosition = useCallback(() => {
    const el = ref.current?.querySelector('.dc-picker-input')
    if (!el) { setAnchor(null); return }
    const rect = el.getBoundingClientRect()
    setAnchor({ top: rect.bottom + 4, left: rect.left, width: rect.width })
  }, [])

  useEffect(() => {
    if (!open) { setAnchor(null); return }
    setPosition()
    window.addEventListener('scroll', setPosition, true)
    window.addEventListener('resize', setPosition)
    return () => {
      window.removeEventListener('scroll', setPosition, true)
      window.removeEventListener('resize', setPosition)
    }
  }, [open, setPosition])

  const selectParty = (party: Party) => {
    onChange(party)
    setOpen(false)
    setQuery('')
    setHighlightIndex(-1)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (!open) { setOpen(true); return }
      if (matches.length && highlightIndex < matches.length - 1) setHighlightIndex(highlightIndex + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (matches.length && highlightIndex > 0) setHighlightIndex(highlightIndex - 1)
    } else if (event.key === 'Enter') {
      if (open && highlightIndex >= 0 && matches[highlightIndex]) {
        event.preventDefault()
        selectParty(matches[highlightIndex]!)
      }
    } else if (event.key === 'Escape') {
      setOpen(false)
      setHighlightIndex(-1)
    }
  }

  const selectedParty = value ? (
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
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-controls={open ? 'dc-party-picker-results' : undefined}
          aria-activedescendant={open && highlightIndex >= 0 && matches[highlightIndex] ? `dc-party-option-${matches[highlightIndex]!.id}` : undefined}
          aria-autocomplete="list"
          onChange={e => { setQuery(e.target.value); setOpen(true); setHighlightIndex(-1) }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          autoComplete="off"
        />
      </div>
      {open && anchor && (
        createPortal(
          <ul
            id="dc-party-picker-results"
            className="dc-picker-results"
            role="listbox"
            aria-label={label}
            style={{ top: anchor.top, left: anchor.left, width: anchor.width }}
          >
            {busy && <li className="muted">Searching...</li>}
            {!busy && failure && <li className="error-box">{failure}</li>}
            {!busy && !failure && matches.length === 0 && (
              <li className="muted">
                {query.trim()
                  ? 'No party matches that. Check the spelling, or add the party under Customers.'
                  : 'No party of this type exists yet. Add one under Customers, then pick it here.'}
              </li>
            )}
            {matches.map((party, index) => (
              <li key={party.id}>
                <button
                  type="button"
                  role="option"
                  id={`dc-party-option-${party.id}`}
                  aria-selected={highlightIndex === index}
                  onMouseEnter={() => setHighlightIndex(index)}
                  onClick={() => selectParty(party)}
                >
                  <strong>{party.name}</strong>
                  <small>
                    {TYPE_LABEL[party.party_type] ?? party.party_type}
                    {party.gstin ? ` · ${party.gstin}` : ''}
                  </small>
                </button>
              </li>
            ))}
          </ul>,
          document.body
        )
      )}
    </>
  )

  return (
    <div className="field dc-picker" ref={ref}>
      <span>{label}</span>
      {selectedParty}
      {hint && <small>{hint}</small>}
    </div>
  )
}
