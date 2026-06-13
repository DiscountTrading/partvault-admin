import { useState, useEffect, useMemo } from 'react'
import { sb } from '../lib/supabase'
import { C, S, fmt } from '../lib/constants'

const DEAD_DAYS = 90
const DEAD_MARGIN = 10

const SEGMENTS = [
  { id: 'all', label: 'All stock' },
  { id: 'best', label: '💰 Best performers' },
  { id: 'fast', label: '⚡ Fast movers' },
  { id: 'slow', label: '🐌 Slow movers' },
  { id: 'dead', label: '🪦 Dead stock' },
]

// Column definitions drive both the table and the per-column filters.
const COLS = [
  { key: 'sku', label: 'SKU', type: 'text', align: 'left', w: 120 },
  { key: 'title', label: 'Title', type: 'text', align: 'left', w: 300 },
  { key: 'status', label: 'Status', type: 'status', align: 'left', w: 105 },
  { key: 'days_on_shelf', label: 'On shelf', type: 'range', align: 'right', unit: 'd', w: 105 },
  { key: 'listing_count', label: '# Listed', type: 'range', align: 'right', w: 95 },
  { key: 'total_days_listed', label: 'Days listed', type: 'range', align: 'right', unit: 'd', w: 110 },
  { key: 'total_cost', label: 'Cost', type: 'range', align: 'right', fmt: 'money', w: 95 },
  { key: 'list_price', label: 'Price', type: 'range', align: 'right', fmt: 'money', w: 95 },
  { key: 'profit', label: 'Profit', type: 'range', align: 'right', fmt: 'money', w: 100 },
  { key: 'margin_pct', label: 'Margin', type: 'range', align: 'right', fmt: 'pct', w: 95 },
]

const fieldVal = (r, key) => key === 'profit' ? (r.realized_profit != null ? r.realized_profit : r.potential_profit) : r[key]
const isUnsold = r => r.status !== 'sold' && r.status !== 'scrapped'
const isDead = r => isUnsold(r) && r.days_on_shelf > DEAD_DAYS && (r.margin_pct == null || r.margin_pct <= DEAD_MARGIN)

const money = v => (v == null ? '—' : fmt(v))
const RENDER_CAP = 250

function FunnelIcon({ active }) {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" style={{ display: 'block' }}>
      <path d="M1 2h14l-5.5 6.5V14L6.5 12V8.5L1 2z" fill={active ? C.accent : 'none'} stroke={active ? C.accent : C.muted} strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  )
}

