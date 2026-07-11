import { useState, useEffect, useMemo } from 'react'
import { sb } from '../lib/supabase'
import { C } from '../lib/constants'

const ACTION_STYLE = {
  insert:         { label: 'Added',     color: C.green },
  update:         { label: 'Edited',    color: C.blue },
  sold:           { label: 'Sold',      color: C.green },
  listed:         { label: 'Listed',    color: C.blue },
  ended:          { label: 'Ended',     color: C.muted },
  restocked:      { label: 'Restocked', color: C.accent },
  delete:         { label: 'Deleted',   color: C.red },
  restore:        { label: 'Restored',  color: C.accent },
  member_added:   { label: 'Member +',  color: C.green },
  member_removed: { label: 'Member −',  color: C.red },
  member_updated: { label: 'Access',    color: C.blue },
  sync_nightly:   { label: 'Nightly',   color: C.accent },
  sync_manual:    { label: 'Sync',      color: C.accent },
  sync_live:      { label: 'Live sync', color: C.muted },
  sync:           { label: 'Sync',      color: C.accent }, // legacy rows pre-migration
}
const ACTIONS = Object.entries(ACTION_STYLE).map(([id, v]) => ({ id, label: v.label }))

// Each activity is categorised by the kind of record it touched (its entity).
const CATEGORIES = [
  { id: 'parts',         label: 'Parts' },
  { id: 'cars',          label: 'Cars' },
  { id: 'listings',      label: 'Listings' },
  { id: 'store_members', label: 'Users' },
  { id: 'sync',          label: 'Sync' },
]
const catOf = (r) => (CATEGORIES.some(c => c.id === r.entity_type) ? r.entity_type : 'other')
const PAGE = 300

function Section({ title, action, children }) {
  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, padding: '18px 22px', marginBottom: 16, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, gap: 12, flexWrap: 'wrap' }}>
        {title && <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{title}</div>}
        {action}
      </div>
      {children}
    </div>
  )
}

