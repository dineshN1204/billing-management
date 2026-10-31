import { useEffect, useRef } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from './ui'
import type { Customer, Product } from '../lib/types'
import { DcItemDraft, emptyItem, type DcType } from '../lib/dc-types'
import { parseQty } from '../lib/dc-quantities'

type Party = Pick<Customer, 'id' | 'name' | 'gstin' | 'party_type'>

const UNITS = ['NOS', 'Kg', 'Meter', 'Gram', 'Liter', 'Set', 'Pair']

/**
 * The line editor, shared by all three document types.
 *
 * It takes an optional onProductSearch so the caller controls how products are
 * looked up; the DC module reuses the existing product table rather than
 * inventing a parts master of its own.
 */
export function DcItemEditor({
  items,
  onChange,
  dcType,
  party,
  units = UNITS,
  onProductSearch,
  productMatches,
  onPickProduct,
  quantityIssue,
  sourceLabels,
}: {
  items: DcItemDraft[]
  onChange: (items: DcItemDraft[]) => void
  dcType: DcType
  party: Party | null
  units?: string[]
  onProductSearch?: (index: number, term: string) => void
  productMatches?: (index: number) => Product[]
  onPickProduct?: (index: number, product: Product) => void
  /** Set when the form refuses a line's quantity, so that field can be focused. */
  quantityIssue?: { index: number; seq: number } | null
  /** Describes a linked inward line, keyed by inward item id. */
  sourceLabels?: Record<string, string>
}) {
  function update(index: number, key: keyof DcItemDraft, value: string) {
    onChange(items.map((item, i) => (i === index ? { ...item, [key]: value } : item)))
  }

  const isOutwardCustomer = dcType === 'outward_customer'
  // The customer's own challan number is recorded where the material arrived
  // from, which is the inward challan. On an outward challan it arrives with
  // the inward line the material came from, so it is not typed here.
  const showCustomerDc = dcType === 'inward'
  const showSource = isOutwardCustomer && Boolean(sourceLabels)

  function sourceLabel(item: DcItemDraft): string | undefined {
    return item.source_inward_item_id ? sourceLabels?.[item.source_inward_item_id] : undefined
  }

  const qtyInputs = useRef<Array<HTMLInputElement | null>>([])

  // The form sets quantityIssue when a line's quantity is not greater than zero.
  // Focusing and scrolling to the field is what tells the operator where the
  // problem is instead of making them hunt for it.
  useEffect(() => {
    if (!quantityIssue) return
    const input = qtyInputs.current[quantityIssue.index]
    if (!input) return
    input.focus()
    input.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [quantityIssue])

  return (
    <div className="dc-item-editor">
      <div className="table-scroll">
        <table className="dc-item-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Part number</th>
              <th>Description</th>
              <th>Drawing / rev</th>
              {showCustomerDc && <th>Customer DC no.</th>}
              {showSource && <th>Against inward DC</th>}
              <th>Unit</th>
              <th>Quantity</th>
              <th aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <tr key={item.key}>
                <td>{index + 1}</td>
                <td className="dc-part-cell">
                  <input
                    value={item.part_number}
                    onChange={e => { update(index, 'part_number', e.target.value); onProductSearch?.(index, e.target.value) }}
                    placeholder="KI-101"
                    aria-label={`Part number line ${index + 1}`}
                  />
                  {onProductSearch && (productMatches?.(index).length ?? 0) > 0 && (
                    <ul className="dc-product-matches">
                      {productMatches?.(index).map(product => (
                        <li key={product.id}>
                          <button type="button" onClick={() => onPickProduct?.(index, product)}>
                            <strong>{product.name}</strong>
                            <small>{product.product_code ?? product.hsn_code ?? product.unit}</small>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <input
                    className="dc-sub-input"
                    value={item.customer_part_number}
                    onChange={e => update(index, 'customer_part_number', e.target.value)}
                    placeholder="Customer part no."
                    aria-label={`Customer part number line ${index + 1}`}
                  />
                </td>
                <td>
                  <input
                    value={item.description}
                    onChange={e => update(index, 'description', e.target.value)}
                    placeholder="Component description"
                    aria-label={`Description line ${index + 1}`}
                  />
                </td>
                <td className="dc-drawing-cell">
                  <input value={item.drawing_number} onChange={e => update(index, 'drawing_number', e.target.value)} placeholder="Drawing" aria-label={`Drawing number line ${index + 1}`} />
                  <input className="dc-sub-input" value={item.drawing_revision} onChange={e => update(index, 'drawing_revision', e.target.value)} placeholder="Rev" aria-label={`Drawing revision line ${index + 1}`} />
                </td>
                {/* One inward challan of ours can carry material from several of
                    the customer's own challans, so their number belongs on the
                    line. It is what the outward challan later prints. */}
                {showCustomerDc && (
                  <td>
                    <input
                      value={item.customer_dc_number}
                      onChange={e => update(index, 'customer_dc_number', e.target.value)}
                      placeholder="CUST-4411"
                      aria-label={`Customer DC number line ${index + 1}`}
                    />
                  </td>
                )}
                {showSource && (
                  <td className="dc-source-cell">
                    {item.source_inward_item_id
                      ? sourceLabel(item) ?? <span className="muted">Linked</span>
                      : <span className="muted">Not linked</span>}
                  </td>
                )}

                <td>
                  <select value={item.unit} onChange={e => update(index, 'unit', e.target.value)} aria-label={`Unit line ${index + 1}`}>
                    {(units.includes(item.unit) ? units : [item.unit, ...units]).map(unit => (
                      <option key={unit} value={unit}>{unit}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    className={`dc-qty-input${quantityIssue?.index === index ? ' invalid' : ''}`}
                    value={item.declared_qty}
                    onChange={e => update(index, 'declared_qty', e.target.value)}
                    inputMode="decimal"
                    placeholder="0"
                    aria-label={`Quantity line ${index + 1}`}
                    aria-invalid={quantityIssue?.index === index || undefined}
                    ref={el => { qtyInputs.current[index] = el }}
                  />
                </td>
                <td>
                  <Button
                    variant="ghost"
                    aria-label={`Remove line ${index + 1}`}
                    disabled={items.length === 1}
                    onClick={() => onChange(items.filter((_, i) => i !== index))}
                  >
                    <Trash2 size={16} />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="dc-item-footer">
        <Button variant="secondary" onClick={() => onChange([...items, emptyItem()])}>
          <Plus size={16} /> Add line
        </Button>
        <span className="muted">
          {items.length} line{items.length === 1 ? '' : 's'}
          {' · '}
          {items.reduce((sum, item) => sum + parseQty(item.declared_qty), 0)} total across units
        </span>
      </div>
      {isOutwardCustomer && party && (
        <p className="muted dc-hint">
          Delivery to {party.name}. The eligible balance is checked when you dispatch, not here.
        </p>
      )}
    </div>
  )
}