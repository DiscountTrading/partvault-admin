import { useState, useEffect, useCallback, useRef } from 'react'
import { C, S, fmt, estimateCostBasis, storageCostFor, rentPerDay } from '../lib/constants'
import { sb } from '../lib/supabase'

const EDGE_FN = 'https://mtpektsxaklhedknincs.supabase.co/functions/v1/ebay-import'
const WINDOW_DAYS = 90

// Value-scaling costs are a % of sale price; fixed costs are a flat $ per item.
const PCT_ROWS  = [['purchase_pct', 'Purchase (COGS)'], ['listing_pct', 'eBay listing fees'], ['promo_pct', 'Promotion fees']]
const FLAT_ROWS = [['postage', 'Postage'], ['storage', 'Storage'], ['admin', 'Admin'], ['labour', 'Labour']]
const r2 = (n) => Math.round((+n || 0) * 100) / 100

// Cost the model would assign to a sale at the given price.
const modelCost = (m, price) =>
  price * ((+m.purchase_pct || 0) + (+m.listing_pct || 0) + (+m.promo_pct || 0))
  + (+m.postage || 0) + (+m.storage || 0) + (+m.admin || 0) + (+m.labour || 0)

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
  const [lock, setLock] = useState(null)        // { locked, computedAt, model } | null
  const [draft, setDraft] = useState(null)      // freshly computed model awaiting confirm
  const [meta, setMeta] = useState(null)        // { sampleSize, fvfRatio }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Real fee/refund backfill from the Finances API (full history, 90-day windows).
  const [feeBusy, setFeeBusy] = useState(false)
  const [feeMsg, setFeeMsg] = useState('')
  const [feeResult, setFeeResult] = useState(null)
  const feeCancel = useRef(false)

  const backfillFees = async () => {
    setFeeBusy(true); setFeeResult(null); setError(''); feeCancel.current = false
    const agg = { windows: 0, ordersMatched: 0, updated: 0, feeTotal: 0, refundTotal: 0 }
    try {
      // Earliest recorded sale → how far back to walk.
      const { data: first } = await sb.from('ebay_sales').select('sold_at')
        .eq('store_id', storeId).not('sold_at', 'is', null)
        .order('sold_at', { ascending: true }).limit(1).maybeSingle()
      const earliestMs = first?.sold_at ? new Date(first.sold_at).getTime() : (Date.now() - 365 * 86400000)
      const WINDOW = 88 * 86400000
      let end = Date.now()
      while (end > earliestMs && !feeCancel.current) {
        const start = Math.max(earliestMs, end - WINDOW)
        setFeeMsg(`${new Date(start).toLocaleDateString('en-AU', { month: 'short', year: '2-digit' })} → ${new Date(end).toLocaleDateString('en-AU', { month: 'short', year: '2-digit' })}…`)
        const res = await fetch(EDGE_FN, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'import_fees', storeId, fromDate: new Date(start).toISOString(), toDate: new Date(end).toISOString() }),
        })
        const d = await res.json().catch(() => ({}))
        if (!res.ok || d.error) throw new Error(d.error || d.message || `HTTP ${res.status}`)
        agg.windows++
        agg.ordersMatched += d.ordersMatched || 0
        agg.updated += d.updated || 0
        agg.feeTotal += +d.feeTotal || 0
        agg.refundTotal += +d.refundTotal || 0
        end = start
      }
      setFeeResult({ ...agg, cancelled: feeCancel.current })
      setFeeMsg('')
    } catch (e) {
      setError(e.message || 'Fee backfill failed')
    } finally {
      setFeeBusy(false)
    }
  }

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
        .select('part_id, ship_cost, fees, sold_price, sold_at, source')
        .eq('store_id', storeId).eq('cancelled', false).gte('sold_at', since)
      if (sErr) throw new Error(sErr.message)
      const real = (sales || []).filter(s => s.source !== 'csv_orders_report' && s.part_id)
      if (!real.length) throw new Error('No recent real sales with a linked part to average from. Run a sync first, then try again.')

      const partIds = [...new Set(real.map(s => s.part_id))]
      const partById = new Map()
      for (let i = 0; i < partIds.length; i += 100) {
        const slice = partIds.slice(i, i + 100)
        const { data: parts, error: pErr } = await sb.from('parts')
          .select('*').eq('store_id', storeId).in('id', slice)
        if (pErr) throw new Error(`Reading parts: ${pErr.message}`)
        ;(parts || []).forEach(p => partById.set(p.id, p))
      }
      if (!partById.size) throw new Error(`Found ${real.length} recent sales with a part link, but none of those parts are readable (they may be deleted). Can’t average costs.`)

      // 3. Totals across the sampled sales (value-scaling vs fixed).
      const sum = { purchase: 0, admin: 0, labour: 0, storage: 0, postage: 0, fee: 0, sale: 0 }
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
        sum.sale     += (+s.sold_price || 0)
        n++
      }
      if (!n) throw new Error('Could not match any sampled sales to a part.')

      // 4. eBay fee → listing vs promotion split via the real 90-day ratio.
      const fr = await fetch(EDGE_FN, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'import_fees', storeId, days: WINDOW_DAYS, dryRun: true }),
      })
      const fd = await fr.json().catch(() => ({}))
      const fvfTotal = (+fd.saleFees || 0) + (+fd.otherFees || 0)
      const fvfRatio = fvfTotal > 0 ? (+fd.saleFees || 0) / fvfTotal : 1

      // Value-scaling categories as a fraction of total sales $; fixed as flat avg $.
      const saleBase = sum.sale > 0 ? sum.sale : 1
      const model = {
        purchase_pct: sum.purchase / saleBase,
        listing_pct:  (sum.fee * fvfRatio) / saleBase,
        promo_pct:    (sum.fee * (1 - fvfRatio)) / saleBase,
        postage: r2(sum.postage / n),
        storage: r2(sum.storage / n),
        admin:   r2(sum.admin / n),
        labour:  r2(sum.labour / n),
      }
      setDraft(model)
      setMeta({ sampleSize: n, fvfRatio, avgSale: sum.sale / n })
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
        body: JSON.stringify({ action: 'apply_historical_costs', storeId, model: draft, force: lock?.locked || false }),
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
  const model = draft || (isLocked ? lock.model : null)
  const fmtDate = (iso) => iso ? new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''

  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, padding: '18px 22px', marginBottom: 16, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>🧮 Historical sale costs</div>
        {isLocked && <span style={{ fontSize: 11, fontWeight: 700, color: C.green, background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 999, padding: '2px 8px' }}>🔒 Locked</span>}
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>
        Imported sales have no real cost. This builds a cost model from your <strong>last {WINDOW_DAYS} days</strong> of real sales — value-scaling costs (purchase, eBay &amp; promotion fees) as a <strong>% of sale price</strong>, fixed costs (postage, storage, admin, labour) as a <strong>flat $</strong> — then applies it to every imported sale and locks it.
      </div>

      {model && (
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 14px', background: '#f9f8f5', marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>
            {draft ? 'Computed cost model — review before applying' : `Applied model · ${fmtDate(lock.computedAt)}`}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px 16px', fontSize: 13, maxWidth: 340 }}>
            {PCT_ROWS.map(([k, label]) => (
              <div key={k} style={{ display: 'contents' }}>
                <span style={{ color: C.muted }}>{label}</span>
                <span style={{ textAlign: 'right', color: C.text }}>{((+model[k] || 0) * 100).toFixed(1)}% of sale</span>
              </div>
            ))}
            {FLAT_ROWS.map(([k, label]) => (
              <div key={k} style={{ display: 'contents' }}>
                <span style={{ color: C.muted }}>{label}</span>
                <span style={{ textAlign: 'right', color: C.text }}>{fmt(model[k])} flat</span>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 12, color: C.text, marginTop: 10, paddingTop: 8, borderTop: `1px solid ${C.border}` }}>
            Worked examples: a <strong>$50</strong> sale → cost <strong>{fmt(modelCost(model, 50))}</strong> · a <strong>$500</strong> sale → cost <strong>{fmt(modelCost(model, 500))}</strong>
          </div>
          {meta && <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>From {meta.sampleSize} recent sales (avg sale {fmt(meta.avgSale)}) · fee split {Math.round(meta.fvfRatio * 100)}% listing / {Math.round((1 - meta.fvfRatio) * 100)}% promotion</div>}
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

      {/* Real fees/refunds from the Finances API — overrides the modelled estimate
          for any sale eBay still has financial records for (≈4 years back). */}
      <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 4 }}>💳 Real eBay fees &amp; refunds</div>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>
          Pulls actual fees &amp; refunds from eBay’s Finances API across your whole history and writes them onto matching sales (by order + line). Sales with a real figure use it instead of the modelled estimate; unmatched orders are skipped. Safe to re-run.
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {feeBusy
            ? <button style={S.btn('danger')} onClick={() => { feeCancel.current = true }}>Stop</button>
            : <button style={{ ...S.btn('secondary'), opacity: busy ? 0.6 : 1 }} onClick={backfillFees} disabled={busy}>Backfill real fees &amp; refunds</button>}
          {feeMsg && <span style={{ fontSize: 12, color: C.muted }}>⏳ {feeMsg}</span>}
        </div>
        {feeResult && (
          <div style={{ fontSize: 12, color: C.green, background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 8, padding: '8px 12px', marginTop: 10 }}>
            ✓ {feeResult.windows} windows · {feeResult.updated} sale lines updated · {fmt(feeResult.feeTotal)} fees · {fmt(feeResult.refundTotal)} refunds{feeResult.cancelled ? ' (stopped)' : ''}.
            <span style={{ color: C.muted }}> Reload to see updated figures.</span>
          </div>
        )}
      </div>

      {error && <div style={{ fontSize: 12, color: C.red, marginTop: 10 }}>✗ {error}</div>}
    </div>
  )
}
