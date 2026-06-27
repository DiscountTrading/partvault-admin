import { useState, useEffect, useCallback } from 'react'
import { C, S, fmt, estimateCostBasis, storageCostFor, rentPerDay } from '../lib/constants'
import { sb } from '../lib/supabase'

const EDGE_FN = 'https://mtpektsxaklhedknincs.supabase.co/functions/v1/ebay-import'
const WINDOW_DAYS = 90

const CATS = [
  ['purchase',    'Purchase (COGS)'],
  ['admin',       'Admin'],
  ['labour',      'Labour'],
  ['storage',     'Storage'],
  ['ebay_listing','eBay listing fees'],
  ['promotion',   'Promotion fees'],
  ['postage',     'Postage'],
]
const r2 = (n) => Math.round((+n || 0) * 100) / 100

// Build the costing object the cost functions expect (mirrors App.costingFull).
function buildCosting(settings) {
  const st = settings.storage || {}
  return {
    ...(settings.costing || {}),
    shipping: settings.shipping || undefined,
    storage: { volumeM3: +st.volumeM3 || 0, rentPerDay: rentPerDay(st.rent, st.rentPeriod), usablePct: +st.usablePct || 0 },
  }
}

export default function HistoricalCosts({ storeId }) {
  const [lock, setLock] = useState(null)        // { locked, computedAt, costs } | null
  const [draft, setDraft] = useState(null)      // freshly computed averages awaiting confirm
  const [meta, setMeta] = useState(null)        // { sampleSize, fvfRatio }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const loadLock = useCallback(async () => {
    if (!storeId) return
    const { data } = await sb.from('stores').select('settings').eq('id', storeId).single()
    setLock(data?.settings?.historicalCostLock || null)
  }, [storeId])
  useEffect(() => { loadLock() }, [loadLock])

  const compute = async () => {
    setBusy(true); setError(''); setDraft(null); setMeta(null)
    try {
      // 1. Settings → costing model.
      const { data: store } = await sb.from('stores').select('settings').eq('id', storeId).single()
      const costing = buildCosting(store?.settings || {})

      // 2. Last-90-day REAL (API) sales with their linked parts.
      const since = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString()
      const { data: sales, error: sErr } = await sb.from('ebay_sales')
        .select('part_id, ship_cost, fees, sold_at, source')
        .eq('store_id', storeId).eq('cancelled', false).gte('sold_at', since)
      if (sErr) throw new Error(sErr.message)
      const real = (sales || []).filter(s => s.source !== 'csv_orders_report' && s.part_id)
      if (!real.length) throw new Error('No recent real sales with a linked part to average from. Run a sync first, then try again.')

      const partIds = [...new Set(real.map(s => s.part_id))]
      const partById = new Map()
      for (let i = 0; i < partIds.length; i += 300) {
        const slice = partIds.slice(i, i + 300)
        const { data: parts } = await sb.from('parts')
          .select('id, costs, list_price, weight, removal_minutes, category, acquired_date, sold_date, created_at')
          .in('id', slice)
        ;(parts || []).forEach(p => partById.set(p.id, p))
      }

      // 3. Per-category totals across the sampled sales.
      const sum = { purchase: 0, admin: 0, labour: 0, storage: 0, postage: 0, fee: 0 }
      let n = 0
      for (const s of real) {
        const p = partById.get(s.part_id)
        if (!p) continue
        const b = estimateCostBasis(p, costing, 0, 0)
        const c = p.costs || {}
        const manualPost = +c.postage || 0
        sum.purchase += (+c.acquisition || 0) + (+c.carShare || 0) + b.baseCost
        sum.admin    += b.admin
        sum.labour   += b.labour
        sum.storage  += storageCostFor(p, costing).value
        sum.postage  += (+s.ship_cost > 0 ? +s.ship_cost : (manualPost > 0 ? manualPost : b.postage))
        sum.fee      += (+s.fees || 0)
        n++
      }
      if (!n) throw new Error('Could not match any sampled sales to a part.')

      // 4. Split the averaged eBay fee into listing vs promotion via the real 90-day ratio.
      const fr = await fetch(EDGE_FN, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'import_fees', storeId, days: WINDOW_DAYS, dryRun: true }),
      })
      const fd = await fr.json().catch(() => ({}))
      const fvfTotal = (+fd.saleFees || 0) + (+fd.otherFees || 0)
      const fvfRatio = fvfTotal > 0 ? (+fd.saleFees || 0) / fvfTotal : 1
      const avgFee = sum.fee / n

      const costs = {
        purchase:     r2(sum.purchase / n),
        admin:        r2(sum.admin / n),
        labour:       r2(sum.labour / n),
        storage:      r2(sum.storage / n),
        ebay_listing: r2(avgFee * fvfRatio),
        promotion:    r2(avgFee * (1 - fvfRatio)),
        postage:      r2(sum.postage / n),
      }
      setDraft(costs)
      setMeta({ sampleSize: n, fvfRatio })
    } catch (e) {
      setError(e.message || 'Compute failed')
    } finally {
      setBusy(false)
    }
  }

  const apply = async () => {
    if (!draft) return
    setBusy(true); setError('')
    try {
      const res = await fetch(EDGE_FN, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'apply_historical_costs', storeId, costs: draft, force: lock?.locked || false }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || d.error) throw new Error(d.error || d.message || `HTTP ${res.status}`)
      setDraft(null); setMeta(null)
      await loadLock()
    } catch (e) {
      setError(e.message || 'Apply failed')
    } finally {
      setBusy(false)
    }
  }

  const unlock = async () => {
    if (!window.confirm('Unlock historical costs?\n\nRecomputing will OVERWRITE the costs on every imported sale. If those figures have already been used in your accounts (e.g. exported to Xero), this will put them out of sync. Continue?')) return
    setBusy(true); setError('')
    try {
      const res = await fetch(EDGE_FN, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'unlock_historical_costs', storeId }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || d.error) throw new Error(d.error || d.message || `HTTP ${res.status}`)
      await loadLock()
    } catch (e) {
      setError(e.message || 'Unlock failed')
    } finally {
      setBusy(false)
    }
  }

  const isLocked = !!lock?.locked
  const shownCosts = draft || (isLocked ? lock.costs : null)
  const total = shownCosts ? CATS.reduce((a, [k]) => a + (+shownCosts[k] || 0), 0) : 0
  const fmtDate = (iso) => iso ? new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''

  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, padding: '18px 22px', marginBottom: 16, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>🧮 Historical sale costs</div>
        {isLocked && <span style={{ fontSize: 11, fontWeight: 700, color: C.green, background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 999, padding: '2px 8px' }}>🔒 Locked</span>}
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>
        Imported sales have no real cost. This averages your <strong>last {WINDOW_DAYS} days</strong> of real sales by category and applies that snapshot to every imported sale, so revenue never sits in the books without a cost. Computed once and locked — figures won’t drift as the average moves.
      </div>

      {shownCosts && (
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 14px', background: '#f9f8f5', marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>
            {draft ? 'Computed averages (per sale) — review before applying' : `Applied snapshot · ${fmtDate(lock.computedAt)}`}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px 16px', fontSize: 13, maxWidth: 340 }}>
            {CATS.map(([k, label]) => (
              <div key={k} style={{ display: 'contents' }}>
                <span style={{ color: C.muted }}>{label}</span>
                <span style={{ textAlign: 'right', color: C.text }}>{fmt(shownCosts[k])}</span>
              </div>
            ))}
            <span style={{ fontWeight: 700, color: C.text, borderTop: `1px solid ${C.border}`, paddingTop: 4 }}>Total cost / sale</span>
            <span style={{ fontWeight: 700, textAlign: 'right', color: C.text, borderTop: `1px solid ${C.border}`, paddingTop: 4 }}>{fmt(total)}</span>
          </div>
          {meta && <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>From {meta.sampleSize} recent sales · fee split {Math.round(meta.fvfRatio * 100)}% listing / {Math.round((1 - meta.fvfRatio) * 100)}% promotion</div>}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {draft ? (
          <>
            <button style={{ ...S.btn('primary'), opacity: busy ? 0.6 : 1 }} onClick={apply} disabled={busy}>{busy ? '⏳ Applying…' : '✓ Apply & lock'}</button>
            <button style={S.btn('secondary')} onClick={() => { setDraft(null); setMeta(null) }} disabled={busy}>Discard</button>
          </>
        ) : isLocked ? (
          <button style={{ ...S.btn('secondary'), opacity: busy ? 0.6 : 1 }} onClick={unlock} disabled={busy}>🔓 Unlock to recompute</button>
        ) : (
          <button style={{ ...S.btn('primary'), opacity: busy ? 0.6 : 1 }} onClick={compute} disabled={busy}>{busy ? '⏳ Computing…' : `Compute from last ${WINDOW_DAYS} days`}</button>
        )}
      </div>

      {error && <div style={{ fontSize: 12, color: C.red, marginTop: 10 }}>✗ {error}</div>}
    </div>
  )
}
