import { useState, useEffect, useMemo, useCallback } from 'react'
import { sb } from '../lib/supabase'
import { C, S, fmt, partEffectiveCost } from '../lib/constants'
import useFillHeight from '../hooks/useFillHeight'

const DEAD_DAYS = 90
const DEAD_MARGIN = 10

const SEGMENTS = [
  { id: 'all', label: 'All stock' },
  { id: 'best', label: '💰 Best performers' },
  { id: 'fast', label: '⚡ Fast movers' },
  { id: 'slow', label: '🐌 Slow movers' },
  { id: 'dead', label: '🪦 Dead stock' },
  { id: 'pricing', label: '📊 Pricing vs market' },
]

// Preset segments whose ranking depends on how long a part sat / took to sell.
// Parts with no real listing/acquisition date (date_reliable === false) have a
// shelf age estimated from the IMPORT date, so they're excluded from these by
// default — the "Include undated" checkbox lets the user add them back.
const DATE_PRESETS = ['best', 'fast', 'slow', 'dead']
const isUndated = r => r.date_reliable === false

// value -> percentile 0..100 (avg-rank for ties) over `vals`. Used to build the
// internal Best-performers ranking the same self-calibrating way as the Vehicles
// Car Score, so there are no arbitrary "good profit" benchmarks.
const percentileFn = (vals) => {
  const clean = vals.filter(v => v != null && !Number.isNaN(v))
  const n = clean.length
  return (v) => {
    if (v == null || Number.isNaN(v)) return null
    if (n <= 1) return 100
    let below = 0, equal = 0
    for (const s of clean) { if (s < v) below++; else if (s === v) equal++ }
    return ((below + (equal - 1) / 2) / (n - 1)) * 100
  }
}
// Internal composite "performance" weighting for Best performers (not shown as a
// column — it just orders the list): mostly profit, then margin, then sell-speed.
const SCORE_W = { profit: 0.5, margin: 0.2, speed: 0.3 }

// Column definitions drive both the table and the per-column filters.
// `pricingOnly` columns (the eBay market-price comparison) only show in the
// "Pricing vs market" segment — elsewhere they're noise and push the table past
// one screen width. Base widths are trimmed so the default set fits one page.
const COLS = [
  { key: 'sku', label: 'SKU', type: 'text', align: 'left', w: 105 },
  { key: 'title', label: 'Title', type: 'text', align: 'left', w: 250 },
  { key: 'status', label: 'Status', type: 'status', align: 'left', w: 95 },
  { key: 'days_on_shelf', label: 'On shelf', type: 'range', align: 'right', unit: 'd', w: 92 },
  { key: 'listing_count', label: '# Listed', type: 'range', align: 'right', w: 82 },
  { key: 'total_days_listed', label: 'Days listed', type: 'range', align: 'right', unit: 'd', w: 98 },
  { key: 'total_cost', label: 'Cost', type: 'range', align: 'right', fmt: 'money', w: 88 },
  { key: 'list_price', label: 'Price', type: 'range', align: 'right', fmt: 'money', w: 88 },
  { key: 'market_price', label: 'Market', type: 'range', align: 'right', fmt: 'money', w: 92, pricingOnly: true },
  { key: 'price_variance_pct', label: 'vs Market', type: 'range', align: 'right', fmt: 'pct', w: 98, pricingOnly: true },
  { key: 'market_checked_at', label: 'Checked', type: 'date', align: 'right', fmt: 'ago', w: 92, pricingOnly: true },
  { key: 'profit', label: 'Profit', type: 'range', align: 'right', fmt: 'money', w: 92 },
  { key: 'margin_pct', label: 'Margin', type: 'range', align: 'right', fmt: 'pct', w: 88 },
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
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10, padding: '7px 14px', flex: '1 1 150px', minWidth: 130 }}>
      <div style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 18, fontWeight: 800, color: C.text }}>{value}</span>
        {sub && <span style={{ fontSize: 10, color: C.muted }}>{sub}</span>}
      </div>
    </div>
  )
}