// Reusable multi-select checkbox dropdown (used for both the Type and Action filters).
function FilterDropdown({ title, items, counts, isEnabled, onToggle, onAll, onNone, open, setOpen, allActive, label }) {
  if (items.length <= 1) return null
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 10px', fontSize: 12, background: allActive ? '#fff' : C.accent + '14', color: C.text, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: allActive ? 400 : 600 }}>
        {title}: {label} <span style={{ opacity: 0.6 }}>▾</span>
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 41, background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: '0 8px 30px rgba(0,0,0,0.15)', minWidth: 190, overflow: 'hidden' }}>
            <div style={{ display: 'flex', gap: 6, padding: '8px 10px', borderBottom: `1px solid ${C.border}` }}>
              <button onClick={onAll} style={{ flex: 1, background: '#f7f7f8', border: `1px solid ${C.border}`, borderRadius: 6, padding: '4px 0', fontSize: 11, cursor: 'pointer', color: C.text }}>Select all</button>
              <button onClick={onNone} style={{ flex: 1, background: '#f7f7f8', border: `1px solid ${C.border}`, borderRadius: 6, padding: '4px 0', fontSize: 11, cursor: 'pointer', color: C.text }}>Clear</button>
            </div>
            {items.map(it => (
              <label key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', fontSize: 13, color: C.text }}>
                <input type="checkbox" checked={isEnabled(it.id)} onChange={() => onToggle(it.id)} style={{ cursor: 'pointer' }} />
                <span style={{ flex: 1 }}>{it.label}</span>
                <span style={{ fontSize: 11, color: C.muted }}>{counts[it.id]}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

export default function Activity({ storeId }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [loadError, setLoadError] = useState(null)
  const [userFilter, setUserFilter] = useState('')
  const [search, setSearch] = useState('')
  // null = show all; otherwise a Set of enabled ids.
  const [enabledCats, setEnabledCats] = useState(null)
  const [enabledActs, setEnabledActs] = useState(null)
  const [catOpen, setCatOpen] = useState(false)
  const [actOpen, setActOpen] = useState(false)

  // Paged fetch. `before` (a changed_at cursor) drives "Load more" so the feed can
  // keep going past the first page instead of stopping at a fixed cap.
  const load = async (term = search, before = null, append = false) => {
    if (append) setLoadingMore(true); else { setLoading(true); setLoadError(null) }
    const { data, error } = await sb.rpc('get_audit_log', { p_store_id: storeId, p_limit: PAGE, p_search: term || null, p_before: before })
    if (error) { setLoadError(error.message || 'Could not load activity'); setLoading(false); setLoadingMore(false); return }
    const list = data || []
    setRows(prev => append ? [...prev, ...list] : list)
    setHasMore(list.length === PAGE)
    setLoading(false); setLoadingMore(false)
  }
  const loadMore = () => { const last = rows[rows.length - 1]; if (last) load(search, last.created_at, true) }

  useEffect(() => { load('') }, [storeId])
  // Debounce server-side search so typing doesn't fire a query per keystroke.
  useEffect(() => {
    const id = setTimeout(() => load(search), 300)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  const users = useMemo(() => [...new Set(rows.map(r => r.user_email).filter(Boolean))], [rows])
  const hasSystem = useMemo(() => rows.some(r => !r.user_email), [rows]) // sync/system events have no user

  // Type (entity) filter — categories present in the current feed, with counts.
  const catCounts = useMemo(() => { const m = {}; for (const r of rows) { const c = catOf(r); m[c] = (m[c] || 0) + 1 } return m }, [rows])
  const presentCats = useMemo(() => { const list = CATEGORIES.filter(c => catCounts[c.id]); if (catCounts.other) list.push({ id: 'other', label: 'Other' }); return list }, [catCounts])
  const catEnabled = (id) => enabledCats == null || enabledCats.has(id)
  const toggleCat = (id) => setEnabledCats(prev => { const base = prev == null ? new Set(presentCats.map(c => c.id)) : new Set(prev); base.has(id) ? base.delete(id) : base.add(id); return presentCats.every(c => base.has(c.id)) ? null : base })
  const enabledCatCount = enabledCats == null ? presentCats.length : presentCats.filter(c => enabledCats.has(c.id)).length
  const catLabel = enabledCats == null ? 'All' : `${enabledCatCount} of ${presentCats.length}`

  // Action filter — added / edited / sold / listed / ended / restocked / …
  const actCounts = useMemo(() => { const m = {}; for (const r of rows) m[r.action] = (m[r.action] || 0) + 1; return m }, [rows])
  const presentActs = useMemo(() => ACTIONS.filter(a => actCounts[a.id]), [actCounts])
  const actEnabled = (id) => enabledActs == null || enabledActs.has(id)
  const toggleAct = (id) => setEnabledActs(prev => { const base = prev == null ? new Set(presentActs.map(a => a.id)) : new Set(prev); base.has(id) ? base.delete(id) : base.add(id); return presentActs.every(a => base.has(a.id)) ? null : base })
  const enabledActCount = enabledActs == null ? presentActs.length : presentActs.filter(a => enabledActs.has(a.id)).length
  const actLabel = enabledActs == null ? 'All' : `${enabledActCount} of ${presentActs.length}`

  const visible = useMemo(() => rows.filter(r =>
    (userFilter === '' || (userFilter === '__system' ? !r.user_email : r.user_email === userFilter)) &&
    catEnabled(catOf(r)) &&
    actEnabled(r.action)
  ), [rows, userFilter, enabledCats, enabledActs, presentCats, presentActs])

  const fmtTime = (t) => {
    const d = new Date(t)
    return d.toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  }

  if (loading) return <div style={{ color: C.muted, padding: 20 }}>Loading…</div>
  if (loadError) {
    const missingFn = /function|p_search|p_before|schema cache|PGRST/i.test(loadError)
    return (
      <Section title="Activity">
        <div style={{ fontSize: 14, color: C.muted }}>
          {missingFn
            ? 'Activity is unavailable until the latest database migration is applied (get_audit_log paging/detail). Once it’s run, this view works again.'
            : `Could not load activity: ${loadError}`}
        </div>
      </Section>
    )
  }

  return (
    <Section title="Activity"
      action={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search activity…"
            style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 12, background: '#fff', width: 160 }} />

          <FilterDropdown title="Type" items={presentCats} counts={catCounts} isEnabled={catEnabled} onToggle={toggleCat}
            onAll={() => setEnabledCats(null)} onNone={() => setEnabledCats(new Set())} open={catOpen} setOpen={setCatOpen}
            allActive={enabledCats == null} label={catLabel} />

          <FilterDropdown title="Action" items={presentActs} counts={actCounts} isEnabled={actEnabled} onToggle={toggleAct}
            onAll={() => setEnabledActs(null)} onNone={() => setEnabledActs(new Set())} open={actOpen} setOpen={setActOpen}
            allActive={enabledActs == null} label={actLabel} />

          {(users.length > 0 || hasSystem) && (
            <select value={userFilter} onChange={e => setUserFilter(e.target.value)}
              style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 12, background: '#fff' }}>
              <option value="">All users</option>
              {hasSystem && <option value="__system">system (sync)</option>}
              {users.map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          )}
          <button onClick={() => load(search)} style={{ background: 'none', border: 'none', color: C.blue, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>↻ Refresh</button>
        </div>
      }>
      {visible.length === 0 ? (
        <div style={{ fontSize: 14, color: C.muted, padding: '12px 0' }}>
          {rows.length === 0 ? 'No activity recorded yet.' : 'No activity matches the current filters.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {visible.map(r => {
            const a = ACTION_STYLE[r.action] || { label: r.action, color: C.muted }
            // Split "part Name — price 50→65 · status listed→sold" into a heading
            // (what/who touched) + the change detail, shown on its own line so the
            // "what changed" is always visible rather than truncated off the end.
            const sep = (r.summary || '').indexOf(' — ')
            const head = sep >= 0 ? r.summary.slice(0, sep) : (r.summary || '')
            const detail = sep >= 0 ? r.summary.slice(sep + 3) : ''
            return (
              <div key={r.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 0', borderBottom: `1px solid ${C.border}` }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: a.color, background: a.color + '18', borderRadius: 6, padding: '3px 8px', minWidth: 64, textAlign: 'center', flexShrink: 0, marginTop: 1 }}>{a.label}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.summary}>{head}</div>
                  {detail && <div style={{ fontSize: 12.5, color: detail === 'background update' ? C.muted : C.accent, marginTop: 2, wordBreak: 'break-word', lineHeight: 1.4 }}>{detail}</div>}
                </div>
                <span style={{ fontSize: 12, color: C.muted, flexShrink: 0, marginTop: 1 }}>{r.user_email || 'system'}</span>
                <span style={{ fontSize: 12, color: C.muted, flexShrink: 0, minWidth: 96, textAlign: 'right', marginTop: 1 }}>{fmtTime(r.created_at)}</span>
              </div>
            )
          })}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, paddingTop: 14 }}>
        <span style={{ fontSize: 12, color: C.muted }}>{visible.length} shown{rows.length !== visible.length ? ` of ${rows.length} loaded` : ''}</span>
        {hasMore && (
          <button onClick={loadMore} disabled={loadingMore}
            style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: '7px 16px', fontSize: 13, fontWeight: 600, background: '#fff', color: C.text, cursor: 'pointer', opacity: loadingMore ? 0.6 : 1 }}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </Section>
  )
}
