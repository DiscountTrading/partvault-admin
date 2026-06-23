import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'
import { C } from '../lib/constants'

const ACTION_STYLE = {
  insert:         { label: 'Added',    color: C.green },
  update:         { label: 'Edited',   color: C.blue },
  delete:         { label: 'Deleted',  color: C.red },
  restore:        { label: 'Restored', color: C.accent },
  member_added:   { label: 'Member +', color: C.green },
  member_removed: { label: 'Member −', color: C.red },
  member_updated: { label: 'Access',   color: C.blue },
  sync:           { label: 'Sync',     color: C.accent },
}

function Section({ title, action, children }) {
  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, padding: '18px 22px', marginBottom: 16, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        {title && <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{title}</div>}
        {action}
      </div>
      {children}
    </div>
  )
}

export default function Activity({ storeId }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [userFilter, setUserFilter] = useState('')
  const [search, setSearch] = useState('')

  const load = async (term = search) => {
    setLoading(true); setLoadError(null)
    const { data, error } = await sb.rpc('get_audit_log', { p_store_id: storeId, p_limit: 300, p_search: term || null })
    if (error) { setLoadError(error.message || 'Could not load activity'); setLoading(false); return }
    setRows(data || [])
    setLoading(false)
  }

  useEffect(() => { load('') }, [storeId])
  // Debounce server-side search so typing doesn't fire a query per keystroke.
  useEffect(() => {
    const id = setTimeout(() => load(search), 300)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  const users = [...new Set(rows.map(r => r.user_email).filter(Boolean))]
  const visible = userFilter ? rows.filter(r => r.user_email === userFilter) : rows

  const fmtTime = (t) => {
    const d = new Date(t)
    return d.toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  }

  if (loading) return <div style={{ color: C.muted, padding: 20 }}>Loading…</div>
  if (loadError) {
    const missingFn = /function|p_search|schema cache|PGRST/i.test(loadError)
    return (
      <Section title="Activity">
        <div style={{ fontSize: 14, color: C.muted }}>
          {missingFn
            ? 'Activity is unavailable until the latest database migration is applied (get_audit_log search support). Once it’s run, this view works again.'
            : `Could not load activity: ${loadError}`}
        </div>
      </Section>
    )
  }

  return (
    <Section title="Activity"
      action={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search activity…"
            style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 12, background: '#fff', width: 160 }} />
          {users.length > 0 && (
            <select value={userFilter} onChange={e => setUserFilter(e.target.value)}
              style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 12, background: '#fff' }}>
              <option value="">All users</option>
              {users.map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          )}
          <button onClick={() => load(search)} style={{ background: 'none', border: 'none', color: C.blue, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>↻ Refresh</button>
        </div>
      }>
      {visible.length === 0 ? (
        <div style={{ fontSize: 14, color: C.muted, padding: '12px 0' }}>No activity recorded yet.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {visible.map(r => {
            const a = ACTION_STYLE[r.action] || { label: r.action, color: C.muted }
            return (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: `1px solid ${C.border}` }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: a.color, background: a.color + '18', borderRadius: 6, padding: '3px 8px', minWidth: 64, textAlign: 'center', flexShrink: 0 }}>{a.label}</span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.summary}</span>
                <span style={{ fontSize: 12, color: C.muted, flexShrink: 0 }}>{r.user_email || 'system'}</span>
                <span style={{ fontSize: 12, color: C.muted, flexShrink: 0, minWidth: 96, textAlign: 'right' }}>{fmtTime(r.created_at)}</span>
              </div>
            )
          })}
        </div>
      )}
    </Section>
  )
}
