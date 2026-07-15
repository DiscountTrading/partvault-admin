import { useState, useMemo } from 'react'
import { sb } from '../lib/supabase'
import { C, S } from '../lib/constants'

const EBAY_FN = 'https://mtpektsxaklhedknincs.supabase.co/functions/v1/ebay-import'

// SKU reconcile — eBay is the source of truth.
//
// Why this exists: parts are listed with ONE placeholder custom label and the
// label is corrected on eBay when the item is shelved. The sync skips listings
// it already knows, so those corrections never reached PartVault (and duplicate
// placeholders forced the EB-<itemId> fallback). This re-reads the CURRENT label
// from every live listing and copies it down.
//
// Scan is READ-ONLY. Nothing is ever written to eBay — data flows eBay → PartVault.
// A SKU we generated as a last resort rather than one of Austin's real labels:
//   EB-<itemId> / EBH-<itemId>  — the import's collision fallback
//   <anything>-<10+ digits>     — a generated base with the eBay item id appended
// Only these are worth asking eBay about; re-checking thousands of correct
// listings would burn the Trading API daily quota for nothing.
export const isSuspectSku = (sku) => {
  const s = String(sku || '').trim()
  if (!s) return true
  return /^EBH?-\d{6,}$/i.test(s) || /-\d{10,}$/.test(s)
}

