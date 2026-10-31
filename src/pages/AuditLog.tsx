import { useEffect, useState } from 'react'
import { useAuth } from '../lib/auth'
import { db } from '../lib/db'
import { settle } from '../lib/async'
import { PageTitle, Card, Loading, Pagination, EmptyState } from '../components/ui'
import { displayDate, friendlyError } from '../lib/format'

type AuditRow = {
  id: string
  organization_id: string
  actor_id: string | null
  action: string
  table_name: string
  record_id: string | null
  old_data: Record<string, unknown> | null
  new_data: Record<string, unknown> | null
  metadata: Record<string, unknown>
  created_at: string
}

const size = 25

export function AuditLog() {
  const { organization } = useAuth()
  const [rows, setRows] = useState<AuditRow[]>([])
  const [page, setPage] = useState(1)
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!organization) return
    let active = true
    setLoading(true)
    const query = db
      .from('audit_logs')
      .select('*', { count: 'exact' })
      .eq('organization_id', organization.id)
      .order('created_at', { ascending: false })
      .range((page - 1) * size, page * size - 1)
    void settle(() => query).then(result => {
        if (!active) return
        if (!result.ok) { setError(friendlyError(result.error)); setLoading(false); return }
        if (result.value.error) { setError(friendlyError(result.value.error)); setLoading(false); return }
        setRows((result.value.data ?? []) as AuditRow[])
        setCount(result.value.count ?? 0)
        setError('')
        setLoading(false)
      })
    return () => { active = false }
  }, [organization, page])

  return (
    <>
      <PageTitle eyebrow="SYSTEM" title="Audit log" description="Append-only trail of changes to your organization records." />
      <Card>
        {error && <p role="alert" className="error-box">{error}</p>}
        {loading ? <Loading label="Loading audit logs..." /> : rows.length === 0 ? (
          <EmptyState title="No audit entries" description="Changes to tracked records will appear here." />
        ) : (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Actor</th>
                    <th>Action</th>
                    <th>Table</th>
                    <th>Record</th>
                    <th>Changes</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const hasDiff = row.old_data && row.new_data
                    return (
                      <tr key={row.id}>
                        <td>{displayDate(row.created_at)} · {new Date(row.created_at).toLocaleTimeString('en-IN')}</td>
                        <td className="mono">{row.actor_id || '—'}</td>
                        <td><span className="status status-warning">{row.action}</span></td>
                        <td>{row.table_name}</td>
                        <td className="mono">{row.record_id?.slice(0, 8) || '—'}</td>
                        <td>{hasDiff ? 'View diff (metadata only in UI)' : JSON.stringify(row.metadata).slice(0, 60)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <Pagination page={page} count={count} size={size} onChange={setPage} />
          </>
        )}
      </Card>
    </>
  )
}
