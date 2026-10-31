import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Download } from 'lucide-react'
import { Button, Card, EmptyState, Field, Loading, PageTitle } from '../components/ui'
import { useAuth } from '../lib/auth'
import { dcApi } from '../lib/dc-api'
import { pendingReturn, qty } from '../lib/dc-quantities'
import { challanPath } from '../lib/navigation'
import { describeError, displayDate } from '../lib/format'
import { exportRows, type ReportRow } from './DcOperations'

type Row = ReportRow

type ReportKey =
  | 'inward-register' | 'pending-inspection' | 'material-acceptance' | 'material-rejection'
  | 'shortage-excess' | 'outward-register' | 'pending-delivery'
  | 'machining-rejection' | 'acceptance-rate' | 'rejection-trend' | 'material-balance'

const REPORTS: Array<{ key: ReportKey; label: string; description: string; dateFilter: boolean }> = [
  { key: 'inward-register', label: 'Inward DC register', description: 'Every inward challan with quantities.', dateFilter: true },
  { key: 'pending-inspection', label: 'Pending inspection', description: 'Received lines still awaiting a decision.', dateFilter: true },
  { key: 'material-acceptance', label: 'Material acceptance rate', description: 'Accepted versus rejected, part by part.', dateFilter: true },
  { key: 'material-rejection', label: 'Material rejection report', description: 'Material refused on arrival, with outstanding returns.', dateFilter: true },
  { key: 'shortage-excess', label: 'Shortage, excess and rejection', description: 'Where the receipt did not match the challan, and what was refused.', dateFilter: true },
  { key: 'outward-register', label: 'Outward DC register', description: 'Every outward challan to a customer.', dateFilter: true },
  { key: 'pending-delivery', label: 'Pending customer delivery', description: 'Dispatches not yet confirmed as delivered.', dateFilter: false },
  { key: 'machining-rejection', label: 'Machining rejection report', description: 'Components rejected during processing, with rework and scrap.', dateFilter: true },
  { key: 'acceptance-rate', label: 'Part-wise acceptance rate', description: 'Accepted share of inspected quantity, per part.', dateFilter: true },
  { key: 'rejection-trend', label: 'Rejection trend by month', description: 'Material and machining rejection over time.', dateFilter: false },
  { key: 'material-balance', label: 'Material reconciliation', description: 'Received against accepted, processed and dispatched.', dateFilter: true },
]

/**
 * Reports read the same source rows as the rest of the module. Where a report
 * has no data the screen says so rather than showing zeros that look like a
 * real measurement.
 */