export default function SkuReconcile({ storeId, parts = [], onApplied }) {
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState('')
  const [skip, setSkip] = useState(() => new Set())   // partIds the user unticked
  const [applying, setApplying] = useState(false)
  const [applied, setApplied] = useState(0)

  const call = async (payload) => {
    const { data: { session } } = await sb.auth.getSession()
    const res = await fetch(EBAY_FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify({ storeId, ...payload }),
    })
    const d = await res.json()
    if (!res.ok || d.error) throw new Error(d.error || 'Request failed')
    return d
  }

  // Only listed parts whose SKU we clearly generated ourselves. Sold/history
  // (EBH-) parts are deliberately left alone — they need no shelf location.
  const suspects = useMemo(
    () => parts.filter(p => p.status === 'listed' && isSuspectSku(p.sku)),
    [parts])

  // keepApplied: the re-scan after Apply must NOT wipe the success banner.
  const scan = async ({ keepApplied = false } = {}) => {
    setScanning(true); setErr(''); setRows(null); setSkip(new Set())
    if (!keepApplied) setApplied(0)
    try {
      const ids = suspects.map(p => p.id)
      if (!ids.length) { setRows([]); setScanning(false); return }
      const all = []
      let offset = 0
      for (;;) {
        const d = await call({ action: 'sku_reconcile_report', offset, partIds: ids })
        all.push(...(d.rows || []))
        setProgress({ done: all.length, total: d.total || 0 })
        if (!d.hasMore) break
        offset = d.nextOffset
      }
      setRows(all)
    } catch (e) { setErr(e.message) }
    setScanning(false)
  }

  // Classify against the FULL set: a label still used by 2+ live listings means
  // it hasn't been shelved yet — we must not copy it down (it can't be unique).
  const cls = useMemo(() => {
    if (!rows) return null
    const count = {}
    rows.forEach(r => { const s = (r.ebaySku || '').trim(); if (s) count[s] = (count[s] || 0) + 1 })
    const match = [], update = [], blocked = [], noLabel = [], errored = []
    for (const r of rows) {
      const e = (r.ebaySku || '').trim()
      if (r.error) errored.push(r)
      else if (!e) noLabel.push(r)
      else if (e === (r.currentSku || '')) match.push(r)
      else if (count[e] > 1) blocked.push(r)
      else update.push(r)
    }
    return { match, update, blocked, noLabel, errored, count }
  }, [rows])

  const chosen = useMemo(() => (cls?.update || []).filter(r => !skip.has(r.partId)), [cls, skip])

  const apply = async () => {
    if (!chosen.length) return
    setApplying(true); setErr('')
    try {
      const d = await call({ action: 'sku_reconcile_apply', updates: chosen.map(r => ({ partId: r.partId, newSku: r.ebaySku })) })
      setApplied(d.updated || 0)
      onApplied?.()                      // refresh Inventory so the new SKUs show
      await scan({ keepApplied: true })  // re-scan, but keep the success banner
    } catch (e) { setErr(e.message) }
    setApplying(false)
  }

  const toggle = (id) => setSkip(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const th = { textAlign: 'left', padding: '7px 10px', fontSize: 11, color: C.muted, fontWeight: 700, whiteSpace: 'nowrap' }
  const td = { padding: '6px 10px', fontSize: 12, color: C.text, whiteSpace: 'nowrap' }
  const mono = { fontFamily: 'monospace' }

  return (
    <div style={{ ...S.card }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>🔄 Reconcile SKUs from eBay</div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 3, lineHeight: 1.6 }}>
            eBay is the source of truth. This asks eBay for the <strong>current</strong> custom label on the{' '}
            <strong>{suspects.length}</strong> listed part{suspects.length === 1 ? '' : 's'} whose SKU we generated ourselves
            (<code>EB-…</code> / item-id suffixed) and copies the real label back in.
            Scanning is read-only, and <strong>nothing is ever written to eBay</strong>.
          </div>
        </div>
        <button onClick={scan} disabled={scanning || !suspects.length} style={{ ...S.btn('primary'), opacity: (scanning || !suspects.length) ? 0.5 : 1 }}>
          {scanning ? `Scanning ${progress.done}/${progress.total || '…'}` : `🔍 Scan ${suspects.length || ''} on eBay`}
        </button>
      </div>

      {err && <div style={{ fontSize: 12, color: C.red, marginBottom: 10 }}>{err}</div>}

      {applied > 0 && !scanning && (
        <div style={{ padding: '12px 14px', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, marginBottom: 12 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.green }}>
            ✓ Done — {applied} SKU{applied === 1 ? '' : 's'} now match eBay
          </div>
          <div style={{ fontSize: 12, color: C.text, marginTop: 5, lineHeight: 1.7 }}>
            Updated in PartVault only — <strong>nothing was sent to eBay</strong>. Every change is in the activity log, so it can be undone.
            <br />
            <strong>What next:</strong>{' '}
            {cls?.blocked?.length
              ? <>the remaining <strong>{cls.blocked.length}</strong> listing{cls.blocked.length === 1 ? '' : 's'} still share a placeholder label on eBay — they're waiting to be shelved and relabelled. Come back and scan again once that's done and they'll drop in automatically.</>
              : <>everything scanned is now in sync. Nothing else to do.</>}
          </div>
        </div>
      )}

      {cls && (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            {[
              ['✅ Already match', cls.match.length, C.green],
              ['🔄 Will update', cls.update.length, C.blue],
              ['⛔ Not shelved yet', cls.blocked.length, C.yellow],
              ['⚪ No label on eBay', cls.noLabel.length, C.muted],
              ...(cls.errored.length ? [['⚠ Read error', cls.errored.length, C.red]] : []),
            ].map(([l, n, col]) => (
              <span key={l} style={{ ...S.pill(col), fontSize: 12 }}>{l}: <strong>{n}</strong></span>
            ))}
          </div>

          {cls.blocked.length > 0 && (
            <div style={{ padding: '10px 12px', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, fontSize: 12, color: '#92400e', marginBottom: 12, lineHeight: 1.6 }}>
              <strong>{cls.blocked.length} listing{cls.blocked.length === 1 ? '' : 's'} still share a placeholder label on eBay</strong> — they haven't been shelved yet, so the label isn't unique and can't be copied down.
              They're skipped safely; re-run this scan once they're shelved and given their real labels.
            </div>
          )}

          {cls.update.length > 0 && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>Review before applying — untick anything you don't want changed</div>
                <button onClick={apply} disabled={applying || !chosen.length}
                  style={{ ...S.btn('primary'), marginLeft: 'auto', padding: '6px 16px', fontSize: 12, opacity: (applying || !chosen.length) ? 0.5 : 1 }}>
                  {applying ? 'Applying…' : `Apply ${chosen.length} update${chosen.length === 1 ? '' : 's'}`}
                </button>
              </div>
              <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'auto', maxHeight: 420 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff' }}>
                  <thead><tr style={{ background: C.panel, position: 'sticky', top: 0 }}>
                    <th style={th}></th><th style={th}>PartVault now</th><th style={th}>→ eBay label</th><th style={th}>Title</th><th style={th}>eBay item</th>
                  </tr></thead>
                  <tbody>
                    {cls.update.map((r, i) => (
                      <tr key={r.partId} style={{ background: i % 2 ? '#fafafa' : '#fff', borderTop: `1px solid ${C.border}`, opacity: skip.has(r.partId) ? 0.45 : 1 }}>
                        <td style={td}><input type="checkbox" checked={!skip.has(r.partId)} onChange={() => toggle(r.partId)} /></td>
                        <td style={{ ...td, ...mono, color: C.red }}>{r.currentSku || '(blank)'}</td>
                        <td style={{ ...td, ...mono, color: C.green, fontWeight: 700 }}>{r.ebaySku}</td>
                        <td style={{ ...td, whiteSpace: 'normal', maxWidth: 380 }}>{r.title}</td>
                        <td style={{ ...td, ...mono, color: C.muted }}>{r.itemId}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {cls.update.length === 0 && applied === 0 && (
            <div style={{ fontSize: 13, color: C.text, lineHeight: 1.7 }}>
              {cls.blocked.length
                ? <>Nothing can be updated right now — the {cls.blocked.length} listing{cls.blocked.length === 1 ? '' : 's'} above still carry a shared placeholder label on eBay. Scan again once they've been shelved and relabelled.</>
                : <span style={{ color: C.green, fontWeight: 600 }}>✓ Every scanned listing's SKU already matches eBay — nothing to do.</span>}
            </div>
          )}
        </>
      )}
    </div>
  )
}