export default function Insights({ storeId, initial, parts = [], costing = {} }) {
  const [tableRef, tableH] = useFillHeight(52)  // fill to viewport; the "showing N" note sits below
  const [allRows, setAllRows] = useState([])
  const [loading, setLoading] = useState(true)

  // Progressive paged load: render the first page as soon as it lands and stream the
  // rest in, so the tab shows something immediately instead of blocking on the whole
  // part_insights view. Also fixes the old select('*') silently capping at 1000 rows.
  const loadRows = useCallback(async () => {
    if (!storeId) return
    const PAGE = 500
    const all = []
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await sb.from('part_insights').select('*')
        .eq('store_id', storeId).order('part_id').range(from, from + PAGE - 1)
      if (error) { setLoading(false); return }
      if (data && data.length) { all.push(...data); setAllRows([...all]) }
      if (from === 0) setLoading(false)            // first page on screen ASAP
      if (!data || data.length < PAGE) break
    }
    setLoading(false)
  }, [storeId])

  const [refreshingMkt, setRefreshingMkt] = useState(false)
  const [mktMsg, setMktMsg] = useState('')
  const refreshMarket = async () => {
    setRefreshingMkt(true); setMktMsg('Checking eBay…')
    try {
      const { data: { session } } = await sb.auth.getSession()
      const res = await fetch('https://mtpektsxaklhedknincs.supabase.co/functions/v1/ebay-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ action: 'refresh_market', storeId }),
      })
      const d = await res.json()
      if (!res.ok || d.error) throw new Error(d.error || 'Refresh failed')
      setMktMsg(`Updated ${d.updated} of ${d.checked} parts`)
      await loadRows()
    } catch (e) { setMktMsg(e.message) }
    setRefreshingMkt(false)
  }
  const [segment, setSegment] = useState('all')
  const [includeUndated, setIncludeUndated] = useState(false) // add import-dated parts back into date-based presets
  const [filters, setFilters] = useState({})        // colKey -> value (string | {min,max})

  const [drillIds, setDrillIds] = useState(null)   // Set<part_id> from a Dashboard drill
  const [drillLabel, setDrillLabel] = useState('')

  // Drill-down from the Dashboard (aged-stock bracket, category row, …): restrict
  // to the exact parts passed by id. Re-runs when a new _ts arrives.
  useEffect(() => {
    if (!initial) return
    if (initial.partIds) {
      setDrillIds(new Set(initial.partIds))
      setDrillLabel(initial.label || `${initial.partIds.length} parts`)
      setSegment('all'); setFilters({}); setSelectedViewId(null)
    } else {
      setDrillIds(null); setDrillLabel('')
      setSegment(initial.segment || 'all'); setFilters(initial.filters || {})
    }
    if (initial.sort) setSort(initial.sort)
  }, [initial?._ts])
  const clearDrill = () => { setDrillIds(null); setDrillLabel('') }
  const [openFilter, setOpenFilter] = useState(null) // colKey whose popover is open
  const [sort, setSort] = useState({ key: 'days_on_shelf', dir: 'desc' })
  const [views, setViews] = useState([])
  const [meId, setMeId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [viewName, setViewName] = useState('')
  const [selectedViewId, setSelectedViewId] = useState(null)
  const [viewMenuOpen, setViewMenuOpen] = useState(false)

  useEffect(() => {
    if (!storeId) return
    setLoading(true); setAllRows([])
    sb.auth.getUser().then(({ data: { user } }) => setMeId(user?.id || null))
    loadRows()
    loadViews()
  }, [storeId, loadRows])

  const loadViews = () => sb.from('saved_views').select('*').eq('store_id', storeId).order('name').then(({ data }) => setViews(data || []))

  // Source filter (matches the By-model / By-car "Include" toggles): eBay API =
  // synced listings (source='ebay_import'), Imported history = CSV backfill
  // (source='ebay_history'), PartVault = everything captured in-app.
  const [srcSel, setSrcSel] = useState({ partvault: true, ebay: true, history: true })
  const srcOf = (r) => r.source === 'ebay_import' ? 'ebay' : r.source === 'ebay_history' ? 'history' : 'partvault'

  // The part_insights VIEW computes cost as the raw sum of the parts.costs jsonb
  // only — which is all-zeros for imported/eBay-history parts. That made their
  // profit = full sale price and margin ≈ 100%, skewing every performance segment.
  // Recompute cost/profit/margin here with partEffectiveCost() — the SAME estimate
  // model the Dashboard and Vehicles tabs use (recorded costs + acquisition base,
  // labour, admin, storage) — so the numbers are consistent and imported data can't
  // inflate them. Falls back to the view's own values if we can't find the full part.
  const partsById = useMemo(() => new Map((parts || []).map(p => [p.id, p])), [parts])
  const costedRows = useMemo(() => allRows.map(r => {
    const full = partsById.get(r.part_id)
    if (!full) return r
    const cost = Math.round(partEffectiveCost(full, costing).value * 100) / 100
    if (r.status === 'sold') {
      const rev = (+r.sold_price || 0) + (+r.shipping_charged || 0)
      const profit = Math.round((rev - cost) * 100) / 100
      return { ...r, total_cost: cost, realized_profit: profit, potential_profit: null, margin_pct: rev > 0 ? Math.round((profit / rev) * 1000) / 10 : null }
    }
    const lp = +r.list_price || 0
    const profit = Math.round((lp - cost) * 100) / 100
    return { ...r, total_cost: cost, realized_profit: null, potential_profit: profit, margin_pct: lp > 0 ? Math.round((profit / lp) * 1000) / 10 : null }
  }), [allRows, partsById, costing])

  // Internal Best-performers score: percentile-blend of profit, margin and sell-speed
  // across sold parts (speed only when the part has a reliable date). Not displayed —
  // it just gives "Best performers" a defensible order instead of raw dollars.
  const scoredRows = useMemo(() => {
    const sold = costedRows.filter(r => r.status === 'sold')
    const profP = percentileFn(sold.map(r => r.realized_profit))
    const margP = percentileFn(sold.map(r => r.margin_pct))
    const spdP = percentileFn(sold.filter(r => r.days_to_sell != null && !isUndated(r)).map(r => -r.days_to_sell))
    return costedRows.map(r => {
      if (r.status !== 'sold') return r
      const sP = profP(r.realized_profit), sM = margP(r.margin_pct)
      const sS = (r.days_to_sell != null && !isUndated(r)) ? spdP(-r.days_to_sell) : null
      let num = 0, den = 0
      if (sP != null) { num += SCORE_W.profit * sP; den += SCORE_W.profit }
      if (sM != null) { num += SCORE_W.margin * sM; den += SCORE_W.margin }
      if (sS != null) { num += SCORE_W.speed * sS; den += SCORE_W.speed }
      return { ...r, _score: den > 0 ? Math.round(num / den) : null }
    })
  }, [costedRows])

  const rows = useMemo(() => scoredRows.filter(r => srcSel[srcOf(r)]), [scoredRows, srcSel])

  const statuses = useMemo(() => [...new Set(rows.map(r => r.status).filter(Boolean))].sort(), [rows])

  const active = (key) => {
    const f = filters[key]
    if (f == null) return false
    if (typeof f === 'object') return f.min !== '' && f.min != null || f.max !== '' && f.max != null
    return f !== ''
  }
  const anyFilter = segment !== 'all' || COLS.some(c => active(c.key))

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
      undatedCount: rows.filter(isUndated).length,
    }
  }, [rows])

  // The raw segment, BEFORE the undated-date filter — so we can both count how
  // many undated parts a date-based preset would hide and let the user opt them in.
  const segmentBase = useMemo(() => {
    switch (segment) {
      case 'best': return rows.filter(r => r.status === 'sold')
      case 'fast': {
        // The quicker half of sold parts (fastest to shift), not every sold part.
        const sold = rows.filter(r => r.status === 'sold' && r.days_to_sell != null)
        if (sold.length < 3) return sold
        const ds = sold.map(r => r.days_to_sell).sort((a, b) => a - b)
        const median = ds[Math.floor(ds.length / 2)]
        return sold.filter(r => r.days_to_sell <= median)
      }
      case 'slow': return rows.filter(r => isUnsold(r) && r.listing_count > 0)
      case 'dead': return rows.filter(isDead)
      case 'pricing': return rows.filter(r => isUnsold(r) && r.price_variance_pct != null)
      default: return rows
    }
  }, [rows, segment])

  // How many parts in the current preset have an unreliable (import-only) date —
  // i.e. what the checkbox would toggle. 0 for non-date presets.
  const undatedInSegment = useMemo(
    () => (DATE_PRESETS.includes(segment) ? segmentBase.filter(isUndated).length : 0),
    [segmentBase, segment],
  )

  // Exclude import-dated parts from the date-based presets unless opted in.
  const segmented = useMemo(() => {
    if (DATE_PRESETS.includes(segment) && !includeUndated) return segmentBase.filter(r => !isUndated(r))
    return segmentBase
  }, [segmentBase, segment, includeUndated])

  const visible = useMemo(() => {
    let list = drillIds ? segmented.filter(r => drillIds.has(r.part_id)) : segmented
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
  }, [segmented, filters, sort, drillIds])

  const shown = visible.slice(0, RENDER_CAP)
  // Market-comparison columns only in the Pricing segment; keeps the default table
  // to one screen width.
  const visCols = useMemo(() => COLS.filter(c => segment === 'pricing' || !c.pricingOnly), [segment])

  const toggleSort = (key) => setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' })
  // Any manual change to filters/segment means we're no longer on a saved view.
  const setFilter = (key, val) => { setFilters(f => ({ ...f, [key]: val })); setSelectedViewId(null) }
  const clearFilter = (key) => { setFilters(f => { const n = { ...f }; delete n[key]; return n }); setSelectedViewId(null); setOpenFilter(null) }
  // Each segment gets a sensible default sort, so e.g. "Fast movers" leads with
  // the fastest, not the slowest.
  const SEGMENT_SORT = {
    fast: { key: 'days_to_sell', dir: 'asc' },
    slow: { key: 'days_on_shelf', dir: 'desc' },
    dead: { key: 'days_on_shelf', dir: 'desc' },
    best: { key: '_score', dir: 'desc' }, // internal composite (profit+margin+speed), not a visible column
    pricing: { key: 'price_variance_pct', dir: 'desc' }, // most over-priced first
    all:  { key: 'days_on_shelf', dir: 'desc' },
  }
  const pickSegment = (id) => { setSegment(id); setSelectedViewId(null); setSort(SEGMENT_SORT[id] || SEGMENT_SORT.all) }
  const removeAll = () => { setFilters({}); setSegment('all'); setSelectedViewId(null); setOpenFilter(null) }

  const applyView = (id) => {
    const v = views.find(x => x.id === id)
    if (!v) return
    const cfg = v.config || {}
    setSegment(cfg.segment || 'all')
    setFilters(cfg.filters || {})
    setSort(cfg.sort || { key: 'days_on_shelf', dir: 'desc' })
    setSelectedViewId(id)
  }
  const saveView = async () => {
    const name = viewName.trim()
    if (!name || !meId) return
    const config = { segment, filters, sort }
    const existing = views.find(v => v.name.toLowerCase() === name.toLowerCase())
    setSaving(true)
    if (existing) {
      if (!confirm(`A view named "${existing.name}" already exists. Replace it?`)) { setSaving(false); return }
      await sb.from('saved_views').update({ config }).eq('id', existing.id)
      setSelectedViewId(existing.id)
    } else {
      const { data } = await sb.from('saved_views').insert({ user_id: meId, store_id: storeId, name, config }).select().single()
      if (data) setSelectedViewId(data.id)
    }
    setSaving(false)
    setViewName('')
    loadViews()
  }
  const deleteView = async (id) => {
    if (!confirm('Delete this saved view? This cannot be undone.')) return
    await sb.from('saved_views').delete().eq('id', id)
    if (selectedViewId === id) setSelectedViewId(null)
    loadViews()
  }

  const currentViewLabel = selectedViewId
    ? (views.find(v => v.id === selectedViewId)?.name || 'No filter')
    : (anyFilter ? 'Custom filter' : 'No filter')

  const cell = (r, col) => {
    const v = fieldVal(r, col.key)
    // Shelf age from the import date (no real listing/acquisition date) — flag it
    // so the number isn't mistaken for a true time-on-shelf.
    if (col.key === 'days_on_shelf' && isUndated(r)) {
      return (
        <span title="Estimated from the import date — no original eBay listing or acquisition date on record. Fix with Settings → eBay Sync → Backfill Listing Dates."
          style={{ color: C.yellow, fontWeight: 600 }}>
          ~{v == null ? '—' : `${v}d`} ⚠
        </span>
      )
    }
    if (col.fmt === 'ago') {
      if (!v) return <span style={{ color: '#bbb' }}>never</span>
      const days = Math.floor((Date.now() - new Date(v).getTime()) / 86400000)
      const color = days > 21 ? C.red : days > 10 ? C.yellow : C.muted
      return <span style={{ color }}>{days <= 0 ? 'today' : `${days}d ago`}</span>
    }
    if (col.fmt === 'money') return money(v)
    if (col.fmt === 'pct') return v == null ? '—' : `${v}%`
    if (col.unit) return v == null ? '—' : `${v}${col.unit}`
    return v ?? ''
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <Card label="Stock on hand" value={money(summary.stockValue)} sub={`${summary.unsoldCount} unsold parts`} />
        <Card label="Avg margin (unsold)" value={summary.avgMargin == null ? '—' : `${summary.avgMargin}%`} />
        <Card label="Avg days to sell" value={summary.avgDts != null ? `${summary.avgDts}d` : '—'} />
        <Card label="Dead stock" value={summary.deadCount} sub={`>${DEAD_DAYS}d & ≤${DEAD_MARGIN}% margin`} />
      </div>

      {/* Source include filter — matches the By-model / By-car toggles */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 12, color: C.muted, flexWrap: 'wrap', marginBottom: 12 }}>
        <span>Include:</span>
        {[['partvault', 'PartVault'], ['ebay', 'eBay API'], ['history', 'Imported history']].map(([k, label]) => (
          <label key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}
            title={k === 'ebay' ? "Parts synced from eBay listings" : k === 'history' ? 'Parts from the CSV order-history import' : 'Parts captured in PartVault'}>
            <input type="checkbox" checked={srcSel[k]} onChange={e => setSrcSel(s => ({ ...s, [k]: e.target.checked }))} />
            {label}
          </label>
        ))}
      </div>

      {/* Segments + saved views */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        {SEGMENTS.map(s => (
          <button key={s.id} onClick={() => pickSegment(s.id)}
            style={{ padding: '7px 14px', borderRadius: 20, border: `1.5px solid ${segment === s.id ? C.accent : C.border}`, background: segment === s.id ? C.accent : '#fff', color: segment === s.id ? '#fff' : C.muted, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            {s.label}
          </button>
        ))}
        {DATE_PRESETS.includes(segment) && (undatedInSegment > 0 || includeUndated) && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.muted, cursor: 'pointer', padding: '6px 12px', border: `1px solid ${C.border}`, borderRadius: 20, background: '#fff' }}
            title="These parts have no original eBay listing or acquisition date, so their shelf age is estimated from the import date. They're left out of this performance view by default.">
            <input type="checkbox" checked={includeUndated} onChange={e => setIncludeUndated(e.target.checked)} />
            Include {undatedInSegment} undated {undatedInSegment === 1 ? 'item' : 'items'}
          </label>
        )}
        {segment === 'pricing' && (
          <button onClick={refreshMarket} disabled={refreshingMkt} style={{ ...S.btn('secondary'), padding: '7px 12px', fontSize: 12, opacity: refreshingMkt ? 0.6 : 1 }}>
            {refreshingMkt ? '⏳ Checking eBay…' : '↻ Refresh market prices'}
          </button>
        )}
        {segment === 'pricing' && mktMsg && <span style={{ fontSize: 12, color: C.muted }}>{mktMsg}</span>}
        {drillIds && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 20, background: C.accent + '18', border: `1.5px solid ${C.accent}55`, color: C.accent, fontSize: 13, fontWeight: 600 }}>
            🔎 {drillLabel}
            <button onClick={clearDrill} style={{ background: 'none', border: 'none', color: C.accent, cursor: 'pointer', fontWeight: 700, fontSize: 14, padding: 0, lineHeight: 1 }}>✕</button>
          </span>
        )}
        <div style={{ flex: 1 }} />
        {anyFilter && <button onClick={removeAll} style={{ ...S.btn('secondary'), padding: '7px 12px', fontSize: 12 }}>✕ Remove all filters</button>}

        {/* Saved views — always present */}
        <div style={{ position: 'relative' }}>
          <button onClick={() => setViewMenuOpen(o => !o)}
            style={{ ...S.btn('secondary'), padding: '7px 12px', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6, fontStyle: currentViewLabel === 'Custom filter' ? 'italic' : 'normal' }}>
            {currentViewLabel} <span style={{ opacity: 0.6 }}>▾</span>
          </button>
          {viewMenuOpen && (
            <>
              <div onClick={() => setViewMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
              <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 41, background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: '0 8px 30px rgba(0,0,0,0.15)', minWidth: 210, overflow: 'hidden' }}>
                <button onClick={() => { removeAll(); setViewMenuOpen(false) }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', background: (!anyFilter && !selectedViewId) ? '#fff4ef' : '#fff', border: 'none', padding: '9px 12px', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: C.text }}>No filter</button>
                {views.length === 0 ? (
                  <div style={{ padding: '9px 12px', fontSize: 12, color: C.muted, borderTop: `1px solid ${C.border}` }}>No saved views yet</div>
                ) : views.map(v => (
                  <div key={v.id} style={{ display: 'flex', alignItems: 'center', borderTop: `1px solid ${C.border}`, background: selectedViewId === v.id ? '#fff4ef' : '#fff' }}>
                    <button onClick={() => { applyView(v.id); setViewMenuOpen(false) }}
                      style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none', padding: '9px 12px', cursor: 'pointer', fontSize: 13, color: C.text }}>{v.name}</button>
                    <button onClick={() => deleteView(v.id)} title="Delete view"
                      style={{ background: 'none', border: 'none', color: C.red, cursor: 'pointer', fontSize: 14, fontWeight: 700, padding: '0 12px' }}>✕</button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input value={viewName} onChange={e => setViewName(e.target.value)} placeholder="Save view as…" onKeyDown={e => e.key === 'Enter' && saveView()}
            style={{ ...S.input, marginBottom: 0, padding: '7px 10px', width: 130 }} />
          <button onClick={saveView} disabled={saving || !viewName.trim()} style={{ ...S.btn('primary'), padding: '7px 12px', fontSize: 12, opacity: (saving || !viewName.trim()) ? 0.6 : 1 }}>Save</button>
        </div>
      </div>

      {loading ? <div style={{ color: C.muted, padding: 20 }}>Loading…</div> : (
        <div ref={tableRef} className="pv-scroll" style={{ overflowX: 'scroll', overflowY: 'auto', maxHeight: tableH || '60vh', background: '#fff', border: `1px solid ${C.border}`, borderRadius: 12 }}>
          <table style={{ width: '100%', minWidth: visCols.reduce((s, c) => s + c.w, 0), borderCollapse: 'collapse', fontSize: 13, tableLayout: 'fixed', zoom: 'var(--table-zoom, 1)' }}>
            <colgroup>{visCols.map(c => <col key={c.key} style={{ width: c.w }} />)}</colgroup>
            <thead>
              <tr style={{ borderBottom: `2px solid ${C.border}` }}>
                {visCols.map(col => (
                  <th key={col.key} style={{ textAlign: 'left', padding: '9px 10px', color: C.muted, fontWeight: 700, fontSize: 11, whiteSpace: 'normal', verticalAlign: 'top', position: 'sticky', top: 0, background: '#fff', zIndex: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6 }}>
                      <span onClick={() => toggleSort(col.key)} style={{ cursor: 'pointer', userSelect: 'none', display: 'inline-flex', alignItems: 'flex-start', gap: 4, lineHeight: 1.25 }}>
                        <span style={{ width: 9, flexShrink: 0, display: 'inline-block', fontSize: 10, color: sort.key === col.key ? C.text : '#cbd5e1' }}>
                          {sort.key === col.key ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
                        </span>
                        <span>{col.label}</span>
                      </span>
                      {col.type !== 'date' && (
                        <button onClick={() => setOpenFilter(o => o === col.key ? null : col.key)}
                          style={{ background: 'none', border: 'none', padding: 2, cursor: 'pointer', lineHeight: 0, flexShrink: 0 }} title="Filter">
                          <FunnelIcon active={active(col.key)} />
                        </button>
                      )}
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
                                <button onClick={() => setOpenFilter(null)} style={{ ...S.btn('primary'), padding: '5px 10px', fontSize: 12 }}>Done</button>
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
                                <button onClick={() => setOpenFilter(null)} style={{ ...S.btn('primary'), padding: '5px 10px', fontSize: 12 }}>Done</button>
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
                <tr><td colSpan={visCols.length} style={{ padding: 24, textAlign: 'center', color: C.muted }}>No parts in this view.</td></tr>
              ) : shown.map(r => (
                <tr key={r.part_id} style={{ borderBottom: `1px solid ${C.border}`, background: isDead(r) ? '#fff7ed' : '#fff' }}>
                  {visCols.map(col => (
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

      <div style={{ marginTop: 10 }}>
        <span style={{ fontSize: 12, color: C.muted }}>
          {visible.length > RENDER_CAP ? `Showing top ${RENDER_CAP} of ${visible.length} matching` : `Showing ${visible.length}`} (of {rows.length} parts). Promotion & ad metrics arrive with the eBay Marketing API.
        </span>
        {summary.undatedCount > 0 && (
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>
            ⚠ {summary.undatedCount} part{summary.undatedCount === 1 ? ' has' : 's have'} an estimated shelf date (no original eBay listing date on record) and {summary.undatedCount === 1 ? "isn't" : "aren't"} counted in the best/movers views by default. Run <strong>Settings → eBay Sync → Backfill Listing Dates</strong> to fetch the real dates.
          </div>
        )}
        <div style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>
          Cost, profit &amp; margin use the same estimate model as the Dashboard (recorded costs plus an acquisition base, labour, admin &amp; storage) wherever a real cost isn't recorded — so imported listings no longer show a near-100% margin. Record actual costs (or set the estimate rates in Settings → Costs) to sharpen these. Best performers are ranked on a blend of profit, margin &amp; sell-speed.
        </div>
      </div>
    </div>
  )
}
