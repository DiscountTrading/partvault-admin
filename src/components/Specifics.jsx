import { useState, useEffect, useMemo } from 'react'
import { sb } from '../lib/supabase'
import { C, S, CATEGORY_NAMES, STATUS_COLORS, STATUS_LABELS } from '../lib/constants'

const EDGE_FN = 'https://mtpektsxaklhedknincs.supabase.co/functions/v1/ebay-import'

// Bulk item-specifics editor. Pick a category → we load eBay's aspects for it →
// set values → apply to the selected parts (stored as manual overrides that win
// at publish time), optionally pushing to currently-live listings via ReviseItem.
export default function Specifics({ storeId, onChanged }) {
  const [category, setCategory] = useState(CATEGORY_NAMES[0])
  const [parts, setParts] = useState([])
  const [loadingParts, setLoadingParts] = useState(true)
  const [sel, setSel] = useState(() => new Set())
  const [search, setSearch] = useState('')

  const [specs, setSpecs] = useState(null)      // null=not loaded; []=loaded
  const [loadingSpecs, setLoadingSpecs] = useState(false)
  const [vals, setVals] = useState({})          // { aspectName: value } — only non-empty are applied
  const [pushLive, setPushLive] = useState(false)
  const [canPublish, setCanPublish] = useState(false)
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState(null)
  const [confirm, setConfirm] = useState(false)

  useEffect(() => { if (storeId) sb.rpc('has_permission', { p_store_id: storeId, p_capability: 'publish' }).then(({ data }) => setCanPublish(!!data)) }, [storeId])

  // Parts in the chosen category that could be (re)listed.
  useEffect(() => {
    if (!storeId) return
    setLoadingParts(true); setSel(new Set())
    sb.from('parts').select('id, sku, title, make, model, year, status')
      .eq('store_id', storeId).eq('category', category).is('deleted_at', null)
      .in('status', ['in_stock', 'listed']).order('created_at', { ascending: false }).limit(1000)
      .then(({ data }) => { setParts(data || []); setLoadingParts(false) })
  }, [storeId, category])

  // eBay aspect definitions for the category.
  useEffect(() => {
    if (!storeId) return
    let live = true
    setSpecs(null); setVals({}); setLoadingSpecs(true); setResult(null)
    ;(async () => {
      try {
        const { data: { session } } = await sb.auth.getSession()
        const res = await fetch(EDGE_FN, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
          body: JSON.stringify({ action: 'category_aspects', storeId, category }),
        })
        const d = await res.json()
        if (live) setSpecs(d.specs || [])
      } catch { if (live) setSpecs([]) }
      finally { if (live) setLoadingSpecs(false) }
    })()
    return () => { live = false }
  }, [storeId, category])

  const q = search.trim().toLowerCase()
  const visible = useMemo(() => q ? parts.filter(p => [p.title, p.sku, p.make, p.model].some(v => (v || '').toLowerCase().includes(q))) : parts, [parts, q])
  const toggle = (id) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const allVisibleSelected = visible.length > 0 && visible.every(p => sel.has(p.id))
  const toggleAll = () => setSel(s => { const n = new Set(s); if (visible.every(p => n.has(p.id))) visible.forEach(p => n.delete(p.id)); else visible.forEach(p => n.add(p.id)); return n })

  const setVal = (name, v) => setVals(m => ({ ...m, [name]: v }))
  const filled = useMemo(() => Object.entries(vals).filter(([, v]) => (v ?? '').toString().trim() !== ''), [vals])
  const canApply = sel.size > 0 && filled.length > 0 && !applying

  const apply = async () => {
    setApplying(true); setResult(null); setConfirm(false)
    try {
      const set = Object.fromEntries(filled.map(([k, v]) => [k, String(v).trim()]))
      const { data: { session } } = await sb.auth.getSession()
      const res = await fetch(EDGE_FN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ action: 'apply_specifics', storeId, partIds: [...sel], set, pushLive }),
      })
      const d = await res.json()
      if (d.error) { setResult({ error: d.error }); return }
      setResult(d)
      onChanged?.()
    } catch (e) { setResult({ error: e.message }) }
    finally { setApplying(false) }
  }

  const th = { textAlign: 'left', padding: '8px 10px', fontSize: 11, color: C.muted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3, borderBottom: `1px solid ${C.border}` }
  const td = { padding: '8px 10px', fontSize: 13, color: C.text, borderBottom: `1px solid ${C.border}` }

  return (
    <div>
      <p style={{ fontSize: 13, color: C.muted, lineHeight: 1.6, marginBottom: 16, maxWidth: 760 }}>
        Bulk-set eBay <strong>item specifics</strong> (aspects) for a category. Values are saved as overrides that win when the part
        is listed or previewed. Tick <em>Also update live listings</em> to push the change to items already on eBay now.
      </p>

      {/* Category + aspect editor */}
      <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 12, padding: 18, marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 16 }}>
          <div style={{ flex: '1 1 260px' }}>
            <label style={S.label}>Category</label>
            <select style={S.select} value={category} onChange={e => setCategory(e.target.value)}>
              {CATEGORY_NAMES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div style={{ fontSize: 12, color: C.muted }}>
            {loadingSpecs ? 'Loading eBay aspects…' : specs ? `${specs.length} aspect${specs.length === 1 ? '' : 's'} for this category` : ''}
          </div>
        </div>

        {loadingSpecs ? (
          <div style={{ fontSize: 13, color: C.muted }}>Fetching item specifics from eBay…</div>
        ) : specs && specs.length === 0 ? (
          <div style={{ fontSize: 13, color: C.muted }}>eBay returned no aspects for this category (or it isn’t mapped yet).</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
            {(specs || []).map(s => (
              <div key={s.name}>
                <label style={{ ...S.label, textTransform: 'none' }}>
                  {s.name}{s.required && <span style={{ color: C.red }}> *</span>}
                </label>
                {s.mode === 'SELECTION_ONLY' && s.allowed?.length ? (
                  <select style={S.select} value={vals[s.name] ?? ''} onChange={e => setVal(s.name, e.target.value)}>
                    <option value="">— leave unchanged —</option>
                    {s.allowed.map(v => <option key={v} value={v}>{v}</option>)}
                  </select>
                ) : (
                  <input style={S.input} list={`opt-${s.name}`} value={vals[s.name] ?? ''} placeholder="leave blank to skip"
                    onChange={e => setVal(s.name, e.target.value)} />
                )}
                {s.mode !== 'SELECTION_ONLY' && s.allowed?.length > 0 && (
                  <datalist id={`opt-${s.name}`}>{s.allowed.slice(0, 60).map(v => <option key={v} value={v} />)}</datalist>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Part selection */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search parts…" style={{ ...S.input, marginBottom: 0, width: 220 }} />
        <div style={{ fontSize: 12, color: C.muted }}>{sel.size} selected · {parts.length} {category} part{parts.length === 1 ? '' : 's'}</div>
      </div>

      <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
        <div style={{ maxHeight: 380, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
              <tr>
                <th style={{ ...th, width: 40 }}><input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} style={{ width: 16, height: 16, cursor: 'pointer' }} /></th>
                <th style={th}>Part</th>
                <th style={th}>SKU</th>
                <th style={th}>Vehicle</th>
                <th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {loadingParts ? (
                <tr><td style={td} colSpan={5}>Loading…</td></tr>
              ) : visible.length === 0 ? (
                <tr><td style={{ ...td, color: C.muted }} colSpan={5}>No {category} parts to edit.</td></tr>
              ) : visible.map(p => (
                <tr key={p.id} style={{ background: sel.has(p.id) ? '#fff4ef' : '#fff', cursor: 'pointer' }} onClick={() => toggle(p.id)}>
                  <td style={td}><input type="checkbox" checked={sel.has(p.id)} onChange={() => toggle(p.id)} onClick={e => e.stopPropagation()} style={{ width: 16, height: 16, cursor: 'pointer' }} /></td>
                  <td style={{ ...td, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title || 'Untitled'}</td>
                  <td style={{ ...td, fontFamily: 'monospace' }}>{p.sku || '—'}</td>
                  <td style={td}>{[p.make, p.model].filter(Boolean).join(' ') || '—'}</td>
                  <td style={td}><span style={{ fontSize: 11, fontWeight: 700, color: '#fff', background: STATUS_COLORS[p.status] || C.muted, borderRadius: 20, padding: '2px 8px' }}>{STATUS_LABELS[p.status] || p.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Apply bar */}
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: canPublish ? C.text : C.muted }} title={canPublish ? '' : 'Needs the publish permission'}>
          <input type="checkbox" checked={pushLive} disabled={!canPublish} onChange={e => setPushLive(e.target.checked)} />
          Also update live eBay listings now
        </label>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 12, color: C.muted }}>{filled.length} field{filled.length === 1 ? '' : 's'} to set</div>
        <button disabled={!canApply} onClick={() => (pushLive ? setConfirm(true) : apply())}
          style={{ ...S.btn(), opacity: canApply ? 1 : 0.5, cursor: canApply ? 'pointer' : 'not-allowed' }}>
          {applying ? 'Applying…' : `Set on ${sel.size} part${sel.size === 1 ? '' : 's'}`}
        </button>
      </div>

      {result && (
        <div style={{ marginTop: 14, fontSize: 13, padding: '10px 14px', borderRadius: 8, background: result.error ? '#fef2f2' : '#f0fdf4', border: `1px solid ${result.error ? '#fecaca' : '#bbf7d0'}`, color: result.error ? '#991b1b' : '#166534' }}>
          {result.error ? result.error : (
            <>Updated {result.updated} part{result.updated === 1 ? '' : 's'}{pushLive ? ` · pushed to ${result.pushed} live listing${result.pushed === 1 ? '' : 's'}` : ''}{result.failed?.length ? ` · ${result.failed.length} eBay error${result.failed.length === 1 ? '' : 's'}` : ''}.
            {result.failed?.length > 0 && <div style={{ marginTop: 6, color: C.red, fontSize: 12 }}>{result.failed.slice(0, 4).map((f, i) => <div key={i}>Item {f.item}: {f.error}</div>)}</div>}</>
          )}
        </div>
      )}

      {confirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 20 }} onClick={() => !applying && setConfirm(false)}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, padding: 24, maxWidth: 440, width: '100%' }}>
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 10 }}>Update live eBay listings?</div>
            <div style={{ fontSize: 14, color: C.text, lineHeight: 1.6, marginBottom: 18 }}>
              This will set {filled.length} specific{filled.length === 1 ? '' : 's'} on {sel.size} part{sel.size === 1 ? '' : 's'} and revise any that are <strong>live on eBay right now</strong>. Changes to live listings are immediate.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirm(false)} disabled={applying} style={{ ...S.btn('secondary'), padding: '8px 16px' }}>Cancel</button>
              <button onClick={apply} disabled={applying} style={{ ...S.btn(), padding: '8px 16px' }}>{applying ? 'Applying…' : 'Yes, apply & revise'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