function Card({ label, value, sub }) {
  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 12, padding: '14px 18px', flex: '1 1 160px', minWidth: 150 }}>
      <div style={{ fontSize: 12, color: C.muted, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: C.text, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

export default function Insights({ storeId }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [segment, setSegment] = useState('all')
  const [filters, setFilters] = useState({})        // colKey -> value (string | {min,max})
  const [openFilter, setOpenFilter] = useState(null) // colKey whose popover is open
  const [sort, setSort] = useState({ key: 'days_on_shelf', dir: 'desc' })
  const [views, setViews] = useState([])
  const [meId, setMeId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [viewName, setViewName] = useState('')

  useEffect(() => {
    if (!storeId) return
    setLoading(true)
    sb.auth.getUser().then(({ data: { user } }) => setMeId(user?.id || null))
    sb.from('part_insights').select('*').eq('store_id', storeId).then(({ data }) => { setRows(data || []); setLoading(false) })
    loadViews()
  }, [storeId])

  const loadViews = () => sb.from('saved_views').select('*').eq('store_id', storeId).order('name').then(({ data }) => setViews(data || []))

  const statuses = useMemo(() => [...new Set(rows.map(r => r.status).filter(Boolean))].sort(), [rows])

  const active = (key) => {
    const f = filters[key]
    if (f == null) return false
    if (typeof f === 'object') return f.min !== '' && f.min != null || f.max !== '' && f.max != null
    return f !== ''
  }
  const anyFilter = COLS.some(c => active(c.key))

  const summary = useMemo(() => {
    const unsold = rows.filter(isUnsold)
    const sold = rows.filter(r => r.status === 'sold')
    const stockValue = unsold.reduce((a, r) => a + (+r.list_price || 0), 0)
    const margins = unsold.map(r => r.margin_pct).filter(v => v != null)
    const dts = sold.map(r => r.days_to_sell).filter(v => v != null)
    return {
      stockValue,
      avgMargin: margins.length ? Math.round(margins.reduce((a, v) => a + v, 0) / margins.length * 10) / 10 : null,
      avgDts: dts.length ? Math.round(dts.reduce((a, v) => a + v, 0) / dts.length) : null,
      deadCount: rows.filter(isDead).length,
      unsoldCount: unsold.length,
    }
  }, [rows])

  const segmented = useMemo(() => {
    switch (segment) {
      case 'best': return rows.filter(r => r.status === 'sold')
      case 'fast': return rows.filter(r => r.days_to_sell != null)
      case 'slow': return rows.filter(r => isUnsold(r) && r.listing_count > 0)
      case 'dead': return rows.filter(isDead)
      default: return rows
    }
  }, [rows, segment])

  const visible = useMemo(() => {
    let list = segmented
    for (const col of COLS) {
      const f = filters[col.key]
      if (!active(col.key)) continue
      if (col.type === 'text') { const s = f.toLowerCase(); list = list.filter(r => (r[col.key] || '').toLowerCase().includes(s)) }
      else if (col.type === 'status') { list = list.filter(r => r.status === f) }
      else if (col.type === 'range') {
        const mn = f.min === '' || f.min == null ? null : Number(f.min)
        const mx = f.max === '' || f.max == null ? null : Number(f.max)
        if (mn != null && !Number.isNaN(mn)) list = list.filter(r => { const v = fieldVal(r, col.key); return v != null && v >= mn })
        if (mx != null && !Number.isNaN(mx)) list = list.filter(r => { const v = fieldVal(r, col.key); return v != null && v <= mx })
      }
    }
    const { key, dir } = sort
    return [...list].sort((a, b) => {
      const av = fieldVal(a, key), bv = fieldVal(b, key)
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      return dir === 'asc' ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1)
    })
  }, [segmented, filters, sort])

  const shown = visible.slice(0, RENDER_CAP)

  const toggleSort = (key) => setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' })
  const setFilter = (key, val) => setFilters(f => ({ ...f, [key]: val }))
  const clearFilter = (key) => { setFilters(f => { const n = { ...f }; delete n[key]; return n }); setOpenFilter(null) }
  const removeAll = () => { setFilters({}); setOpenFilter(null) }

  const applyView = (id) => {
    const v = views.find(x => x.id === id)
    if (!v) return
    const cfg = v.config || {}
    setSegment(cfg.segment || 'all')
    setFilters(cfg.filters || {})
    setSort(cfg.sort || { key: 'days_on_shelf', dir: 'desc' })
  }
  const saveView = async () => {
    const name = viewName.trim()
    if (!name || !meId) return
    setSaving(true)
    const config = { segment, filters, sort }
    const { error } = await sb.from('saved_views').insert({ user_id: meId, store_id: storeId, name, config })
    setSaving(false)
    if (!error) { setViewName(''); loadViews() }
  }
  const deleteView = async (id) => {
    if (!confirm('Delete this saved view?')) return
    await sb.from('saved_views').delete().eq('id', id)
    loadViews()
  }

  const cell = (r, col) => {
    const v = fieldVal(r, col.key)
    if (col.fmt === 'money') return money(v)
    if (col.fmt === 'pct') return v == null ? '—' : `${v}%`
    if (col.unit) return `${v ?? 0}${col.unit}`
    return v ?? ''
  }

  return (
    <div>
      <h2 style={{ ...S.h1, marginBottom: 4 }}>Stock Insights</h2>
      <div style={{ fontSize: 13, color: C.muted, marginBottom: 16 }}>What's making money, what's moving, and what's clogging the shelves.</div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <Card label="Stock on hand" value={money(summary.stockValue)} sub={`${summary.unsoldCount} unsold parts`} />
        <Card label="Avg margin (unsold)" value={summary.avgMargin == null ? '—' : `${summary.avgMargin}%`} />
        <Card label="Avg days to sell" value={summary.avgDts != null ? `${summary.avgDts}d` : '—'} />
        <Card label="Dead stock" value={summary.deadCount} sub={`>${DEAD_DAYS}d & ≤${DEAD_MARGIN}% margin`} />
      </div>

      {/* Segments + saved views */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        {SEGMENTS.map(s => (
          <button key={s.id} onClick={() => setSegment(s.id)}
            style={{ padding: '7px 14px', borderRadius: 20, border: `1.5px solid ${segment === s.id ? C.accent : C.border}`, background: segment === s.id ? C.accent : '#fff', color: segment === s.id ? '#fff' : C.muted, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            {s.label}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        {anyFilter && <button onClick={removeAll} style={{ ...S.btn('secondary'), padding: '7px 12px', fontSize: 12 }}>✕ Remove all filters</button>}
        {views.length > 0 && (
          <select onChange={e => { if (e.target.value) applyView(e.target.value) }} defaultValue=""
            style={{ ...S.input, marginBottom: 0, padding: '7px 10px', width: 'auto' }}>
            <option value="">Saved views…</option>
            {views.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        )}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input value={viewName} onChange={e => setViewName(e.target.value)} placeholder="Save view as…" onKeyDown={e => e.key === 'Enter' && saveView()}
            style={{ ...S.input, marginBottom: 0, padding: '7px 10px', width: 130 }} />
          <button onClick={saveView} disabled={saving || !viewName.trim()} style={{ ...S.btn('primary'), padding: '7px 12px', fontSize: 12, opacity: (saving || !viewName.trim()) ? 0.6 : 1 }}>Save</button>
        </div>
      </div>

      {loading ? <div style={{ color: C.muted, padding: 20 }}>Loading…</div> : (
        <div style={{ overflowX: 'auto', background: '#fff', border: `1px solid ${C.border}`, borderRadius: 12 }}>
          <table style={{ width: '100%', minWidth: 1100, borderCollapse: 'collapse', fontSize: 13, tableLayout: 'fixed' }}>
            <colgroup>{COLS.map(c => <col key={c.key} style={{ width: c.w }} />)}</colgroup>
            <thead>
              <tr style={{ borderBottom: `2px solid ${C.border}` }}>
                {COLS.map(col => (
                  <th key={col.key} style={{ textAlign: 'left', padding: '9px 12px', color: C.muted, fontWeight: 700, fontSize: 11, whiteSpace: 'nowrap', position: 'relative' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                      <span onClick={() => toggleSort(col.key)} style={{ cursor: 'pointer', userSelect: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, overflow: 'hidden' }}>
                        <span style={{ width: 9, flexShrink: 0, display: 'inline-block', fontSize: 10, color: sort.key === col.key ? C.text : '#cbd5e1' }}>
                          {sort.key === col.key ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
                        </span>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{col.label}</span>
                      </span>
                      <button onClick={() => setOpenFilter(o => o === col.key ? null : col.key)}
                        style={{ background: 'none', border: 'none', padding: 2, cursor: 'pointer', lineHeight: 0 }} title="Filter">
                        <FunnelIcon active={active(col.key)} />
                      </button>
                    </div>
                    {openFilter === col.key && (
                      <>
                        <div onClick={() => setOpenFilter(null)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
                        <div style={{ position: 'absolute', top: '100%', right: 8, marginTop: 4, zIndex: 41, background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: '0 8px 30px rgba(0,0,0,0.15)', padding: 12, minWidth: 180 }}>
                          {col.type === 'text' && (
                            <div>
                              <input autoFocus value={filters[col.key] || ''} onChange={e => setFilter(col.key, e.target.value)} onKeyDown={e => e.key === 'Enter' && setOpenFilter(null)}
                                placeholder={`Contains…`} style={{ ...S.input, marginBottom: 8, fontSize: 13 }} />
                              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                                <button onClick={() => clearFilter(col.key)} style={{ ...S.btn('secondary'), padding: '5px 10px', fontSize: 12 }}>Clear</button>
                                <button onClick={() => setOpenFilter(null)} style={{ ...S.btn('primary'), padding: '5px 10px', fontSize: 12 }}>Apply</button>
                              </div>
                            </div>
                          )}
                          {col.type === 'status' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <button onClick={() => clearFilter(col.key)} style={{ textAlign: 'left', background: !active(col.key) ? '#fff4ef' : '#fff', border: 'none', padding: '7px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600, color: C.text }}>All</button>
                              {statuses.map(s => (
                                <button key={s} onClick={() => { setFilter(col.key, s); setOpenFilter(null) }}
                                  style={{ textAlign: 'left', background: filters[col.key] === s ? '#fff4ef' : '#fff', border: 'none', padding: '7px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 13, color: C.text }}>{s}</button>
                              ))}
                            </div>
                          )}
                          {col.type === 'range' && (
                            <div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                                <input type="number" autoFocus value={filters[col.key]?.min ?? ''} onChange={e => setFilter(col.key, { ...filters[col.key], min: e.target.value })}
                                  placeholder="min" style={{ ...S.input, marginBottom: 0, width: 64, padding: '6px 8px', fontSize: 13 }} />
                                <span style={{ color: C.muted }}>–</span>
                                <input type="number" value={filters[col.key]?.max ?? ''} onChange={e => setFilter(col.key, { ...filters[col.key], max: e.target.value })}
                                  placeholder="max" style={{ ...S.input, marginBottom: 0, width: 64, padding: '6px 8px', fontSize: 13 }} />
                              </div>
                              <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>Blank = no limit</div>
                              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                                <button onClick={() => clearFilter(col.key)} style={{ ...S.btn('secondary'), padding: '5px 10px', fontSize: 12 }}>Clear</button>
                                <button onClick={() => setOpenFilter(null)} style={{ ...S.btn('primary'), padding: '5px 10px', fontSize: 12 }}>Apply</button>
                              </div>
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr><td colSpan={COLS.length} style={{ padding: 24, textAlign: 'center', color: C.muted }}>No parts in this view.</td></tr>
              ) : shown.map(r => (
                <tr key={r.part_id} style={{ borderBottom: `1px solid ${C.border}`, background: isDead(r) ? '#fff7ed' : '#fff' }}>
                  {COLS.map(col => (
                    <td key={col.key} style={{ textAlign: col.align, padding: '9px 12px', color: C.text, whiteSpace: col.key === 'title' ? 'normal' : 'nowrap', maxWidth: col.key === 'title' ? 280 : undefined, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {cell(r, col)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: C.muted }}>
          {visible.length > RENDER_CAP ? `Showing top ${RENDER_CAP} of ${visible.length} matching` : `Showing ${visible.length}`} (of {rows.length} parts). Promotion & ad metrics arrive with the eBay Marketing API.
        </span>
        {views.length > 0 && openFilter == null && (
          <span style={{ fontSize: 11, color: C.muted }}>
            {views.map(v => (
              <span key={v.id} style={{ marginLeft: 8 }}>{v.name} <button onClick={() => deleteView(v.id)} style={{ background: 'none', border: 'none', color: C.red, cursor: 'pointer', fontSize: 11 }}>✕</button></span>
            ))}
          </span>
        )}
      </div>
    </div>
  )
}
