import { useState, useEffect, useMemo } from 'react'
import { sb } from '../lib/supabase'
import { C, S, fmt } from '../lib/constants'

const DEAD_DAYS = 90        // on shelf longer than this…
const DEAD_MARGIN = 10      // …and margin at/under this % = dead stock

const SEGMENTS = [
  { id: 'all',   label: 'All stock' },
  { id: 'best',  label: '💰 Best performers' },
  { id: 'fast',  label: '⚡ Fast movers' },
  { id: 'slow',  label: '🐌 Slow movers' },
  { id: 'dead',  label: '🪦 Dead stock' },
]

// Numeric metrics that support a min–max range filter (blank = unbounded)
const RANGE_FIELDS = [
  ['days_on_shelf', 'On shelf (days)'],
  ['listing_count', '# Listed'],
  ['total_days_listed', 'Days listed'],
  ['margin_pct', 'Margin %'],
  ['profit', 'Profit $'],
]
const fieldVal = (r, key) => key === 'profit' ? (r.realized_profit != null ? r.realized_profit : r.potential_profit) : r[key]

const isUnsold = r => r.status !== 'sold' && r.status !== 'scrapped'
const isDead = r => isUnsold(r) && r.days_on_shelf > DEAD_DAYS && (r.margin_pct == null || r.margin_pct <= DEAD_MARGIN)

