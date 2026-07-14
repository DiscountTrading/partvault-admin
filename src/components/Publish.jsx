import { useState, useEffect, useMemo } from 'react'
import { sb } from '../lib/supabase'
import { C, S, fmt } from '../lib/constants'

const EDGE_FN = 'https://mtpektsxaklhedknincs.supabase.co/functions/v1/ebay-import'

export default function Publish({ storeId, onChanged }) {
  const [parts, setParts] = useState([])
  const [loading, setLoading] = useState(true)
  const [sel, setSel] = useState(() => new Set())
  const [search, setSearch] = useState('')
  const [canPublish, setCanPublish] = useState(null) // null = checking
  const [review, setReview] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [result, setResult] = useState(null)
  // Inline ship-from address prompt — eBay needs a merchant location before it
  // accepts any listing. Rather than bounce to Settings, ask for it right here.
  const [needAddr, setNeedAddr] = useState(false)
  const [addr, setAddr] = useState({ addressLine1: '', city: '', stateOrProvince: '', postalCode: '', country: 'AU' })
  const [addrSaving, setAddrSaving] = useState(false)
  const [addrErr, setAddrErr] = useState('')

  const load = async () => {
    setLoading(true)
    // Prefer the view (gives primary_photo from the photos table); fall back to
    // the base table if the migration hasn't run yet.
    let { data, error } = await sb.from('parts_for_listing').select('*').eq('store_id', storeId).eq('status', 'in_stock').is('deleted_at', null).order('created_at', { ascending: false })
    if (error) {
      ({ data } = await sb.from('parts').select('*').eq('store_id', storeId).eq('status', 'in_stock').is('deleted_at', null).order('created_at', { ascending: false }))
    }
    setParts(data || [])
    setSel(new Set())
    setLoading(false)
  }

  useEffect(() => {
    if (!storeId) return
    load()
    sb.rpc('has_permission', { p_store_id: storeId, p_capability: 'publish' }).then(({ data }) => setCanPublish(!!data))
    // Prefill the address prompt from any saved ship-from address.
    sb.from('stores').select('settings').eq('id', storeId).single().then(({ data }) => { const a = data?.settings?.shipAddress; if (a) setAddr(x => ({ ...x, ...a })) })
    // Live updates — new parts captured in the field app appear without a refresh
    const channel = sb.channel(`publish-parts-${storeId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'parts', filter: `store_id=eq.${storeId}` }, () => load())
      .subscribe()
    return () => sb.removeChannel(channel)
  }, [storeId])

  const q = search.trim().toLowerCase()
  const visible = useMemo(() => q ? parts.filter(p => [p.title, p.sku, p.make, p.model].some(v => (v || '').toLowerCase().includes(q))) : parts, [parts, q])

  const toggle = (id) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const allVisibleSelected = visible.length > 0 && visible.every(p => sel.has(p.id))
  const toggleAll = () => setSel(s => {
    const n = new Set(s)
    if (allVisibleSelected) visible.forEach(p => n.delete(p.id))
    else visible.forEach(p => n.add(p.id))
    return n
  })

  const selectedParts = parts.filter(p => sel.has(p.id))
  // parts.photos is text[] where each entry may be a plain URL or a stringified
  // {"url":...} / {"ebay_url":...}; primary_photo (from the photos table) is a plain URL.
  const urlFrom = (v) => {
    if (!v) return null
    if (typeof v === 'object') return v.url || v.ebay_url || null
    try { const o = JSON.parse(v); return o.url || o.ebay_url || v } catch { return v }
  }
  const photoOf = p => p.primary_photo || urlFrom((p.photos || [])[0])
  const issues = p => {
    const out = []
    if (!photoOf(p)) out.push('no photo')
    if (!(+p.list_price > 0)) out.push('no price')
    return out
  }

  const publish = async () => {
    setPublishing(true); setResult(null)
    try {
      const { data: { session } } = await sb.auth.getSession()
      const res = await fetch(EDGE_FN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ action: 'publish_listings', storeId, partIds: selectedParts.map(p => p.id) }),
      })
      const d = await res.json()
      if (!res.ok || d.error) throw new Error(d.error || 'Publish failed')
      setResult(d)
      setReview(false)
      await load()
      onChanged?.() // refresh the inventory/parts list so statuses stay in sync
    } catch (e) {
      // Missing ship-from address → prompt for it inline instead of dead-ending.
      if (/ship-from address|inventory location/i.test(e.message)) setNeedAddr(true)
      else setResult({ error: e.message })
    }
    setPublishing(false)
  }

  // Save the entered ship-from address, create the eBay location, then retry.
  const saveAddrAndList = async () => {
    setAddrSaving(true); setAddrErr('')
    try {
      if (!addr.addressLine1 || !addr.city || !addr.postalCode || !addr.country) throw new Error('Fill in address, city, postcode and country.')
      const { data: cur } = await sb.from('stores').select('settings').eq('id', storeId).single()
      await sb.from('stores').update({ settings: { ...(cur?.settings || {}), shipAddress: addr } }).eq('id', storeId)
      const { data: { session } } = await sb.auth.getSession()
      const res = await fetch(EDGE_FN, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ action: 'setup_ebay_location', storeId, address: addr }),
      })
      const d = await res.json()
      if (!res.ok || d.error) throw new Error(d.error || 'Could not create your eBay location')
      setNeedAddr(false); setAddrSaving(false)
      await publish()   // retry now that the location exists
    } catch (e) { setAddrErr(e.message); setAddrSaving(false) }
  }

  const th = { textAlign: 'left', padding: '9px 12px', color: C.muted, fontWeight: 700, fontSize: 11, whiteSpace: 'nowrap' }
  const td = { padding: '8px 12px', fontSize: 13, color: C.text }

  return (
    <div>
      <div style={{ fontSize: 13, color: C.muted, marginBottom: 16 }}>Review your in-stock parts and publish them as live eBay listings.</div>

      {canPublish === false && (
        <div style={{ padding: '12px 16px', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 10, fontSize: 13, marginBottom: 16 }}>
          You don't have permission to publish listings. Ask a store admin to grant you <strong>Publish to eBay</strong> access.
        </div>
      )}

      {result && (
        <div style={{ padding: '12px 16px', borderRadius: 10, marginBottom: 16, background: result.error ? '#fef2f2' : '#f0fdf4', border: `1px solid ${result.error ? '#fca5a5' : '#86efac'}` }}>
          {result.error
            ? <span style={{ color: C.red, fontSize: 13 }}>✗ {result.error}</span>
            : <span style={{ color: C.green, fontSize: 13 }}>✓ {result.published} listed live{result.failed ? ` · ${result.failed} failed` : ''}</span>}
          {result.errors?.length > 0 && (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12, color: C.red }}>
              {result.errors.map((e, i) => <li key={i}>{e.sku || e.partId}: {e.error}</li>)}
            </ul>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search title, SKU, make, model…" style={{ ...S.input, flex: '1 1 280px', minWidth: 0, marginBottom: 0 }} />
        <button onClick={load} style={{ ...S.btn('secondary'), padding: '10px 14px' }} title="Refresh">↻</button>
        <button onClick={() => setReview(true)} disabled={sel.size === 0 || canPublish === false}
          style={{ ...S.btn('primary'), padding: '10px 18px', opacity: (sel.size === 0 || canPublish === false) ? 0.5 : 1 }}>
          List {sel.size || ''} to eBay
        </button>
      </div>

      {loading ? <div style={{ color: C.muted, padding: 20 }}>Loading…</div> : parts.length === 0 ? (
        <div style={{ textAlign: 'center', color: C.muted, padding: 60 }}>No in-stock parts to list. Captured parts appear here.</div>
      ) : (
        <div style={{ overflowX: 'auto', background: '#fff', border: `1px solid ${C.border}`, borderRadius: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: `2px solid ${C.border}` }}>
                <th style={{ ...th, width: 40 }}><input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} style={{ width: 16, height: 16, cursor: 'pointer' }} /></th>
                <th style={{ ...th, width: 52 }}></th>
                <th style={th}>Title</th>
                <th style={th}>SKU</th>
                <th style={th}>Make / Model</th>
                <th style={th}>Condition</th>
                <th style={{ ...th, textAlign: 'right' }}>Price</th>
                <th style={th}>Ready?</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(p => {
                const probs = issues(p)
                const thumb = photoOf(p)
                return (
                  <tr key={p.id} style={{ borderBottom: `1px solid ${C.border}`, background: sel.has(p.id) ? '#fff4ef' : '#fff' }}>
                    <td style={td}><input type="checkbox" checked={sel.has(p.id)} onChange={() => toggle(p.id)} style={{ width: 16, height: 16, cursor: 'pointer' }} /></td>
                    <td style={td}>{thumb ? <img src={thumb} alt="" style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 6 }} /> : <div style={{ width: 40, height: 40, background: C.bg, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>🔧</div>}</td>
                    <td style={{ ...td, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}</td>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>{p.sku || '—'}</td>
                    <td style={td}>{[p.make, p.model].filter(Boolean).join(' ') || '—'}</td>
                    <td style={td}>{p.condition}</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{fmt(p.list_price)}</td>
                    <td style={td}>{probs.length ? <span style={{ color: C.red, fontSize: 12 }}>⚠ {probs.join(', ')}</span> : <span style={{ color: C.green, fontSize: 12 }}>✓</span>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Review & confirm modal */}
      {review && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 720, maxHeight: '88vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '18px 22px', borderBottom: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: C.text }}>Review before listing</div>
              <div style={{ fontSize: 13, color: C.muted, marginTop: 2 }}>{selectedParts.length} item{selectedParts.length !== 1 ? 's' : ''} — these go <strong style={{ color: C.red }}>live on eBay immediately</strong> at the prices shown.</div>
            </div>
            <div style={{ overflowY: 'auto', padding: 18 }}>
              {selectedParts.map(p => {
                const probs = issues(p)
                const thumb = photoOf(p)
                return (
                  <div key={p.id} style={{ display: 'flex', gap: 14, padding: 14, border: `1px solid ${probs.length ? '#fca5a5' : C.border}`, borderRadius: 12, marginBottom: 10, background: probs.length ? '#fef2f2' : '#fff' }}>
                    {thumb ? <img src={thumb} alt="" style={{ width: 84, height: 84, objectFit: 'cover', borderRadius: 8, flexShrink: 0 }} /> : <div style={{ width: 84, height: 84, background: C.bg, borderRadius: 8, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26 }}>🔧</div>}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, color: C.text }}>{p.title}</div>
                      <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{[p.make, p.model, p.year].filter(Boolean).join(' ')} · {p.condition} · {p.subcategory || p.category}</div>
                      <div style={{ fontSize: 12, color: C.muted, marginTop: 2, fontFamily: 'monospace' }}>{p.sku}</div>
                      {p.notes && <div style={{ fontSize: 12, color: C.text, marginTop: 6, maxHeight: 54, overflow: 'hidden' }}>{p.notes}</div>}
                      {probs.length > 0 && <div style={{ fontSize: 12, color: C.red, marginTop: 6, fontWeight: 600 }}>⚠ {probs.join(', ')} — may be rejected by eBay</div>}
                    </div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: C.text, flexShrink: 0 }}>{fmt(p.list_price)}</div>
                  </div>
                )
              })}
            </div>
            <div style={{ padding: '16px 22px', borderTop: `1px solid ${C.border}`, display: 'flex', gap: 10, justifyContent: 'flex-end', alignItems: 'center' }}>
              <button onClick={() => setReview(false)} disabled={publishing} style={{ ...S.btn('secondary'), padding: '11px 20px' }}>Cancel</button>
              <button onClick={publish} disabled={publishing} style={{ ...S.btn('primary'), padding: '11px 22px', opacity: publishing ? 0.6 : 1 }}>
                {publishing ? 'Listing…' : `🚀 List ${selectedParts.length} live on eBay`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Ship-from address prompt — shown when eBay has no location yet */}
      {needAddr && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, padding: 20 }} onClick={() => !addrSaving && setNeedAddr(false)}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, padding: 24, maxWidth: 460, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: C.text, marginBottom: 6 }}>📍 Where do you ship from?</div>
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 16, lineHeight: 1.5 }}>eBay needs a ship-from location before it accepts a listing. Enter it once and we'll register it with eBay and finish listing.</div>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10 }}>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={S.label}>Address</label>
                <input style={S.input} value={addr.addressLine1} onChange={e => setAddr(a => ({ ...a, addressLine1: e.target.value }))} placeholder="12 Yard St" />
              </div>
              <div><label style={S.label}>City / Suburb</label><input style={S.input} value={addr.city} onChange={e => setAddr(a => ({ ...a, city: e.target.value }))} /></div>
              <div><label style={S.label}>State</label><input style={S.input} value={addr.stateOrProvince} onChange={e => setAddr(a => ({ ...a, stateOrProvince: e.target.value.toUpperCase() }))} placeholder="QLD" /></div>
              <div><label style={S.label}>Postcode</label><input style={S.input} value={addr.postalCode} onChange={e => setAddr(a => ({ ...a, postalCode: e.target.value }))} /></div>
              <div><label style={S.label}>Country</label><input style={S.input} value={addr.country} onChange={e => setAddr(a => ({ ...a, country: e.target.value.toUpperCase() }))} maxLength={2} placeholder="AU" /></div>
            </div>
            {addrErr && <div style={{ fontSize: 12, color: C.red, marginTop: 10 }}>{addrErr}</div>}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 }}>
              <button onClick={() => setNeedAddr(false)} disabled={addrSaving} style={{ ...S.btn('secondary'), padding: '9px 16px' }}>Cancel</button>
              <button onClick={saveAddrAndList} disabled={addrSaving} style={{ ...S.btn('primary'), padding: '9px 18px', opacity: addrSaving ? 0.6 : 1 }}>
                {addrSaving ? 'Saving & listing…' : 'Save & list'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
