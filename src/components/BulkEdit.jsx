import { useState, useEffect, useMemo, useRef } from 'react'
import { sb } from '../lib/supabase'
import { C, S, fmt, CATEGORY_NAMES, PART_CONDITIONS, STATUS_LABELS } from '../lib/constants'

const EDGE_FN = 'https://mtpektsxaklhedknincs.supabase.co/functions/v1/ebay-import'
const STATUS_OPTS = ['in_stock', 'listed', 'sold', 'scrapped', 'deferred']

// Core part fields you'd realistically bulk-change, in spreadsheet form.
const COLS = [
  { key: 'make',       label: 'Make',      type: 'text',   w: 110 },
  { key: 'model',      label: 'Model',     type: 'text',   w: 120 },
  { key: 'year',       label: 'Year',      type: 'text',   w: 90 },
  { key: 'category',   label: 'Category',  type: 'select', w: 180, options: CATEGORY_NAMES },
  { key: 'condition',  label: 'Condition', type: 'select', w: 150, options: PART_CONDITIONS },
  { key: 'list_price', label: 'Price',     type: 'number', w: 90 },
  { key: 'market_price', label: 'Market',  type: 'readonly', w: 90 },
  { key: 'status',     label: 'Status',    type: 'select', w: 120, options: STATUS_OPTS, labels: STATUS_LABELS },
  { key: 'location',   label: 'Location',  type: 'text',   w: 130 },
  { key: 'part_number',label: 'Part #',    type: 'text',   w: 120 },
]
const DEFAULT_VISIBLE = ['make', 'model', 'year', 'category', 'condition', 'list_price', 'status']
const PAGE = 15

// Normalise a useParts (camelCase) part into the flat row this grid edits.
const toRow = (p) => ({
  id: p.id, title: p.title || '', sku: p.sku || '',
  make: p.make || '', model: p.model || '', year: p.year || '',
  category: p.category || '', condition: p.condition || '',
  list_price: p.listPrice ?? p.list_price ?? '', status: p.status || 'in_stock',
  market_price: p.marketPrice ?? p.market_price ?? null,
  location: p.location || '', part_number: p.partNumber || p.part_number || '',
  ebayOverrides: p.ebayOverrides || p.ebay_overrides || {},
})

