import { useState, useEffect, useMemo } from 'react'
import { sb } from '../lib/supabase'
import { C, S, fmt } from '../lib/constants'

const EDGE_FN = 'https://mtpektsxaklhedknincs.supabase.co/functions/v1/ebay-import'

const urlFrom = (v) => {
  if (!v) return null
  if (typeof v === 'object') return v.url || v.ebay_url || null
  try { const o = JSON.parse(v); return o.url || o.ebay_url || v } catch { return v }
}

export default function Delist({ storeId, onChanged }) {
  const [parts, setParts] = useState([])
  const [loading, setLoading] = useState(true)
  const [sel, setSel] = useState(() => new Set())
  const [search, setSearch] = useState('')
  const [canDelist, setCanDelist] = useState(null)
  const [canBin, setCanBin] = useState(false)
  const [bin, setBin] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [working, setWorking] = useState(false)
  const [result, setResult] = useState(null)

  const load = async () => {
    setLoading(true)
    let { data, error } = await sb.from('parts_for_listing').select('*').eq('store_id', storeId).eq('status', 'listed').is('deleted_at', null).order('created_at', { ascending: false })
    if (error) ({ data } = await sb.from('parts').select('*').eq('store_id', storeId).eq('status', 'listed').is('deleted_at', null).order('created_at', { ascending: false }))
    setParts(data || [])
    setSel(new Set())
    setLoading(false)
  }

  useEffect(() => {
    if (!storeId) return
    load()
    sb.rpc('has_permission', { p_store_id: storeId, p_capability: 'publish' }).then(({ data }) => setCanDelist(!!data))
    sb.rpc('has_permission', { p_store_id: storeId, p_capability: 'delete' }).then(({ data }) => setCanBin(!!data))
    const channel = sb.channel(`delist-parts-${storeId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'parts', filter: `store_id=eq.${storeId}` }, () => load())
      .subscribe()
    return () => sb.removeChannel(channel)
  }, [storeId])

  const q = search.trim().toLowerCase()
  const visible = useMemo(() => q ? parts.filter(p => [p.title, p.sku, p.make, p.model].some(v => (v || '').toLowerCase().includes(q))) : parts, [parts, q])
  const toggle = (id) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const allSelected = visible.length > 0 && visible.every(p => sel.has(p.id))
  const toggleAll = () => setSel(s => { const n = new Set(s); allSelected ? visible.forEach(p => n.delete(p.id)) : visible.forEach(p => n.add(p.id)); return n })
  const selectedParts = parts.filter(p => sel.has(p.id))
  const photoOf = p => p.primary_photo || urlFrom((p.photos || [])[0])

  const run = async () => {
    setWorking(true); setResult(null)
    try {
      const { data: { session } } = await sb.auth.getSession()
      const res = await fetch(EDGE_FN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ action: 'delist_listings', storeId, partIds: selectedParts.map(p => p.id), bin }),
      })
      const d = await res.json()
      if (!res.ok || d.error) throw new Error(d.error || 'De-list failed')
      setResult(d)
      setConfirm(false)
      await load()
      onChanged?.()
    } catch (e) { setResult({ error: e.message }) }
    setWorking(false)
  }

  const th = { textAlign: 'left', padding: '9px 12px', color: C.muted, fontWeight: 700, fontSize: 11, whiteSpace: 'nowrap' }
  const td = { padding: '8px 12px', fontSize: 13, color: C.text }

  return (
    <div>
      <div style={{ fontSize: 13, color: C.muted, marginBottom: 16 }}>End live eBay listings for the selected parts. Optionally bin (remove) the parts at the same time.</div>

      {canDelist === false && (
        <div style={{ padding: '12px 16px', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 10, fontSize: 13, marginBottom: 16 }}>
          You don't have permission to manage eBay listings. Ask a store admin for <strong>Publish to eBay</strong> access.
        </div>
      )}
      {result && (
        <div style={{ padding: '12px 16px', borderRadius: 10, marginBottom: 16, background: result.error ? '#fef2f2' : '#f0fdf4', border: `1px solid ${result.error ? '#fca5a5' : '#86efac'}` }}>
          {result.error ? <span style={{ color: C.red, fontSize: 13 }}>✗ {result.error}</span>
            : <span style={{ color: C.green, fontSize: 13 }}>✓ {result.delisted} ended{bin ? ' & binned' : ''}{result.failed ? ` · ${result.failed} failed` : ''}</span>}
          {result.errors?.length > 0 && <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12, color: C.red }}>{result.errors.map((e, i) => <li key={i}>{e.partId}: {e.error}</li>)}</ul>}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search listed parts…" style={{ ...S.input, flex: '1 1 260px', minWidth: 0, marginBottom: 0 }} />
        <button onClick={load} style={{ ...S.btn('secondary'), padding: '10px 14px' }} title="Refresh">↻</button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: canBin ? C.text : C.muted }}>
          <input type="checkbox" checked={bin} disabled={!canBin} onChange={e => setBin(e.target.checked)} /> Also bin (remove)
        </label>
        <button onClick={() => setConfirm(true)} disabled={sel.size === 0 || canDelist === false}
          style={{ ...S.btn('danger'), padding: '10px 18px', opacity: (sel.size === 0 || canDelist === false) ? 0.5 : 1 }}>
          End {sel.size || ''} listing{sel.size !== 1 ? 's' : ''}
        </button>
      </div>

      {loading ? <div style={{ color: C.muted, padding: 20 }}>Loading…</div> : parts.length === 0 ? (
        <div style={{ textAlign: 'center', color: C.muted, padding: 60 }}>No live listings. Parts you've listed appear here.</div>
      ) : (
        <div style={{ overflowX: 'auto', background: '#fff', border: `1px solid ${C.border}`, borderRadius: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: `2px solid ${C.border}` }}>
                <th style={{ ...th, width: 40 }}><input type="checkbox" checked={allSelected} onChange={toggleAll} /></th>
                <th style={{ ...th, width: 52 }}></th>
                <th style={th}>Title</th><th style={th}>SKU</th><th style={th}>Make / Model</th><th style={{ ...th, textAlign: 'right' }}>Price</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(p => {
                const thumb = photoOf(p)
                return (
                  <tr key={p.id} style={{ borderBottom: `1px solid ${C.border}`, background: sel.has(p.id) ? '#fff4ef' : '#fff' }}>
                    <td style={td}><input type="checkbox" checked={sel.has(p.id)} onChange={() => toggle(p.id)} /></td>
                    <td style={td}>{thumb ? <img src={thumb} alt="" style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 6 }} /> : <div style={{ width: 40, height: 40, background: C.bg, borderRadius: 6 }} />}</td>
                    <td style={{ ...td, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}</td>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>{p.sku || '—'}</td>
                    <td style={td}>{[p.make, p.model].filter(Boolean).join(' ') || '—'}</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{fmt(p.list_price)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {confirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 440, padding: 24 }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: C.text, marginBottom: 8 }}>End {selectedParts.length} listing{selectedParts.length !== 1 ? 's' : ''}?</div>
            <div style={{ fontSize: 14, color: C.muted, marginBottom: 18, lineHeight: 1.5 }}>
              These will be <strong style={{ color: C.red }}>ended on eBay</strong> immediately.{bin ? ' The parts will also be removed from your inventory.' : ' The parts return to in-stock.'}
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirm(false)} disabled={working} style={{ ...S.btn('secondary'), padding: '11px 20px' }}>Cancel</button>
              <button onClick={run} disabled={working} style={{ ...S.btn('danger'), padding: '11px 22px', opacity: working ? 0.6 : 1 }}>
                {working ? 'Ending…' : `End ${bin ? '& bin ' : ''}${selectedParts.length}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
