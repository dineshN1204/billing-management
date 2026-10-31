import { useState } from 'react'
import { AlertTriangle, Check, Download } from 'lucide-react'
import { PageTitle, Card, Button, Loading, EmptyState } from '../components/ui'
import { useAuth } from '../lib/auth'
import { downloadCsv } from '../lib/csv'
import { friendlyError } from '../lib/format'
import { buildTemplateCsv, parseCsv } from '../lib/import-csv'
import { groupRows, runImport, type ImportIssue } from '../lib/import-bills'

/** Matches the 10 MB limit the attachment uploader already enforces. */
const MAX_BYTES = 10 * 1024 * 1024

type Phase = 'idle' | 'checking' | 'ready' | 'running' | 'done'

export function Import() {
  const { organization } = useAuth()
  const [file, setFile] = useState<File | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [busy, setBusy] = useState(false)
  const [dryRun, setDryRun] = useState(true)
  const [error, setError] = useState('')
  const [problems, setProblems] = useState<string[]>([])
  const [invalid, setInvalid] = useState<ImportIssue[]>([])
  const [billCount, setBillCount] = useState(0)
  const [result, setResult] = useState<{ imported: number; rejected: ImportIssue[]; customersCreated: number; invalidRows: number } | null>(null)

  if (organization?.role === 'viewer') {
    return (
      <>
        <PageTitle eyebrow="DATA" title="Import" description="You don't have permission to import data." />
        <Card className="detail-card"><p className="muted">The read-only role cannot create records, including by import.</p></Card>
      </>
    )
  }

  async function choose(picked: File | null) {
    setFile(picked)
    setResult(null)
    setInvalid([])
    setProblems([])
    setError('')
    if (!picked) { setPhase('idle'); return }

    if (picked.size > MAX_BYTES) {
      setError(`That file is ${(picked.size / 1024 / 1024).toFixed(1)} MB. The limit is 10 MB.`)
      setPhase('idle')
      return
    }
    if (!/\.(csv|txt)$/i.test(picked.name)) {
      setError('Only .csv files can be imported. If this is an Excel workbook, save it as CSV first (File → Save As → CSV).')
      setPhase('idle')
      return
    }

    setPhase('checking')
    const text = await picked.text()
    const parsed = parseCsv(text)
    const grouped = groupRows(parsed.rows)

    setProblems(parsed.problems)
    setInvalid(grouped.invalid)
    setBillCount(grouped.bills.length)

    if (grouped.bills.length === 0 && grouped.invalid.length === 0) {
      setError('No usable rows were found in that file.')
      setPhase('idle')
      return
    }
    setPhase('ready')
  }

  async function start() {
    if (!organization || !file || busy) return
    setBusy(true); setError(''); setPhase('running')
    try {
      const parsed = parseCsv(await file.text())
      const grouped = groupRows(parsed.rows)
      const outcome = await runImport(organization.id, grouped.bills, grouped.invalid, dryRun)
      setInvalid(outcome.invalid)
      setResult({
        imported: outcome.imported,
        rejected: outcome.rejected,
        customersCreated: outcome.customersCreated,
        invalidRows: outcome.invalid.length,
      })
      setPhase('done')
    } catch (cause) {
      setError(friendlyError(cause))
      setPhase('ready')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageTitle
        eyebrow="DATA"
        title="Import bills from a spreadsheet"
        description="Rows are grouped by bill number into invoices, and each bill is saved through the same checks as manual entry."
      />

      <Card className="detail-card top-gap">
        <div className="section-heading">
          <span className="section-number">1</span>
          <div>
            <h2>Get the template</h2>
            <p>One row per line item. Rows sharing a bill number become one invoice with several lines.</p>
          </div>
        </div>
        <Button variant="secondary" onClick={() => downloadCsv('bill-import-template', buildTemplateCsv())}>
          <Download size={16} /> Download template (.csv)
        </Button>
      </Card>

      <Card className="detail-card top-gap">
        <div className="section-heading">
          <span className="section-number">2</span>
          <div>
            <h2>Choose your file</h2>
            <p>CSV only, up to 10 MB. Columns are matched by name, so "Bill No.", "bill_number" and "Invoice No" all work.</p>
          </div>
        </div>

        <div className="dropzone" style={{ minHeight: 180 }}>
          <h2>Select a CSV file</h2>
          <p>Accepted: .csv (max 10MB)</p>
          <label className="button button-primary upload-label">
            {phase === 'checking' ? 'Checking...' : file ? 'Choose a different file' : 'Select file'}
            <input
              type="file"
              accept=".csv,text/csv"
              disabled={busy}
              onChange={(e) => void choose(e.target.files?.[0] ?? null)}
            />
          </label>
          {file && <p className="muted">{file.name} · {(file.size / 1024).toFixed(0)} KB</p>}
          {phase === 'checking' && <Loading label="Reading the file..." />}
          {error && <p role="alert" className="error-box top-gap">{error}</p>}
        </div>
      </Card>

      {problems.length > 0 && (
        <Card className="detail-card top-gap">
          <h2>Notes about this file</h2>
          <ul className="plain-list">
            {problems.map(problem => <li key={problem}>{problem}</li>)}
          </ul>
        </Card>
      )}

      {invalid.length > 0 && (
        <Card className="detail-card top-gap">
          <h2><AlertTriangle size={18} /> {invalid.length} row{invalid.length === 1 ? '' : 's'} cannot be imported</h2>
          <p className="muted">These rows will be skipped. Everything else imports normally.</p>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Row</th><th>Bill</th><th>Problem</th></tr></thead>
              <tbody>
                {invalid.slice(0, 100).map((issue, index) => (
                  <tr key={`${issue.row}-${index}`}>
                    <td>{issue.row || '—'}</td>
                    <td className="table-primary">{issue.bill}</td>
                    <td>{issue.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {invalid.length > 100 && <p className="muted top-gap">...and {invalid.length - 100} more.</p>}
        </Card>
      )}

      {(phase === 'ready' || phase === 'running' || phase === 'done') && !result && (
        <Card className="detail-card top-gap">
          <div className="section-heading">
            <span className="section-number">3</span>
            <div>
              <h2>Review and import</h2>
              <p>
                {billCount} bill{billCount === 1 ? '' : 's'} found
                {invalid.length > 0 && `, ${invalid.length} row${invalid.length === 1 ? '' : 's'} skipped`}.
              </p>
            </div>
          </div>

          <div className="capture-dropzone" style={{ marginBottom: 16 }}>
            <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <input
                type="checkbox"
                checked={dryRun}
                onChange={(e) => setDryRun(e.target.checked)}
                style={{ width: 18, height: 18 }}
              />
              <span>
                <strong>Check only — do not save anything</strong>
                <small style={{ display: 'block' }}>
                  Recommended first. Reports what would be created, including customers that do not exist yet and
                  bills the database would refuse as duplicates.
                </small>
              </span>
            </label>
          </div>

          <Button disabled={busy || billCount === 0} onClick={() => void start()}>
            {busy ? 'Working...' : dryRun ? `Check ${billCount} bill${billCount === 1 ? '' : 's'}` : `Import ${billCount} bill${billCount === 1 ? '' : 's'}`}
          </Button>
        </Card>
      )}

      {result && (
        <Card className="detail-card top-gap">
          <div className="section-heading">
            <span className="section-number"><Check size={16} /></span>
            <div>
              <h2>{dryRun ? 'Check complete — nothing was saved' : 'Import finished'}</h2>
              <p>
                {dryRun
                  ? 'Remove the tick above "Check only" and run it again to actually create these bills.'
                  : `${result.imported} bill${result.imported === 1 ? '' : 's'} created.`}
              </p>
            </div>
          </div>

          <dl className="detail-list">
            <dt>{dryRun ? 'Would create' : 'Created'}</dt><dd><strong>{result.imported}</strong> bills</dd>
            <dt>Skipped rows</dt><dd>{result.invalidRows}</dd>
            <dt>Refused by the database</dt><dd>{result.rejected.length}</dd>
          </dl>

          {result.rejected.length > 0 && (
            <>
              <h3 className="top-gap">Bills that were not created</h3>
              <div className="table-scroll">
                <table>
                  <thead><tr><th>Bill</th><th>Reason</th></tr></thead>
                  <tbody>
                    {result.rejected.map((issue, index) => (
                      <tr key={`${issue.bill}-${index}`}>
                        <td className="table-primary">{issue.bill}</td>
                        <td>{issue.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {!dryRun && (
            <div className="form-actions">
              <Button onClick={() => { setFile(null); setResult(null); setPhase('idle'); setInvalid([]); setProblems([]) }}>
                Import another file
              </Button>
            </div>
          )}
        </Card>
      )}

      {phase === 'idle' && !file && (
        <Card className="detail-card top-gap">
          <EmptyState
            title="No file chosen yet"
            description="Download the template above, fill it in from your existing records, then choose the file here."
          />
        </Card>
      )}

      <Card className="detail-card top-gap">
        <h2>What the import does and does not do</h2>
        <ul className="plain-list">
          <li>Each bill is created through the same <code className="mono">save_bill</code> call as manual entry, so tax calculation, validation, duplicate detection and the audit trail are identical.</li>
          <li>Customers are matched by GSTIN first, then by exact name. A customer with a GSTIN that does not exist yet is created automatically and marked for review.</li>
          <li>A customer with no GSTIN is never created automatically — a sheet with inconsistent spellings would otherwise produce several near-identical customers.</li>
          <li>Rows whose bill number, date or customer disagree with an earlier row of the same bill are rejected rather than silently merged.</li>
          <li>Imported bills are marked <strong>intra-state</strong> by default. Check any that belong outside Tamil Nadu and change them after import.</li>
          <li>Payment status is carried across, but no payment amounts exist in this system yet, so a partial payment still shows the full amount outstanding.</li>
        </ul>
      </Card>
    </>
  )
}