const money = v => (v == null ? '—' : fmt(v))
const pct = v => (v == null ? '—' : `${v}%`)

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
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [ranges, setRanges] = useState({})       // metric key -> { min, max }
  const [showFilters, setShowFilters] = useState(false)
  const [sort, setSort] = useState({ key: 'days_on_shelf', dir: 'desc' })

  useEffect(() => {
    if (!storeId) return
    setLoading(true)
    sb.from('part_insights').select('*').eq('store_id', storeId).then(({ data }) => {
      setRows(data || [])
      setLoading(false)
    })
  }, [storeId])

  // Summary across the whole catalogue
  const summary = useMemo(() => {
    const unsold = rows.filter(isUnsold)
    const sold = rows.filter(r => r.status === 'sold')
    const stockValue = unsold.reduce((a, r) => a + (+r.list_price || 0), 0)
    const margins = unsold.map(r => r.margin_pct).filter(v => v != null)
    const avgMargin = margins.length ? margins.reduce((a, v) => a + v, 0) / margins.length : null
    const dtsArr = sold.map(r => r.days_to_sell).filter(v => v != null)
    const avgDts = dtsArr.length ? Math.round(dtsArr.reduce((a, v) => a + v, 0) / dtsArr.length) : null
    return {
      stockValue, avgMargin, avgDts,
      deadCount: rows.filter(isDead).length,
      unsoldCount: unsold.length,
    }
  }, [rows])

  // Apply the active segment (preset filter + default sort)
  const segmented = useMemo(() => {
    switch (segment) {
      case 'best': return { list: rows.filter(r => r.status === 'sold'), defaultSort: { key: 'realized_profit', dir: 'desc' } }
      case 'fast': return { list: rows.filter(r => r.days_to_sell != null), defaultSort: { key: 'days_to_sell', dir: 'asc' } }
      case 'slow': return { list: rows.filter(r => isUnsold(r) && r.listing_count > 0), defaultSort: { key: 'days_on_shelf', dir: 'desc' } }
      case 'dead': return { list: rows.filter(isDead), defaultSort: { key: 'days_on_shelf', dir: 'desc' } }
      default:     return { list: rows, defaultSort: { key: 'days_on_shelf', dir: 'desc' } }
    }
  }, [rows, segment])

  const pickSegment = (id) => {
    setSegment(id)
    const def = { best: { key: 'realized_profit', dir: 'desc' }, fast: { key: 'days_to_sell', dir: 'asc' }, slow: { key: 'days_on_shelf', dir: 'desc' }, dead: { key: 'days_on_shelf', dir: 'desc' } }[id]
    if (def) setSort(def)
  }

  const statuses = useMemo(() => [...new Set(rows.map(r => r.status).filter(Boolean))].sort(), [rows])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list = segmented.list
    if (q) list = list.filter(r => [r.sku, r.title, r.make, r.model].some(v => (v || '').toLowerCase().includes(q)))
    if (statusFilter !== 'all') list = list.filter(r => r.status === statusFilter)
    for (const [key] of RANGE_FIELDS) {
      const rg = ranges[key]
      if (!rg) continue
      const mn = rg.min === '' || rg.min == null ? null : Number(rg.min)
      const mx = rg.max === '' || rg.max == null ? null : Number(rg.max)
      if (mn != null && !Number.isNaN(mn)) list = list.filter(r => { const v = fieldVal(r, key); return v != null && v >= mn })
      if (mx != null && !Number.isNaN(mx)) list = list.filter(r => { const v = fieldVal(r, key); return v != null && v <= mx })
    }
    const { key, dir } = sort
    return [...list].sort((a, b) => {
      const av = a[key], bv = b[key]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      return dir === 'asc' ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1)
    })
  }, [segmented, search, statusFilter, ranges, sort])

  const setRange = (key, bound, val) => setRanges(rs => ({ ...rs, [key]: { ...rs[key], [bound]: val } }))
  const anyFilter = statusFilter !== 'all' || search || RANGE_FIELDS.some(([k]) => ranges[k] && (ranges[k].min || ranges[k].max))
  const clearFilters = () => { setStatusFilter('all'); setSearch(''); setRanges({}) }

  const toggleSort = (key) => setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' })

  const RENDER_CAP = 250
  const shown = visible.slice(0, RENDER_CAP)

  const COLS = [
    ['sku', 'SKU', false], ['title', 'Title', false], ['status', 'Status', false],
    ['days_on_shelf', 'On shelf', true], ['listing_count', '# Listed', true],
    ['total_days_listed', 'Days listed', true], ['total_cost', 'Cost', true],
    ['list_price', 'Price', true], ['realized_profit', 'Profit', true], ['margin_pct', 'Margin', true],
  ]

  const cell = (r, key) => {
    switch (key) {
      case 'total_cost': return money(r.total_cost)
      case 'list_price': return money(r.list_price)
      case 'realized_profit': return money(r.realized_profit != null ? r.realized_profit : r.potential_profit)
      case 'margin_pct': return pct(r.margin_pct)
      case 'days_on_shelf': return `${r.days_on_shelf}d`
      case 'total_days_listed': return `${r.total_days_listed}d`
      case 'status': return r.status
      case 'title': return r.title
      case 'sku': return r.sku
      default: return r[key]
    }
  }

  return (
    <div>
      <h2 style={{ ...S.h1, marginBottom: 4 }}>Stock Insights</h2>
      <div style={{ fontSize: 13, color: C.muted, marginBottom: 16 }}>What's making money, what's moving, and what's clogging the shelves.</div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <Card label="Stock on hand" value={money(summary.stockValue)} sub={`${summary.unsoldCount} unsold parts`} />
        <Card label="Avg margin (unsold)" value={pct(summary.avgMargin != null ? Math.round(summary.avgMargin * 10) / 10 : null)} />
        <Card label="Avg days to sell" value={summary.avgDts != null ? `${summary.avgDts}d` : '—'} />
        <Card label="Dead stock" value={summary.deadCount} sub={`>${DEAD_DAYS}d & ≤${DEAD_MARGIN}% margin`} />
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {SEGMENTS.map(s => (
          <button key={s.id} onClick={() => pickSegment(s.id)}
            style={{ padding: '7px 14px', borderRadius: 20, border: `1.5px solid ${segment === s.id ? C.accent : C.border}`, background: segment === s.id ? C.accent : '#fff', color: segment === s.id ? '#fff' : C.muted, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            {s.label}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search SKU, title, make, model…"
          style={{ ...S.input, flex: '1 1 260px', minWidth: 0, marginBottom: 0 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <label style={{ fontSize: 12, color: C.muted, fontWeight: 600 }}>Status</label>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
            style={{ ...S.input, marginBottom: 0, padding: '8px 10px', width: 'auto' }}>
            <option value="all">All</option>
            {statuses.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <button onClick={() => setShowFilters(f => !f)}
          style={{ ...S.btn('secondary'), padding: '8px 12px', fontSize: 13 }}>Filters {showFilters ? '▴' : '▾'}</button>
        {anyFilter && (
          <button onClick={clearFilters} style={{ ...S.btn('secondary'), padding: '8px 12px', fontSize: 12 }}>Clear</button>
        )}
      </div>

      {showFilters && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', padding: '12px 14px', background: '#fafaf9', border: `1px solid ${C.border}`, borderRadius: 10, marginBottom: 14 }}>
          {RANGE_FIELDS.map(([key, label]) => (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <label style={{ fontSize: 12, color: C.muted, fontWeight: 600 }}>{label}</label>
              <input type="number" value={ranges[key]?.min ?? ''} onChange={e => setRange(key, 'min', e.target.value)} placeholder="min"
                style={{ ...S.input, marginBottom: 0, width: 64, padding: '7px 9px' }} />
              <span style={{ color: C.muted }}>–</span>
              <input type="number" value={ranges[key]?.max ?? ''} onChange={e => setRange(key, 'max', e.target.value)} placeholder="max"
                style={{ ...S.input, marginBottom: 0, width: 64, padding: '7px 9px' }} />
            </div>
          ))}
          <div style={{ fontSize: 11, color: C.muted, alignSelf: 'center' }}>Blank = no limit</div>
        </div>
      )}

      {loading ? <div style={{ color: C.muted, padding: 20 }}>Loading…</div> : (
        <div style={{ overflowX: 'auto', background: '#fff', border: `1px solid ${C.border}`, borderRadius: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: `2px solid ${C.border}` }}>
                {COLS.map(([key, label, num]) => (
                  <th key={key} onClick={() => toggleSort(key)}
                    style={{ textAlign: num ? 'right' : 'left', padding: '10px 12px', color: C.muted, fontWeight: 700, fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none' }}>
                    {label}{sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr><td colSpan={COLS.length} style={{ padding: 24, textAlign: 'center', color: C.muted }}>No parts in this view.</td></tr>
              ) : shown.map(r => (
                <tr key={r.part_id} style={{ borderBottom: `1px solid ${C.border}`, background: isDead(r) ? '#fff7ed' : '#fff' }}>
                  {COLS.map(([key, , num]) => (
                    <td key={key} style={{ textAlign: num ? 'right' : 'left', padding: '9px 12px', color: C.text, whiteSpace: key === 'title' ? 'normal' : 'nowrap', maxWidth: key === 'title' ? 280 : undefined, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {cell(r, key)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ fontSize: 12, color: C.muted, marginTop: 10 }}>
        {visible.length > RENDER_CAP ? `Showing top ${RENDER_CAP} of ${visible.length} matching` : `Showing ${visible.length}`} (of {rows.length} parts). Narrow with a segment or search. Promotion & ad metrics arrive once the eBay Marketing API is connected.
      </div>
    </div>
  )
}