export default function BulkEdit({ storeId, parts, onSaved }) {
  const rows = useMemo(() => (parts || []).filter(p => !p.deletedAt).map(toRow), [parts])

  const [q, setQ] = useState('')
  const [fStatus, setFStatus] = useState('')
  const [fCategory, setFCategory] = useState('')
  const [fMake, setFMake] = useState('')
  const [visible, setVisible] = useState(() => new Set(DEFAULT_VISIBLE))
  const [specCols, setSpecCols] = useState([])   // [{name, mode, allowed}] for the chosen category
  const [visibleSpecs, setVisibleSpecs] = useState(() => new Set())
  const [colMenu, setColMenu] = useState(false)
  const [page, setPage] = useState(0)
  const [edits, setEdits] = useState({})          // { partId: { field|spec:Name : value } }
  const [saving, setSaving] = useState(false)
  const [marketBusy, setMarketBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const makes = useMemo(() => [...new Set(rows.map(r => r.make).filter(Boolean))].sort(), [rows])

  // Load eBay aspects only when a single category is picked (specifics are category-specific).
  useEffect(() => {
    setSpecCols([]); setVisibleSpecs(new Set())
    if (!storeId || !fCategory) return
    let live = true
    ;(async () => {
      try {
        const { data: { session } } = await sb.auth.getSession()
        const res = await fetch(EDGE_FN, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
          body: JSON.stringify({ action: 'category_aspects', storeId, category: fCategory }),
        })
        const d = await res.json()
        if (live) setSpecCols((d.specs || []).slice(0, 40))
      } catch { /* ignore */ }
    })()
    return () => { live = false }
  }, [storeId, fCategory])

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    return rows.filter(r =>
      (!s || [r.title, r.sku, r.make, r.model].some(v => (v || '').toLowerCase().includes(s))) &&
      (!fStatus || r.status === fStatus) &&
      (!fCategory || r.category === fCategory) &&
      (!fMake || r.make === fMake)
    )
  }, [rows, q, fStatus, fCategory, fMake])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE))
  const curPage = Math.min(page, pageCount - 1)
  const pageRows = filtered.slice(curPage * PAGE, curPage * PAGE + PAGE)
  useEffect(() => { setPage(0) }, [q, fStatus, fCategory, fMake])

  const shownCols = COLS.filter(c => visible.has(c.key))
  const shownSpecs = specCols.filter(s => visibleSpecs.has(s.name))
  const editCount = Object.values(edits).reduce((n, e) => n + Object.keys(e).length, 0)

  const cellVal = (row, key) => {
    const e = edits[row.id]
    if (e && key in e) return e[key]
    if (key.startsWith('spec:')) return (row.ebayOverrides?.specifics?.[key.slice(5)]) ?? ''
    return row[key]
  }
  const setCell = (id, key, value) => setEdits(m => ({ ...m, [id]: { ...(m[id] || {}), [key]: value } }))

  const save = async () => {
    setSaving(true); setMsg('')
    const ids = Object.keys(edits)
    let ok = 0, fail = 0
    for (const id of ids) {
      const e = edits[id]
      const patch = {}
      const specSet = {}
      for (const [k, v] of Object.entries(e)) {
        if (k.startsWith('spec:')) specSet[k.slice(5)] = v
        else if (k === 'list_price') patch.list_price = v === '' ? null : +v
        else patch[k] = v === '' ? null : v
      }
      if (Object.keys(specSet).length) {
        const row = rows.find(r => r.id === id)
        const ov = row?.ebayOverrides || {}
        patch.ebay_overrides = { ...ov, specifics: { ...(ov.specifics || {}), ...specSet } }
      }
      const { error } = await sb.from('parts').update(patch).eq('id', id)
      if (error) fail++; else ok++
    }
    setSaving(false)
    setMsg(fail ? `Saved ${ok}, ${fail} failed.` : `Saved ${ok} part${ok === 1 ? '' : 's'}.`)
    setEdits({})
    onSaved?.()
    setTimeout(() => setMsg(''), 3000)
  }

  // Pull fresh eBay market prices (in-stock parts, stalest first, bounded server-side).
  const refreshMarket = async () => {
    setMarketBusy(true); setMsg('Checking eBay market prices…')
    try {
      const { data: { session } } = await sb.auth.getSession()
      const res = await fetch(EDGE_FN, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ action: 'refresh_market', storeId }),
      })
      const d = await res.json()
      if (d.error) setMsg(d.error)
      else { setMsg(`Updated market prices for ${d.updated} of ${d.checked} in-stock parts.`); onSaved?.() }
    } catch (e) { setMsg(e.message) }
    finally { setMarketBusy(false); setVisible(s => new Set(s).add('market_price')) }
  }

  // Stage list-price edits toward the market (median) for every filtered part that
  // has a market price — the user reviews the amber cells, then Saves.
  const priceToMarket = () => {
    let n = 0
    setEdits(m => {
      const next = { ...m }
      for (const r of filtered) {
        if (r.market_price == null || r.market_price === '') continue
        const target = String(Math.round(+r.market_price))
        const cur = (next[r.id] && 'list_price' in next[r.id]) ? next[r.id].list_price : r.list_price
        if (String(cur ?? '') === target) continue
        next[r.id] = { ...(next[r.id] || {}), list_price: target }
        n++
      }
      return next
    })
    setVisible(s => { const v = new Set(s); v.add('market_price'); return v })
    setMsg(n ? `Staged ${n} price change${n === 1 ? '' : 's'} to market — review the highlighted cells, then Save.` : 'No filtered parts have a market price yet — Refresh market first.')
    setTimeout(() => setMsg(''), 5000)
  }
  const withMarket = useMemo(() => filtered.filter(r => r.market_price != null && r.market_price !== '').length, [filtered])

  const inp = { width: '100%', border: 'none', background: 'transparent', font: 'inherit', color: C.text, padding: '6px 8px', outline: 'none', boxSizing: 'border-box' }
  const editedCell = (id, key) => edits[id] && key in edits[id]

  const renderCell = (row, col) => {
    const key = col.key
    const val = cellVal(row, key)
    const bg = editedCell(row.id, key) ? '#fff7ed' : 'transparent'
    if (col.type === 'readonly') {
      return <div style={{ padding: '6px 8px', color: val == null || val === '' ? C.muted : C.text }}>{val == null || val === '' ? '—' : fmt(val)}</div>
    }
    if (col.type === 'select') {
      return <select value={val ?? ''} onChange={e => setCell(row.id, key, e.target.value)} style={{ ...inp, background: bg, cursor: 'pointer' }}>
        {col.options.map(o => <option key={o} value={o}>{col.labels ? col.labels[o] || o : o}</option>)}
      </select>
    }
    return <input type={col.type === 'number' ? 'number' : 'text'} value={val ?? ''} onChange={e => setCell(row.id, key, e.target.value)} style={{ ...inp, background: bg }} />
  }
  const renderSpec = (row, s) => {
    const key = `spec:${s.name}`
    const val = cellVal(row, key)
    const bg = editedCell(row.id, key) ? '#fff7ed' : 'transparent'
    if (s.mode === 'SELECTION_ONLY' && s.allowed?.length) {
      return <select value={val ?? ''} onChange={e => setCell(row.id, key, e.target.value)} style={{ ...inp, background: bg, cursor: 'pointer' }}>
        <option value="">—</option>
        {s.allowed.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    }
    return <input value={val ?? ''} onChange={e => setCell(row.id, key, e.target.value)} style={{ ...inp, background: bg }} />
  }

  const th = { textAlign: 'left', padding: '7px 8px', fontSize: 11, color: C.muted, fontWeight: 700, background: C.panel, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap', position: 'sticky', top: 0 }
  const cellTd = { borderBottom: `1px solid ${C.border}`, borderRight: `1px solid ${C.border}` }
  const selStyle = { ...S.select, padding: '7px 10px', width: 'auto', minWidth: 120 }

  return (
    <div>
      {/* One-line filter + actions */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search title / SKU / make…" style={{ ...S.input, marginBottom: 0, width: 220 }} />
        <select value={fMake} onChange={e => setFMake(e.target.value)} style={selStyle}><option value="">All makes</option>{makes.map(m => <option key={m} value={m}>{m}</option>)}</select>
        <select value={fCategory} onChange={e => setFCategory(e.target.value)} style={selStyle}><option value="">All categories</option>{CATEGORY_NAMES.map(c => <option key={c} value={c}>{c}</option>)}</select>
        <select value={fStatus} onChange={e => setFStatus(e.target.value)} style={selStyle}><option value="">All statuses</option>{STATUS_OPTS.map(s => <option key={s} value={s}>{STATUS_LABELS[s] || s}</option>)}</select>

        {/* Market pricing actions */}
        <button onClick={refreshMarket} disabled={marketBusy} title="Fetch live eBay median prices for in-stock parts"
          style={{ ...S.btn('secondary'), padding: '8px 12px', opacity: marketBusy ? 0.6 : 1 }}>{marketBusy ? '⏳ Checking…' : '↻ Market prices'}</button>
        <button onClick={priceToMarket} disabled={!withMarket} title="Stage list prices toward the market median for the filtered parts"
          style={{ ...S.btn(), padding: '8px 12px', opacity: withMarket ? 1 : 0.5, cursor: withMarket ? 'pointer' : 'not-allowed' }}>⚡ Price to market{withMarket ? ` (${withMarket})` : ''}</button>

        {/* Column chooser */}
        <div style={{ position: 'relative' }}>
          <button onClick={() => setColMenu(o => !o)} style={{ ...S.btn('secondary'), padding: '8px 12px' }}>Columns ▾</button>
          {colMenu && (
            <>
              <div onClick={() => setColMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
              <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 41, background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: '0 8px 30px rgba(0,0,0,0.15)', minWidth: 200, maxHeight: 340, overflowY: 'auto', padding: 6 }}>
                {COLS.map(c => (
                  <label key={c.key} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 8px', fontSize: 13, cursor: 'pointer' }}>
                    <input type="checkbox" checked={visible.has(c.key)} onChange={() => setVisible(s => { const n = new Set(s); n.has(c.key) ? n.delete(c.key) : n.add(c.key); return n })} />{c.label}
                  </label>
                ))}
                {fCategory && specCols.length > 0 && (
                  <>
                    <div style={{ fontSize: 11, color: C.muted, fontWeight: 700, padding: '8px 8px 4px', borderTop: `1px solid ${C.border}`, marginTop: 4 }}>eBay item specifics</div>
                    {specCols.map(s => (
                      <label key={s.name} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 8px', fontSize: 13, cursor: 'pointer' }}>
                        <input type="checkbox" checked={visibleSpecs.has(s.name)} onChange={() => setVisibleSpecs(v => { const n = new Set(v); n.has(s.name) ? n.delete(s.name) : n.add(s.name); return n })} />{s.name}{s.required && <span style={{ color: C.red }}>*</span>}
                      </label>
                    ))}
                  </>
                )}
                {!fCategory && <div style={{ fontSize: 11, color: C.muted, padding: '8px', borderTop: `1px solid ${C.border}`, marginTop: 4 }}>Pick one category to add eBay item-specific columns.</div>}
              </div>
            </>
          )}
        </div>

        <div style={{ flex: 1 }} />
        {msg && <span style={{ fontSize: 12, color: C.green, fontWeight: 600 }}>{msg}</span>}
        <button onClick={save} disabled={!editCount || saving} style={{ ...S.btn(), opacity: editCount && !saving ? 1 : 0.5, cursor: editCount && !saving ? 'pointer' : 'not-allowed' }}>
          {saving ? 'Saving…' : `Save ${editCount || ''} change${editCount === 1 ? '' : 's'}`}
        </button>
      </div>

      {/* Spreadsheet */}
      <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'auto', background: '#fff' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ ...th, minWidth: 220, borderRight: `1px solid ${C.border}` }}>Part</th>
              {shownCols.map(c => <th key={c.key} style={{ ...th, minWidth: c.w, borderRight: `1px solid ${C.border}` }}>{c.label}</th>)}
              {shownSpecs.map(s => <th key={s.name} style={{ ...th, minWidth: 140, borderRight: `1px solid ${C.border}` }}>{s.name}</th>)}
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr><td colSpan={1 + shownCols.length + shownSpecs.length} style={{ padding: 20, color: C.muted }}>No parts match.</td></tr>
            ) : pageRows.map(row => (
              <tr key={row.id}>
                <td style={{ ...cellTd, padding: '6px 8px', maxWidth: 260 }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 }}>{row.title || 'Untitled'}</div>
                  <div style={{ fontSize: 11, color: C.muted, fontFamily: 'monospace' }}>{row.sku || 'no SKU'}</div>
                </td>
                {shownCols.map(c => <td key={c.key} style={cellTd}>{renderCell(row, c)}</td>)}
                {shownSpecs.map(s => <td key={s.name} style={cellTd}>{renderSpec(row, s)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pager */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'center', marginTop: 12, fontSize: 13, color: C.muted }}>
        <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={curPage === 0} style={{ ...S.btn('secondary'), padding: '6px 12px', opacity: curPage === 0 ? 0.5 : 1 }}>← Prev</button>
        <span>Page {curPage + 1} of {pageCount} · {filtered.length} part{filtered.length === 1 ? '' : 's'}</span>
        <button onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={curPage >= pageCount - 1} style={{ ...S.btn('secondary'), padding: '6px 12px', opacity: curPage >= pageCount - 1 ? 0.5 : 1 }}>Next →</button>
      </div>
      {editCount > 0 && <div style={{ textAlign: 'center', fontSize: 12, color: C.accent, marginTop: 6 }}>Edits on other pages are kept until you Save.</div>}
    </div>
  )
}
