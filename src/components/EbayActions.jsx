import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'
import { C, S, fmt } from '../lib/constants'
import { publishListings, delistListings, setupEbayLocation, canPublish as checkCanPublish } from '../lib/ebay'

const urlFrom = (v) => { if (!v) return null; if (typeof v === 'object') return v.url || v.ebay_url || null; try { const o = JSON.parse(v); return o.url || o.ebay_url || v } catch { return v } }
const photoOf = (p) => p.primary_photo || urlFrom((p.photos || [])[0])
const issuesOf = (p) => { const out = []; if (!photoOf(p)) out.push('no photo'); if (!(+p.list_price > 0 || +p.listPrice > 0)) out.push('no price'); return out }

// Bulk eBay action bar for the Inventory selection. Contextual: List when the
// selected parts are in-stock, De-list when they're listed. Carries the full
// publish safety flow (readiness, go-live confirm, ship-from-address prompt) and
// the de-list confirm (with optional bin), so Inventory just owns the selection.
export default function EbayActions({ storeId, selectedParts, onDone, onClear }) {
  const [canPub, setCanPub] = useState(null)
  const [review, setReview] = useState(false)      // publish review modal
  const [delistOpen, setDelistOpen] = useState(false)
  const [bin, setBin] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [needAddr, setNeedAddr] = useState(false)
  const [addr, setAddr] = useState({ addressLine1: '', city: '', stateOrProvince: '', postalCode: '', country: 'AU' })
  const [addrErr, setAddrErr] = useState('')

  useEffect(() => { if (storeId) checkCanPublish(storeId).then(setCanPub) }, [storeId])
  useEffect(() => {
    if (!storeId) return
    sb.from('stores').select('settings').eq('id', storeId).single().then(({ data }) => { const a = data?.settings?.shipAddress; if (a) setAddr(x => ({ ...x, ...a })) })
  }, [storeId])

  const ids = selectedParts.map(p => p.id)
  const statuses = new Set(selectedParts.map(p => p.status))
  const allInStock = selectedParts.length > 0 && [...statuses].every(s => s === 'in_stock')
  const allListed = selectedParts.length > 0 && [...statuses].every(s => s === 'listed')
  const notReady = selectedParts.filter(p => issuesOf(p).length)

  const doPublish = async () => {
    setBusy(true); setResult(null)
    try {
      const d = await publishListings(storeId, ids)
      setResult(d); setReview(false); onDone?.(); onClear?.()
    } catch (e) {
      if (/ship-from address|inventory location/i.test(e.message)) setNeedAddr(true)
      else setResult({ error: e.message })
    }
    setBusy(false)
  }
  const saveAddrAndPublish = async () => {
    setBusy(true); setAddrErr('')
    try {
      if (!addr.addressLine1 || !addr.city || !addr.postalCode || !addr.country) throw new Error('Fill in address, city, postcode and country.')
      const { data: cur } = await sb.from('stores').select('settings').eq('id', storeId).single()
      await sb.from('stores').update({ settings: { ...(cur?.settings || {}), shipAddress: addr } }).eq('id', storeId)
      await setupEbayLocation(storeId, addr)
      setNeedAddr(false); setBusy(false)
      await doPublish()
    } catch (e) { setAddrErr(e.message); setBusy(false) }
  }
  const doDelist = async () => {
    setBusy(true); setResult(null)
    try { const d = await delistListings(storeId, ids, bin); setResult(d); setDelistOpen(false); onDone?.(); onClear?.() }
    catch (e) { setResult({ error: e.message }) }
    setBusy(false)
  }

  if (!selectedParts.length && !result) return null
  const mixed = selectedParts.length > 0 && !allInStock && !allListed

  return (
    <>
      {/* Result toast */}
      {result && (
        <div style={{ position: 'fixed', bottom: 82, left: '50%', transform: 'translateX(-50%)', zIndex: 1050, background: result.error ? '#fef2f2' : '#f0fdf4', border: `1px solid ${result.error ? '#fca5a5' : '#86efac'}`, borderRadius: 10, padding: '10px 16px', fontSize: 13, maxWidth: 560, boxShadow: '0 8px 30px rgba(0,0,0,0.15)' }}>
          {result.error ? <span style={{ color: C.red }}>✗ {result.error}</span>
           : result.published != null ? <span style={{ color: C.green }}>✓ {result.published} listed live{result.failed ? ` · ${result.failed} failed` : ''}</span>
           : <span style={{ color: C.green }}>✓ {result.delisted ?? result.ended ?? ids.length} de-listed{bin ? ' & binned' : ''}</span>}
          <button onClick={() => setResult(null)} style={{ background: 'none', border: 'none', marginLeft: 12, cursor: 'pointer', color: C.muted }}>×</button>
        </div>
      )}

      {/* Sticky bulk bar */}
      {selectedParts.length > 0 && (
        <div style={{ position: 'sticky', bottom: 0, zIndex: 40, marginTop: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', background: '#1c1c1e', color: '#fff', borderRadius: 12, padding: '12px 18px', boxShadow: '0 -4px 20px rgba(0,0,0,0.15)' }}>
          <span style={{ fontWeight: 700 }}>{selectedParts.length} selected</span>
          {notReady.length > 0 && allInStock && <span style={{ fontSize: 12, color: '#fca5a5' }}>⚠ {notReady.length} not ready (photo/price)</span>}
          <div style={{ flex: 1 }} />
          <button onClick={onClear} title="Clear the selection" style={{ background: 'rgba(255,255,255,0.14)', border: '1px solid rgba(255,255,255,0.25)', color: '#fff', borderRadius: 8, padding: '8px 14px', fontSize: 13, cursor: 'pointer' }}>Clear</button>
          {mixed ? <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>Select all in-stock (to list) or all listed (to de-list)</span>
           : allListed ? (
            <button onClick={() => setDelistOpen(true)} disabled={canPub === false} title="End the selected live eBay listings" style={{ background: C.red, border: 'none', color: '#fff', borderRadius: 8, padding: '9px 18px', fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: canPub === false ? 0.5 : 1 }}>⏹ De-list {selectedParts.length}</button>
           ) : (
            <button onClick={() => setReview(true)} disabled={canPub === false} title="Review, then publish the selected parts as live eBay listings" style={{ background: C.accent, border: 'none', color: '#fff', borderRadius: 8, padding: '9px 18px', fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: canPub === false ? 0.5 : 1 }}>🚀 List {selectedParts.length} to eBay</button>
           )}
        </div>
      )}
      {canPub === false && selectedParts.length > 0 && <div style={{ fontSize: 12, color: C.red, marginTop: 6 }}>You don't have permission to publish/de-list on eBay — ask a store admin for Publish access.</div>}

      {/* Publish review */}
      {review && (
        <Modal title="Review before listing" sub={<>{selectedParts.length} item{selectedParts.length !== 1 ? 's' : ''} go <strong style={{ color: C.red }}>live on eBay immediately</strong> at the prices shown.</>} onClose={() => !busy && setReview(false)}>
          <div style={{ overflowY: 'auto', padding: 18, flex: 1 }}>
            {selectedParts.map(p => {
              const probs = issuesOf(p); const thumb = photoOf(p)
              return (
                <div key={p.id} style={{ display: 'flex', gap: 14, padding: 12, border: `1px solid ${probs.length ? '#fca5a5' : C.border}`, borderRadius: 10, marginBottom: 10, background: probs.length ? '#fef2f2' : '#fff' }}>
                  {thumb ? <img src={thumb} alt="" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, flexShrink: 0 }} /> : <div style={{ width: 72, height: 72, background: C.bg, borderRadius: 8, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24 }}>🔧</div>}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14, color: C.text }}>{p.title}</div>
                    <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{[p.make, p.model, p.year].filter(Boolean).join(' ')} · {p.condition} · {p.sku || 'no SKU'}</div>
                    {probs.length > 0 && <div style={{ fontSize: 12, color: C.red, marginTop: 6, fontWeight: 600 }}>⚠ {probs.join(', ')} — may be rejected by eBay</div>}
                  </div>
                  <div style={{ fontSize: 17, fontWeight: 800, color: C.text }}>{fmt(p.list_price || p.listPrice)}</div>
                </div>
              )
            })}
          </div>
          <Footer>
            <button onClick={() => setReview(false)} disabled={busy} style={{ ...S.btn('secondary'), padding: '11px 20px' }}>Cancel</button>
            <button onClick={doPublish} disabled={busy} style={{ ...S.btn('primary'), padding: '11px 22px', opacity: busy ? 0.6 : 1 }}>{busy ? 'Listing…' : `🚀 List ${selectedParts.length} live`}</button>
          </Footer>
        </Modal>
      )}

      {/* De-list confirm */}
      {delistOpen && (
        <Modal title={`End ${selectedParts.length} listing${selectedParts.length !== 1 ? 's' : ''}?`} sub="This ends the live eBay listings for the selected parts." onClose={() => !busy && setDelistOpen(false)}>
          <div style={{ padding: 20, flex: 1 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, cursor: 'pointer' }}>
              <input type="checkbox" checked={bin} onChange={e => setBin(e.target.checked)} style={{ width: 16, height: 16 }} />
              Also bin (remove) these parts from inventory
            </label>
          </div>
          <Footer>
            <button onClick={() => setDelistOpen(false)} disabled={busy} style={{ ...S.btn('secondary'), padding: '11px 20px' }}>Cancel</button>
            <button onClick={doDelist} disabled={busy} style={{ ...S.btn('danger'), padding: '11px 22px', opacity: busy ? 0.6 : 1 }}>{busy ? 'Ending…' : `⏹ End ${bin ? '& bin ' : ''}${selectedParts.length}`}</button>
          </Footer>
        </Modal>
      )}

      {/* Ship-from address prompt */}
      {needAddr && (
        <Modal title="📍 Where do you ship from?" sub="eBay needs a ship-from location before it accepts a listing. Enter it once and we'll register it and finish listing." onClose={() => !busy && setNeedAddr(false)} narrow>
          <div style={{ padding: 20 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10 }}>
              <div style={{ gridColumn: '1 / -1' }}><label style={S.label}>Address</label><input style={S.input} value={addr.addressLine1} onChange={e => setAddr(a => ({ ...a, addressLine1: e.target.value }))} placeholder="12 Yard St" /></div>
              <div><label style={S.label}>City / Suburb</label><input style={S.input} value={addr.city} onChange={e => setAddr(a => ({ ...a, city: e.target.value }))} /></div>
              <div><label style={S.label}>State</label><input style={S.input} value={addr.stateOrProvince} onChange={e => setAddr(a => ({ ...a, stateOrProvince: e.target.value.toUpperCase() }))} placeholder="QLD" /></div>
              <div><label style={S.label}>Postcode</label><input style={S.input} value={addr.postalCode} onChange={e => setAddr(a => ({ ...a, postalCode: e.target.value }))} /></div>
              <div><label style={S.label}>Country</label><input style={S.input} value={addr.country} onChange={e => setAddr(a => ({ ...a, country: e.target.value.toUpperCase() }))} maxLength={2} placeholder="AU" /></div>
            </div>
            {addrErr && <div style={{ fontSize: 12, color: C.red, marginTop: 10 }}>{addrErr}</div>}
          </div>
          <Footer>
            <button onClick={() => setNeedAddr(false)} disabled={busy} style={{ ...S.btn('secondary'), padding: '9px 16px' }}>Cancel</button>
            <button onClick={saveAddrAndPublish} disabled={busy} style={{ ...S.btn('primary'), padding: '9px 18px', opacity: busy ? 0.6 : 1 }}>{busy ? 'Saving & listing…' : 'Save & list'}</button>
          </Footer>
        </Modal>
      )}
    </>
  )
}

function Modal({ title, sub, children, onClose, narrow }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: narrow ? 460 : 700, maxHeight: '88vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '16px 22px', borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: C.text }}>{title}</div>
          {sub && <div style={{ fontSize: 13, color: C.muted, marginTop: 2 }}>{sub}</div>}
        </div>
        {children}
      </div>
    </div>
  )
}
function Footer({ children }) {
  return <div style={{ padding: '14px 22px', borderTop: `1px solid ${C.border}`, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>{children}</div>
}