export function DcReports() {
  const { organization } = useAuth()
  const [report, setReport] = useState<ReportKey>('inward-register')
  const [rows, setRows] = useState<Row[]>([])
  const [columns, setColumns] = useState<string[]>([])
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [noHistory, setNoHistory] = useState(false)

  const current = REPORTS.find(r => r.key === report)!

  useEffect(() => {
    if (!organization) return
    let active = true
    setLoading(true); setNoHistory(false); setError('')
    void (async () => {
      try {
        let data: Row[] = []
        switch (report) {
          case 'inward-register': data = (await dcApi.register(organization.id, { dc_type: 'inward', from: from || undefined, to: to || undefined })) as Row[]; break
          case 'outward-register': data = (await dcApi.register(organization.id, { from: from || undefined, to: to || undefined })) as Row[]; break
          case 'pending-inspection': data = (await dcApi.pendingInspection(organization.id, from || undefined, to || undefined)) as Row[]; break
          case 'material-acceptance':
          case 'acceptance-rate': data = (await dcApi.acceptanceRate(organization.id, from || undefined, to || undefined)) as Row[]; break
          case 'material-rejection': data = (await dcApi.materialRejections(organization.id, from || undefined, to || undefined)) as Row[]; break
          case 'shortage-excess': data = (await dcApi.variance(organization.id, from || undefined, to || undefined)) as Row[]; break

          case 'pending-delivery': data = (await dcApi.pendingCustomerDelivery(organization.id)) as Row[]; break
          case 'machining-rejection': data = (await dcApi.machiningRejections(organization.id, from || undefined, to || undefined)) as Row[]; break
          case 'rejection-trend': data = (await dcApi.rejectionTrend(organization.id)) as Row[]; break
          case 'material-balance': data = (await dcApi.acceptanceRate(organization.id, from || undefined, to || undefined)) as Row[]; break
        }
        if (!active) return
        setRows(data)
        setColumns(data.length ? Object.keys(data[0]!) : [])
        // Machining history only exists from the point the module was used.
        if (report === 'machining-rejection' && data.length === 0) setNoHistory(true)
      } catch (cause) {
        if (active) setError(describeError(cause, 'Could not build this report.'))
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [organization, report, from, to])

  return (
    <>
      <PageTitle
        eyebrow="REPORTS"
        title="Delivery Challan Reports"
        description="Inward, outward, quality and reconciliation reporting built from the actual challan records."
      />
      <Card className="dc-card">
        <div className="field-grid">
          <label className="field">
            <span>Report</span>
            <select value={report} onChange={e => setReport(e.target.value as ReportKey)}>
              {REPORTS.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
            <small>{current.description}</small>
          </label>
          {current.dateFilter && <Field label="From" type="date" value={from} onChange={e => setFrom(e.target.value)} />}
          {current.dateFilter && <Field label="To" type="date" value={to} onChange={e => setTo(e.target.value)} />}
        </div>
        <Button variant="secondary" disabled={rows.length === 0} onClick={() => exportRows(rows, `dc-${report}`, columns)}>
          <Download size={16} /> Export CSV
        </Button>
      </Card>

      {error && <p role="alert" className="error-box">{error}</p>}
      {loading ? <Loading label="Building report..." /> : rows.length === 0 ? (
        <Card className="top-gap">
          <EmptyState
            title={noHistory ? 'No historical machining data' : 'No data for this period'}
            description={noHistory
              ? 'Machining results are only recorded from the point this module was used. Earlier production history was never captured and cannot be reconstructed.'
              : 'Widen the date range, or record the transactions this report summarises.'}
            action="Open the DC dashboard"
            href="/dc"
          />
        </Card>
      ) : (
        <Card className="top-gap">
          <div className="section-header">
            <h2>{current.label}</h2>
            <span className="muted">{rows.length} row{rows.length === 1 ? '' : 's'}</span>
          </div>
          <div className="table-scroll">
            <ReportTable report={report} rows={rows} columns={columns} />
          </div>
        </Card>
      )}
    </>
  )
}

/** Each report gets the columns that matter for it, rather than a generic dump. */
function ReportTable({ report, rows, columns }: { report: ReportKey; rows: Row[]; columns: string[] }) {
  const numeric = new Set([
    'line_count', 'total_quantity', 'total_declared', 'received_qty', 'pending_inspection_qty',
    'accepted_qty', 'rejected_qty', 'shortage_qty', 'excess_qty', 'quantity_rejected',
    'quantity_returned', 'quantity_scrapped', 'outstanding', 'accepted_output_quantity',
    'machining_rejection_quantity', 'rework_quantity', 'scrap_quantity', 'process_loss_quantity',
    'accepted_quantity', 'rejected_quantity', 'rework_quantity', 'pending_quantity', 'received_total',
    'accepted_material', 'pending_qty', 'qty_sent', 'returned_qty', 'at_vendor', 'qty_dispatched',
    'acceptance_rate', 'material_rejected', 'machining_rejected', 'material_returned', 'inspected_qty',
  ])

  const humanise = (key: string) =>
    key.replaceAll('_', ' ').replace(/\b\w/g, character => character.toUpperCase())

  const cell = (key: string, value: string | number | boolean | null | undefined) => {
    if (value === null || value === undefined || value === '') return '—'
    if (numeric.has(key)) return qty(Number(value))
    if (typeof value === 'boolean') return value ? 'Yes' : 'No'
    if (/date$/.test(key) && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) return displayDate(String(value))
    return String(value)
  }

  /**
   * The challan a row is about, when the report said which one.
   *
   * A report that prints a real DC number and offers no way to open it is the
   * same defect the rejection and movement screens had: the reader has to note
   * the number down and retype it elsewhere. Every report function now carries
   * the id and the document type, so this is one rule rather than nine.
   *
   * The id columns are kept out of the CSV, which is the operator's record copy
   * and has no use for a uuid.
   */
  const challanLink = (row: Row): { id: string; type: string } | null => {
    const id = row.dc_id ?? row.id ?? row.source_dc_id
    const type = row.dc_type ?? row.source_dc_type
    if (!id || !type) return null
    return { id: String(id), type: String(type) }
  }

  const shown = columns.filter(column => column !== 'id')

  return (
    <table>
      <thead>
        <tr>{shown.map(column => <th key={column} className={numeric.has(column) ? 'num' : ''}>{humanise(column)}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row, index) => {
          const target = challanLink(row)
          return (
            <tr key={index}>
              {shown.map(column => {
                const value = cell(column, row[column])
                const extra =
                  report === 'material-rejection' && column === 'outstanding'
                    ? pendingReturn(Number(row.quantity_rejected), Number(row.quantity_returned), Number(row.quantity_scrapped))
                    : null
                const isChallanNumber = column === 'dc_number' || column === 'source_dc_number'
                return (
                  <td key={column} className={numeric.has(column) ? 'num' : ''}>
                    {isChallanNumber && target ? (
                      <Link className="table-primary" to={challanPath(target.id, target.type)}>{value}</Link>
                    ) : (
                      value
                    )}
                    {extra !== null && extra > 0 && <small className="block muted">{qty(extra)} pending return</small>}
                  </td>
                )
              })}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

export function DcSettingsPage() {
  const { organization } = useAuth()
  const [settings, setSettings] = useState<Array<{ dc_type: string; prefix: string; segment_code: string; padding: number }>>([])
  const [options, setOptions] = useState<Array<{ id: string; option_group: string; option_value: string; is_active: boolean }>>([])
  const [drafts, setDrafts] = useState<Record<string, { prefix: string; segment_code: string; padding: string }>>({})
  const [newOption, setNewOption] = useState({ option_group: 'mot', option_value: '' })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const GROUPS = [
    ['mot', 'Transport modes'],
    ['destination_type', 'Destination types'],
    ['processing_operation', 'Processing operations'],
    ['rejection_reason', 'Rejection reasons'],
    ['disposition', 'Rejection dispositions'],
    ['unit', 'Units of measure'],
    ['receipt_type', 'Material receipt types'],
    ['movement_type', 'Movement types'],
    ['delivery_purpose', 'Delivery purposes'],
  ]

  async function load() {
    if (!organization) return
    try {
      await dcApi.bootstrapOptions()
      const [s, o] = await Promise.all([dcApi.settings(organization.id), dcApi.options(organization.id)])
      setSettings(s as never)
      setOptions(o as never)
      setDrafts(Object.fromEntries(s.map(row => [
        row.dc_type,
        { prefix: row.prefix, segment_code: row.segment_code, padding: String(row.padding) },
      ])))
    } catch (cause) {
      setError(describeError(cause, 'Could not load DC settings.'))
    }
  }

  useEffect(() => { void load() }, [organization])

  async function save(type: string) {
    if (!organization) return
    const draft = drafts[type]
    if (!draft) return
    setBusy(true); setError(''); setMessage('')
    try {
      await dcApi.updateSettings(organization.id, {
        dc_type: type,
        prefix: draft.prefix,
        segment_code: draft.segment_code,
        padding: Number(draft.padding) || 4,
      })
      setMessage('Numbering updated. It applies to the next document allocated.')
      await load()
    } catch (cause) {
      setError(describeError(cause, 'Could not save the numbering settings.'))
    } finally { setBusy(false) }
  }

  async function addOption() {
    if (!organization || !newOption.option_value.trim()) return
    setBusy(true); setError(''); setMessage('')
    try {
      await dcApi.saveOption(organization.id, { ...newOption, is_active: true })
      setNewOption({ option_group: newOption.option_group, option_value: '' })
      setMessage('Option added.')
      await load()
    } catch (cause) {
      setError(describeError(cause, 'Could not add the option.'))
    } finally { setBusy(false) }
  }

  return (
    <>
      <PageTitle
        eyebrow="CONFIGURATION"
        title="DC Settings"
        description="Document numbering and the configurable lists used across the module. Only administrators can change these."
      />
      {error && <p role="alert" className="error-box">{error}</p>}
      {message && <p role="status" className="success-box">{message}</p>}
      {organization?.role !== 'admin' && (
        <Card className="top-gap"><EmptyState title="Administrators only" description="Ask a workspace administrator to change DC settings." /></Card>
      )}

      <Card className="dc-card top-gap">
        <h2>Document numbering</h2>
        <p className="muted">
          Numbers are allocated by a row-locked database sequence and are never reused, including for cancelled documents.
        </p>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Document type</th><th>Prefix</th><th>Segment</th><th>Padding</th><th>Format</th><th /></tr></thead>
            <tbody>
              {settings.map(row => {
                const draft = drafts[row.dc_type] ?? { prefix: row.prefix, segment_code: row.segment_code, padding: String(row.padding) }
                return (
                  <tr key={row.dc_type}>
                    <td className="table-primary">{row.dc_type.replaceAll('_', ' ')}</td>
                    <td><input value={draft.prefix} onChange={e => setDrafts(old => ({ ...old, [row.dc_type]: { ...draft, prefix: e.target.value } }))} aria-label={`Prefix for ${row.dc_type}`} /></td>
                    <td><input value={draft.segment_code} onChange={e => setDrafts(old => ({ ...old, [row.dc_type]: { ...draft, segment_code: e.target.value } }))} aria-label={`Segment for ${row.dc_type}`} /></td>
                    <td><input className="dc-qty-input" type="number" min="1" max="10" value={draft.padding} onChange={e => setDrafts(old => ({ ...old, [row.dc_type]: { ...draft, padding: e.target.value } }))} aria-label={`Padding for ${row.dc_type}`} /></td>
                    <td className="mono">
                      {draft.prefix}/{draft.segment_code}/2026-27/{'0'.repeat(Math.max(1, Number(draft.padding) || 4))}1
                    </td>
                    <td><Button disabled={busy} onClick={() => void save(row.dc_type)}>Save</Button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="dc-card top-gap">
        <h2>Option lists</h2>
        <p className="muted">These replace hardcoded dropdowns. Add what your operation actually uses.</p>
        <div className="dc-return-row">
          <label className="field">
            <span>List</span>
            <select value={newOption.option_group} onChange={e => setNewOption(old => ({ ...old, option_group: e.target.value }))}>
              {GROUPS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <Field label="New value" value={newOption.option_value} onChange={e => setNewOption(old => ({ ...old, option_value: e.target.value }))} />
          <Button disabled={busy || !newOption.option_value.trim()} onClick={() => void addOption()}>Add</Button>
        </div>
        {GROUPS.map(([group, label]) => {
          const values = options.filter(option => option.option_group === group)
          return (
            <div key={group} className="dc-option-group">
              <h3>{label} <span className="muted">({values.length})</span></h3>
              <div className="chip-row">
                {values.length === 0 && <span className="muted">No values configured.</span>}
                {values.map(option => <span key={option.id} className="chip">{option.option_value}</span>)}
              </div>
            </div>
          )
        })}
      </Card>

      <Card className="dc-card top-gap">
        <h2>Where these settings are used</h2>
        <p className="muted">
          Numbering and option lists are per workspace. Party records are shared with Billing Management, so
          a supplier added for a challan is also available as a customer record. See{' '}
          <Link to="/settings">workspace settings</Link>.
        </p>
      </Card>
    </>
  )
}