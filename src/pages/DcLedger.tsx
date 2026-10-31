import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Download } from 'lucide-react'
import { Button, Card, EmptyState, Field, Loading, PageTitle, SelectField } from '../components/ui'
import { useAuth } from '../lib/auth'
import { dcApi, searchParties } from '../lib/dc-api'
import { describeError } from '../lib/format'
import type { DcLedgerRow } from '../lib/dc-types'
import { qty } from '../lib/dc-quantities'
import { buildCsv, downloadCsv } from '../lib/csv'
import { db } from '../lib/db'
import type { Customer } from '../lib/types'

/**
 * The customer material ledger.
 *
 * Every quantity is its own column. That is the whole point: "600 issued, 570
 * accepted back" is 600 at the vendor AND 570 finished, and collapsing those
 * into one "remaining" number is the error this view exists to prevent.
 */
export function DcLedger() {
  const { organization } = useAuth()
  const [params, setParams] = useSearchParams()
  const [customers, setCustomers] = useState<Array<Pick<Customer, 'id' | 'name' | 'gstin'>>>([])
  const [customerId, setCustomerId] = useState(params.get('customer') ?? '')
  const [search, setSearch] = useState('')
  const [matches, setMatches] = useState<Array<Pick<Customer, 'id' | 'name' | 'gstin'>>>([])
  const [rows, setRows] = useState<DcLedgerRow[]>([])
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [part, setPart] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!organization) return
    void db.from('customers').select('id,name,gstin').eq('organization_id', organization.id)
      .is('deleted_at', null).eq('party_type', 'customer').order('name')
      .then(({ data }) => setCustomers((data ?? []) as Array<Pick<Customer, 'id' | 'name' | 'gstin'>>))
  }, [organization])

  useEffect(() => {
    if (search.trim().length < 1) { setMatches([]); return }
    const timer = window.setTimeout(async () => {
      const found = await searchParties(organization!.id, search, ['customer'])
      setMatches(found as Array<Pick<Customer, 'id' | 'name' | 'gstin'>>)
    }, 220)
    return () => window.clearTimeout(timer)
  }, [search, organization])

  useEffect(() => {
    if (!organization || !customerId) return
    let active = true
    setLoading(true)
    void (async () => {
      try {
        const data = await dcApi.ledger(organization.id, customerId, part || undefined, from || undefined, to || undefined)
        if (active) { setRows(data); setError('') }
      } catch (cause) {
        if (active) setError(describeError(cause, 'Could not load the ledger.'))
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [organization, customerId, part, from, to])

  function select(id: string) {
    setCustomerId(id)
    setSearch('')
    setMatches([])
    setParams(id ? { customer: id } : {})
  }

  const totals = useMemo(() => rows.reduce((acc, row) => {
    acc.received += Number(row.received_total)
    acc.acceptedMaterial += Number(row.accepted_material)
    acc.rejectedMaterial += Number(row.rejected_material)
    acc.pendingInspection += Number(row.pending_inspection)
    acc.machiningInput += Number(row.machining_input)
    acc.acceptedOutput += Number(row.accepted_output)
    acc.machiningRejection += Number(row.machining_rejection)
    acc.dispatched += Number(row.dispatched_total)
    acc.availableMaterial += Number(row.available_customer_material)
    acc.availableFinished += Number(row.available_finished_stock)
    acc.unaccounted += Number(row.unaccounted_dispatch)
    return acc
  }, {
    received: 0, acceptedMaterial: 0, rejectedMaterial: 0,
    pendingInspection: 0, machiningInput: 0, acceptedOutput: 0, machiningRejection: 0,
    dispatched: 0, availableMaterial: 0, availableFinished: 0, unaccounted: 0,
  }), [rows])

  /** Parts where material left the plant with nothing recorded behind it. */
  const gaps = useMemo(
    () => rows.filter(r => Number(r.unaccounted_dispatch) > 0)
      .map(r => ({ part: r.part_number, qty: Number(r.unaccounted_dispatch) })),
    [rows],
  )

  const periodActive = Boolean(from || to)

  function exportCsv() {
    const header = [
      'Part number', 'Unit',
      'Declared', 'Received', 'Shortage', 'Excess',
      'Accepted material', 'Rejected material',
      'Machining input', 'Accepted output', 'Machining rejection', 'Rework', 'Scrap',
      'Unit conversion',
      'Dispatched finished stock', 'Dispatched total',
      'Available customer material', 'Available finished stock',
    ]
    const body = rows.map(row => [
      row.part_number, row.unit,
      row.declared_total, row.received_total, row.shortage_total, row.excess_total,
      row.accepted_material, row.rejected_material,
      row.machining_input, row.accepted_output, row.machining_rejection, row.rework_total,
      row.scrap_total, row.unit_conversion ? 'yes' : 'no',
      row.dispatched_finished_stock, row.dispatched_total,
      row.available_customer_material, row.available_finished_stock,
    ])
    if (!rows.length) return
    downloadCsv('customer-material-ledger', buildCsv(header, body))
  }

  const selected = customers.find(c => c.id === customerId)

  return (
    <>
      <PageTitle
        eyebrow="CUSTOMER-WISE TRACKING"
        title="Customer Material Ledger"
        description="Received, accepted, rejected, processed, dispatched and outstanding — as separate quantities, never merged into one balance."
        action={<Button variant="secondary" onClick={exportCsv} disabled={rows.length === 0}><Download size={16} /> CSV</Button>}
      />

      <Card className="dc-card">
        <div className="field-grid">
          <div className="field dc-picker">
            <span>Customer</span>
            {selected ? (
              <div className="dc-picker-selected">
                <div><strong>{selected.name}</strong><small className="mono">{selected.gstin ?? 'No GSTIN'}</small></div>
                <button type="button" aria-label="Change customer" onClick={() => select('')}>Change</button>
              </div>
            ) : (
              <>
                <input value={search} placeholder="Search customers..." onChange={e => setSearch(e.target.value)} />
                {(matches.length > 0 || search.trim()) && (
                  <ul className="dc-picker-results">
                    {matches.length === 0 && <li className="muted">No customer found.</li>}
                    {matches.map(m => (
                      <li key={m.id}><button type="button" onClick={() => select(m.id)}>{m.name}</button></li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
          <SelectField label="Customer (from list)" value={customerId} onChange={e => select(e.target.value)}>
            <option value="">Choose a customer</option>
            {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </SelectField>
          <Field label="Part number" value={part} onChange={e => setPart(e.target.value)} placeholder="All parts" />
          <Field label="From" type="date" value={from} onChange={e => setFrom(e.target.value)} />
          <Field label="To" type="date" value={to} onChange={e => setTo(e.target.value)} />
        </div>
      </Card>

      {!customerId ? (
        <Card className="top-gap">
          <EmptyState
            title="Choose a customer"
            description="Pick a customer to see how their material has moved: what arrived, what was accepted, what was machined, what went back and what is still on site."
          />
        </Card>
      ) : loading ? <Loading label="Loading ledger..." /> : (
        <>
          {error && <p role="alert" className="error-box">{error}</p>}
          <div className="stat-grid dashboard-stats top-gap">
            <Card className="stat"><span>Physically received</span><strong>{qty(totals.received)}</strong></Card>
            <Card className="stat"><span>Accepted material</span><strong>{qty(totals.acceptedMaterial)}</strong></Card>
            <Card className="stat"><span>Rejected material</span><strong>{qty(totals.rejectedMaterial)}</strong></Card>
            <Card className="stat"><span>Awaiting inspection</span><strong>{qty(totals.pendingInspection)}</strong></Card>
            <Card className="stat"><span>Consumed by machining</span><strong>{qty(totals.machiningInput)}</strong></Card>
            <Card className="stat"><span>Accepted output</span><strong>{qty(totals.acceptedOutput)}</strong></Card>
            <Card className="stat"><span>Machining rejection</span><strong>{qty(totals.machiningRejection)}</strong></Card>
            <Card className="stat"><span>Dispatched</span><strong>{qty(totals.dispatched)}</strong></Card>
            <Card className="stat"><span>Customer material available</span><strong>{qty(totals.availableMaterial)}</strong></Card>
            <Card className="stat"><span>Finished stock available</span><strong>{qty(totals.availableFinished)}</strong></Card>
          </div>

          {gaps.length > 0 && (
            <p role="alert" className="error-box">
              <strong>{qty(totals.unaccounted)} went out with nothing recorded behind it.</strong>{' '}
              {gaps.map(g => `${g.part} (${qty(g.qty)})`).join(', ')} — either a machining result was never
              recorded, or no inward receipt exists for this part. The two balances above are floored at zero, so
              they do not show this shortfall themselves.
            </p>
          )}

          {periodActive && (
            <p className="muted top-gap">
              A date range is set, so the <strong>movement columns</strong> cover only that period. The two{' '}
              <strong>available</strong> columns are lifetime balances and deliberately ignore the range — a
              period balance needs an opening figure, and this report does not invent one.
            </p>
          )}

          <Card className="top-gap">
            <div className="section-header">
              <h2>Part-wise material position</h2>
              {customerId && <Link className="text-link" to={`/customers/${customerId}`}>Customer profile →</Link>}
            </div>
            {rows.length === 0 ? (
              <EmptyState title="No material recorded" description={`Nothing has been received or dispatched for this customer${part ? ` for part ${part}` : ''}.`} />
            ) : (
              <div className="table-scroll">
                <table className="dc-ledger-table">
                  <thead>
                    <tr>
                      <th rowSpan={2}>Part</th><th rowSpan={2}>Unit</th>
                      <th colSpan={4} className="group">Receipt</th>
                      <th colSpan={2} className="group">Material acceptance</th>
                      <th colSpan={5} className="group">Processing</th>
                      <th colSpan={2} className="group">Delivery</th>
                      <th colSpan={2} className="group">Available</th>
                    </tr>
                    <tr>
                      <th className="num">Declared</th><th className="num">Received</th>
                      <th className="num">Short</th><th className="num">Excess</th>
                      <th className="num">Accepted</th><th className="num">Rejected</th>
                      <th className="num">Input</th><th className="num">Accepted output</th>
                      <th className="num">Machining rej.</th><th className="num">Rework</th><th className="num">Scrap</th>
                      <th className="num">From finished</th><th className="num">Dispatched</th>
                      <th className="num">Customer material</th><th className="num">Finished stock</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(row => (
                      <tr key={row.part_number}>
                        <td className="table-primary">
                          {row.part_number}{' '}
                          {row.unit_conversion && (
                            <span className="status status-warning" role="img" aria-label="Unit conversion" title="Unit conversion">⚠</span>
                          )}
                        </td>
                        <td>{row.unit}</td>
                        <td className="num">{qty(row.declared_total)}</td>
                        <td className="num">{qty(row.received_total)}</td>
                        <td className="num">{qty(row.shortage_total)}</td>
                        <td className="num">{qty(row.excess_total)}</td>
                        <td className="num strong">{qty(row.accepted_material)}</td>
                        <td className="num">{qty(row.rejected_material)}</td>
                        <td className="num">{qty(row.machining_input)}</td>
                        <td className="num strong">{qty(row.accepted_output)}</td>
                        <td className="num">{qty(row.machining_rejection)}</td>
                        <td className="num">{qty(row.rework_total)}</td>
                        <td className="num">{qty(row.scrap_total)}</td>
                        <td className="num">{qty(row.dispatched_finished_stock)}</td>
                        <td className="num">{qty(row.dispatched_total)}</td>
                        <td className="num strong">{qty(row.available_customer_material)}</td>
                        <td className="num strong">{qty(row.available_finished_stock)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted">
              <strong>Customer material</strong> is raw stock physically at the plant: what inspection accepted,
              less what machining consumed and less what went back unprocessed.{' '}
              <strong>Finished stock</strong> is accepted processing output plus anything received already finished,
              less what has been dispatched. <strong>Dispatched</strong> is the total sent back; the ledger keeps raw
              and finished dispatches separate internally, so each balance is reduced only by the pool it came from.
              The two pools are never subtracted from one another.
            </p>
          </Card>
        </>
      )}
    </>
  )
}