import { useState, useMemo } from 'react'
import { C, S, fmt, partEffectiveCost, estimateCostBasis, storageCostFor, storageConfigured, FEE_COST_KEYS } from '../lib/constants'
import { printLabels } from '../lib/labels'
import { getActiveMarketplace } from '../lib/marketplaces'

// Simple printable packing slip for one sale (opens the browser print dialog).
// Postage labels themselves are bought on eBay (no public label-purchase API in
// AU) — the "eBay ↗" button deep-links to the order for that.
function printPackingSlip(sale, part) {
  const st = sale.shipTo || {}
  const w = window.open('', '_blank', 'width=650,height=800')
  if (!w) return
  w.document.write(`<!doctype html><html><head><title>Packing slip ${sale.orderId}</title>
    <style>body{font-family:Arial,sans-serif;padding:28px;color:#111}h1{font-size:18px;margin:0 0 2px}
    .muted{color:#666;font-size:12px}.box{border:1px solid #ccc;border-radius:8px;padding:14px;margin-top:14px}
    table{width:100%;border-collapse:collapse;margin-top:6px;font-size:13px}td,th{padding:6px 8px;text-align:left;border-bottom:1px solid #eee}
    .addr{font-size:15px;line-height:1.5}</style></head><body>
    <h1>Packing slip</h1>
    <div class="muted">Order ${sale.orderId} · sold ${sale.soldAt ? new Date(sale.soldAt).toLocaleDateString() : ''}${sale.buyer ? ` · buyer: ${sale.buyer}` : ''}</div>
    <div class="box"><div class="muted">SHIP TO</div><div class="addr">
      ${[st.name, st.addressLine1, st.addressLine2, [st.city, st.state, st.postcode].filter(Boolean).join(' '), st.country].filter(Boolean).map(x => `${x}<br/>`).join('') || '(address not on file — see the eBay order)'}
    </div></div>
    <div class="box"><table><tr><th>Item</th><th>SKU</th><th>Qty</th></tr>
      <tr><td>${(part?.title || sale.title || '').replace(/</g, '&lt;')}</td><td>${part?.sku || sale.sku || '—'}</td><td>${sale.quantity ?? 1}</td></tr>
    </table></div>
    <script>window.onload=()=>window.print()</script></body></html>`)
  w.document.close()
}

const PERIODS = [[30, '30d'], [90, '90d'], [365, '12mo'], [0, 'All']]
const RENDER_CAP = 400

const fmtDate = t => t ? new Date(t).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: '2-digit' }) : '—'
// Net to the seller for a line: item + shipping paid − refund − eBay fee.
export const saleNet = s => (+s.soldPrice || 0) + (+s.shipping || 0) - (+s.refund || 0) - (+s.fees || 0)

// Friendly labels for eBay fee types (from the Finances API).
const FEE_LABELS = {
  FINAL_VALUE_FEE: 'Final value fee',
  FINAL_VALUE_FEE_FIXED_PER_ORDER: 'Fixed fee (per order)',
  PROMOTION: 'Promotion / ad fee',
  AD_FEE: 'Promotion / ad fee',
  INTERNATIONAL_FEE: 'International fee',
  REGULATORY_OPERATING_FEE: 'Regulatory fee',
}
const prettyFee = (k) => FEE_LABELS[k] || k.replace(/[_-]+/g, ' ').toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase())

// Resolve a sale's money + cost from the right source: a matched inventory part
// gives the live cost model; an imported (historical) sale uses its locked snapshot.
// eBay fee is its own column (and in Net); Cost is goods + overhead only, so
// Net − Cost = Profit reads cleanly. Returns a per-category breakdown for the tooltip.
function deriveSale(s, partById, costing) {
  const p = s.partId && partById.get(s.partId)
  const hc = s.source === 'csv_orders_report' && s.costs ? s.costs : null
  // Prefer REAL fees (Finances backfill) over the modelled estimate; fall back to the
  // snapshot only where eBay has no financial record for the sale.
  const realFee = +s.fees || 0
  const fee = realFee > 0 ? realFee : (hc ? (+hc.ebay_listing || 0) + (+hc.promotion || 0) : 0)
  const net = (+s.soldPrice || 0) + (+s.shipping || 0) - (+s.refund || 0) - fee
  let cost = null, breakdown = null
  if (p) {
    cost = partEffectiveCost(p, costing).value
    const b = estimateCostBasis(p, costing, 0, 0)
    const c = p.costs || {}
    const useStorage = storageConfigured(costing)
    const manualPost = +c.postage || 0
    // Enumerate EVERY actual cost — each recorded part cost (by its own name) plus the
    // estimated supplements — decomposed exactly as partEffectiveCost combines them, so
    // the lines sum to Cost with no catch-all. Unexpected keys (e.g. a legacy ebay_fees)
    // show under their own name rather than hiding in an "Other".
    const LABELS = { acquisition: 'Purchase', carShare: 'Purchase', car_share: 'Purchase', labour: 'Labour', admin: 'Admin', packaging: 'Packaging', holding: 'Holding', postage: 'Postage', storage: 'Storage', ebay_fees: 'eBay fees', ebayFees: 'eBay fees' }
    const pretty = (k) => LABELS[k] || k.replace(/[_-]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())
    const bd = {}
    const add = (label, v) => { if (!v) return; bd[label] = (bd[label] || 0) + v }
    for (const [k, raw] of Object.entries(c)) {
      const v = +raw || 0
      if (!v) continue
      if (k === 'postage') continue                 // handled with the postage estimate below
      if (k === 'storage' && useStorage) continue   // replaced by the warehouse calc below
      if (FEE_COST_KEYS.includes(k)) continue       // eBay fees aren't COGS (tracked on the sale)
      add(pretty(k), v)
    }
    add('Purchase', b.baseCost)
    add('Labour', b.labour)
    add('Admin', b.admin)
    add('Postage', manualPost > 0 ? manualPost : b.postage)
    if (useStorage) add('Storage', storageCostFor(p, costing).value)
    breakdown = bd
  } else if (hc) {
    breakdown = { Purchase: +hc.purchase || 0, Admin: +hc.admin || 0, Labour: +hc.labour || 0, Storage: +hc.storage || 0,
      Postage: +s.shipCost > 0 ? +s.shipCost : (+hc.postage || 0) } // real label cost wins
    cost = Object.values(breakdown).reduce((a, v) => a + v, 0)
  }
  // Fee breakdown: real per-type split where we have it, else the modelled
  // listing/promotion split for imported history.
  let feeBreakdown = null
  if (s.feeDetail && Object.keys(s.feeDetail).length) {
    feeBreakdown = {}
    for (const [k, v] of Object.entries(s.feeDetail)) if (Math.abs(+v) > 0.005) feeBreakdown[prettyFee(k)] = (feeBreakdown[prettyFee(k)] || 0) + (+v)
  } else if (hc) {
    const fb = {}
    if (+hc.ebay_listing) fb['Final value fee'] = +hc.ebay_listing
    if (+hc.promotion) fb['Promotion / ad fee'] = +hc.promotion
    if (Object.keys(fb).length) feeBreakdown = fb
  }
  return { p, fee, net, cost, breakdown, feeBreakdown, profit: cost != null ? net - cost : null }
}

// ---- Trend graphs ---------------------------------------------------------
// All client-side from the sales the tab already loads. Buckets are calendar
// periods (day/week/month/year); the newest bucket is in-progress and the
// "vs previous" figure compares it to the SAME elapsed point in the prior
// period (month-to-date vs same-day-last-month), so the comparison is fair
// rather than a partial period against a full one.
const DAY = 86400000
const startOfDayMs = t => { const x = new Date(t); x.setHours(0, 0, 0, 0); return x.getTime() }
const startOfWeekMs = t => { const x = new Date(t); x.setHours(0, 0, 0, 0); const dow = (x.getDay() + 6) % 7; x.setDate(x.getDate() - dow); return x.getTime() } // Monday start
const GRAINS = [
  { id: 'day', label: 'Day', n: 30 },
  { id: 'week', label: 'Week', n: 13 },
  { id: 'month', label: 'Month', n: 12 },
  { id: 'year', label: 'Year', n: 5 },
]
// Start (ms) of the bucket `i` steps back from the bucket containing `now`.
const bucketStartMs = (grain, now, i) => {
  const d = new Date(now)
  if (grain === 'day') return startOfDayMs(d.getTime() - i * DAY)
  if (grain === 'week') return startOfWeekMs(d.getTime() - i * 7 * DAY)
  if (grain === 'month') return new Date(d.getFullYear(), d.getMonth() - i, 1).getTime()
  return new Date(d.getFullYear() - i, 0, 1).getTime()
}
const bucketKeyMs = (grain, t) => {
  const d = new Date(t)
  if (grain === 'day') return startOfDayMs(t)
  if (grain === 'week') return startOfWeekMs(t)
  if (grain === 'month') return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  return new Date(d.getFullYear(), 0, 1).getTime()
}
const bucketLabel = (grain, ms) => {
  const d = new Date(ms)
  if (grain === 'year') return String(d.getFullYear())
  if (grain === 'month') return d.toLocaleDateString('en-AU', { month: 'short', year: '2-digit' })
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
}
const grainNoun = { day: 'day', week: 'week', month: 'month', year: 'year' }
// Human label for the window a grain covers, e.g. month → "last 12 months".
const grainWindowLabel = id => { const g = GRAINS.find(x => x.id === id); return `last ${g.n} ${id}${g.n === 1 ? '' : 's'}` }
const METRICS = [
  { id: 'net', label: 'Net sales', money: true },
  { id: 'profit', label: 'Profit', money: true },
  { id: 'orders', label: 'Orders', money: false },
]
const metricVal = (id, x) => id === 'orders' ? 1 : id === 'profit' ? (x.profit == null ? 0 : x.profit) : x.net
const signedMoney = v => (v < 0 ? '−' : '') + fmt(Math.abs(v))
const showMetric = (v, money) => money ? signedMoney(v) : String(Math.round(v))

const AD_FEE_KEYS = ['PROMOTION', 'AD_FEE', 'AD_FEE_PROMOTED_LISTINGS', 'PROMOTED_LISTINGS_FEE']
const adFeeOf = s => {
  if (!s.feeDetail) return 0
  let a = 0
  for (const [k, v] of Object.entries(s.feeDetail)) if (AD_FEE_KEYS.includes(k)) a += Math.abs(+v || 0)
  return a
}
const daysBetween = (from, to) => { if (!from || !to) return null; const d = Math.floor((new Date(to).getTime() - new Date(from).getTime()) / DAY); return d >= 0 ? d : null }

const pillStyle = (active) => ({ padding: '6px 13px', borderRadius: 18, border: `1.5px solid ${active ? C.accent : C.border}`, background: active ? C.accent : '#fff', color: active ? '#fff' : C.muted, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' })

function DeltaBadge({ delta }) {
  const up = delta >= 0
  const col = up ? C.green : C.red
  return <span style={{ fontSize: 13, fontWeight: 700, color: col, background: col + '15', border: `1px solid ${col}33`, borderRadius: 6, padding: '2px 8px', whiteSpace: 'nowrap' }}>{up ? '▲' : '▼'} {Math.abs(delta).toFixed(0)}%</span>
}

// Small SVG donut chart (no dependency). slices: [{ label, value, color }].
function PieChart({ slices, size = 116 }) {
  const nonzero = slices.filter(s => s.value > 0)
  const total = nonzero.reduce((a, s) => a + s.value, 0)
  const r = size / 2, cx = r, cy = r, inner = r * 0.6
  if (total <= 0) return <svg width={size} height={size}><circle cx={cx} cy={cy} r={r} fill="#eee" /><circle cx={cx} cy={cy} r={inner} fill="#fff" /></svg>
  // A single 100% slice can't be drawn as an arc (degenerate) — render a full ring.
  if (nonzero.length === 1) return (
    <svg width={size} height={size}><circle cx={cx} cy={cy} r={r} fill={nonzero[0].color} /><circle cx={cx} cy={cy} r={inner} fill="#fff" /></svg>
  )
  const cumBefore = i => nonzero.slice(0, i).reduce((a, s) => a + s.value, 0)
  const p = (rad, a) => `${cx + rad * Math.cos(a)} ${cy + rad * Math.sin(a)}`
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {nonzero.map((s, i) => {
        const frac = s.value / total
        const a0 = -Math.PI / 2 + (cumBefore(i) / total) * 2 * Math.PI
        const a1 = a0 + frac * 2 * Math.PI
        const large = frac > 0.5 ? 1 : 0
        const d = `M ${p(r, a0)} A ${r} ${r} 0 ${large} 1 ${p(r, a1)} L ${p(inner, a1)} A ${inner} ${inner} 0 ${large} 0 ${p(inner, a0)} Z`
        return <path key={i} d={d} fill={s.color} />
      })}
    </svg>
  )
}

// A donut + its legend (label · value · %), side by side.
function PieWithLegend({ title, slices }) {
  const total = slices.reduce((a, s) => a + s.value, 0)
  return (
    <div style={{ flex: '1 1 220px', minWidth: 200 }}>
      <div style={{ fontSize: 12, color: C.muted, fontWeight: 600, marginBottom: 8 }}>{title}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <PieChart slices={slices} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {slices.map((s, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: C.text }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: s.color, flexShrink: 0 }} />
              <span style={{ minWidth: 96 }}>{s.label}</span>
              <span style={{ fontWeight: 700 }}>{s.value}</span>
              <span style={{ color: C.muted }}>{total > 0 ? `${Math.round((s.value / total) * 100)}%` : '0%'}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// Vertical bar chart with a zero baseline so negative buckets (a loss-making
// period on the Profit metric) render below the line in red.
function BarChart({ bars, money }) {
  const vals = bars.map(b => b.value)
  const maxPos = Math.max(0, ...vals)
  const minNeg = Math.min(0, ...vals)
  const span = (maxPos - minNeg) || 1
  const H = 140
  const topPad = (maxPos / span) * H // pixels from top down to the zero line
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 3, height: H, borderBottom: minNeg < 0 ? 'none' : `1px solid ${C.border}` }}>
        {bars.map((b, i) => {
          const posH = b.value >= 0 ? (b.value / span) * H : 0
          const negH = b.value < 0 ? (Math.abs(b.value) / span) * H : 0
          const col = b.value < 0 ? C.red : b.current ? C.accent : '#93b4e8'
          return (
            <div key={i} title={`${b.label}: ${showMetric(b.value, money)}`}
              style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <div style={{ height: Math.max(0, topPad - posH) }} />
              {posH > 0 && <div style={{ height: posH, background: col, borderRadius: '3px 3px 0 0', minHeight: 2 }} />}
              {negH > 0 && <div style={{ height: negH, background: col, borderRadius: '0 0 3px 3px', minHeight: 2 }} />}
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: 3, marginTop: 5 }}>
        {bars.map((b, i) => (
          <div key={i} style={{ flex: 1, minWidth: 0, textAlign: 'center', fontSize: 9.5, color: b.current ? C.text : C.muted, fontWeight: b.current ? 700 : 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'clip' }}>
            {b.showLabel ? b.label : ''}
          </div>
        ))}
      </div>
    </div>
  )
}

// Promoted-listing effectiveness. eBay charges the Promoted Listings ad fee only
// when a promoted item sells, so we can compare promoted vs organic on what sold
// (turnover speed + profit after the ad fee). Spend on promoted listings that
// never sold needs the eBay Marketing API (not yet connected) — flagged below.
function PromotedPanel({ promo, periodLabel }) {
  // One-time explanatory note — dismissed for good once "Got it" is clicked.
  const [noteHidden, setNoteHidden] = useState(() => { try { return localStorage.getItem('pv_promo_note') === 'hidden' } catch { return false } })
  const dismissNote = () => { try { localStorage.setItem('pv_promo_note', 'hidden') } catch { /* ignore */ } setNoteHidden(true) }

  const tile = (label, value, sub, color) => (
    <div style={{ flex: '1 1 130px', minWidth: 120 }}>
      <div style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 19, fontWeight: 800, color: color || C.text, marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 10.5, color: C.muted, marginTop: 1 }}>{sub}</div>}
    </div>
  )
  const dtsFaster = promo.proDts != null && promo.orgDts != null ? promo.orgDts - promo.proDts : null
  const profitDiff = promo.proProfit != null && promo.orgProfit != null ? promo.proProfit - promo.orgProfit : null

  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 12, padding: '14px 18px', marginBottom: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 800, color: C.text, marginBottom: 14 }}>📣 Promoted vs organic <span style={{ fontWeight: 500, color: C.muted, fontSize: 12 }}>· {periodLabel}</span></div>
      {promo.orders === 0 ? (
        <div style={{ fontSize: 13, color: C.muted }}>No sales in this period.</div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', marginBottom: 16 }}>
            <PieWithLegend title="Share of sales" slices={[
              { label: 'Promoted', value: promo.promoted, color: C.accent },
              { label: 'Organic', value: promo.organic, color: '#93b4e8' },
            ]} />
            {promo.promoted > 0 && <PieWithLegend title="Promoted by ad rate (% of sale)" slices={[
              { label: 'Low ≤3%', value: promo.tiers.low, color: '#4b9e6a' },
              { label: 'Med 3–8%', value: promo.tiers.med, color: '#d99a2b' },
              { label: 'High >8%', value: promo.tiers.high, color: '#e8590c' },
            ]} />}
          </div>

          {promo.promoted > 0 ? (
            <>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
                {tile('Ad spend', signedMoney(promo.adSpend), promo.adPct != null ? `${promo.adPct.toFixed(1)}% of promoted sales` : null)}
                {tile('Avg days to sell', promo.proDts != null ? `${Math.round(promo.proDts)}d` : '—', promo.orgDts != null ? `organic ${Math.round(promo.orgDts)}d` : 'promoted', dtsFaster != null ? (dtsFaster >= 0 ? C.green : C.red) : null)}
                {tile('Avg profit / order', promo.proProfit != null ? signedMoney(promo.proProfit) : '—', promo.orgProfit != null ? `organic ${signedMoney(promo.orgProfit)}` : 'promoted', profitDiff != null ? (profitDiff >= 0 ? C.green : C.red) : null)}
              </div>
              {(dtsFaster != null || profitDiff != null) && (
                <div style={{ fontSize: 13, color: C.muted }}>
                  Vs organic, promoted items{' '}
                  {dtsFaster != null && <span style={{ color: dtsFaster >= 0 ? C.green : C.text, fontWeight: 600 }}>sell {Math.abs(Math.round(dtsFaster))} day{Math.abs(Math.round(dtsFaster)) === 1 ? '' : 's'} {dtsFaster >= 0 ? 'faster' : 'slower'}</span>}
                  {dtsFaster != null && profitDiff != null && ' and '}
                  {profitDiff != null && <span style={{ color: profitDiff >= 0 ? C.green : C.text, fontWeight: 600 }}>net {signedMoney(profitDiff)} {profitDiff >= 0 ? 'more' : 'less'} per order</span>}.
                </div>
              )}
            </>
          ) : (
            <div style={{ fontSize: 13, color: C.muted }}>No promoted-listing sales in this period — nothing to compare against organic yet.</div>
          )}

          {!noteHidden && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 11, color: C.muted, marginTop: 14, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: '9px 11px' }}>
              <span style={{ flex: 1, lineHeight: 1.5 }}>Ad fee is only billed on promoted items that <em>sold</em>, so this compares sold promoted vs sold organic. Spend on promoted listings that didn't sell needs the eBay Marketing API (coming soon). Days-to-sell counts matched inventory items only.</span>
              <button onClick={dismissNote} style={{ ...S.btn('secondary'), padding: '4px 10px', fontSize: 11, whiteSpace: 'nowrap' }}>Got it</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// One clickable stage in the fulfilment tracker. `locked` = eBay-owned (Posted),
// shown as status only.
function StagePill({ label, done, locked, onClick, tip }) {
  const col = done ? C.green : C.muted
  return (
    <button disabled={locked} onClick={onClick} title={tip}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 16, border: `1.5px solid ${done ? C.green : C.border}`, background: done ? C.green + '15' : '#fff', color: col, fontSize: 11.5, fontWeight: 600, cursor: locked ? 'default' : 'pointer' }}>
      <span>{done ? '✓' : '○'}</span>{label}
    </button>
  )
}

// Fulfilment pipeline: every order sold in the last 30 days that isn't marked
// Delivered yet. Walks it Collected → Packed → Posted → Delivered, plus a
// feedback follow-up. Posted comes from eBay (fulfillment_status); the rest are
// our own toggles persisted in sale_workflow, shared live with the mobile
// "Collect" pick-list.
function FulfilmentQueue({ sales, partById, wf, setStage, now }) {
  const cutoff = now - 30 * 86400000
  const orders = sales
    .filter(s => !s.cancelled && !s.refunded && s.soldAt && new Date(s.soldAt).getTime() > cutoff)
    .map(s => ({ s, w: wf[s.id] || {} }))
    .filter(({ w }) => !w.delivered_at)
    .sort((a, b) => new Date(a.s.soldAt) - new Date(b.s.soldAt)) // oldest first — do those first
  if (!orders.length) return null
  const ebayDomain = getActiveMarketplace().ebayDomain
  const stamp = (saleId, key, cur) => setStage(saleId, { [key]: cur ? null : new Date().toISOString() })
  const orderUrl = s => `https://www.${ebayDomain}/mesh/ord/details?orderid=${encodeURIComponent(s.orderId)}`
  const collectedCount = orders.filter(o => o.w.collected_at).length

  return (
    <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 12, padding: '12px 16px', marginBottom: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 800, color: C.text, marginBottom: 10 }}>
        📦 Fulfilment — {orders.length} order{orders.length === 1 ? '' : 's'} in progress
        <span style={{ fontWeight: 500, color: C.muted, fontSize: 12 }}> · {collectedCount} collected</span>
      </div>
      {orders.map(({ s, w }) => {
        const p = s.partId ? partById.get(s.partId) : null
        const thumb = p?.photos?.[0]?.url
        const posted = s.fulfillmentStatus === 'FULFILLED'
        const days = Math.floor((now - new Date(s.soldAt).getTime()) / 86400000)
        return (
          <div key={s.id} style={{ padding: '10px 0', borderTop: '1px solid #fde68a' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {thumb
                ? <img src={thumb} alt="" style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 8, flexShrink: 0 }} />
                : <div style={{ width: 44, height: 44, borderRadius: 8, background: '#fef3c7', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0 }}>📦</div>}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p?.title || s.title}</div>
                <div style={{ fontSize: 11, color: C.muted }}>
                  {p?.sku || s.sku || 'no SKU'} · {fmt(s.soldPrice)}{s.shipping > 0 ? ` + ${fmt(s.shipping)} post` : ''} · sold {fmtDate(s.soldAt)}
                  {!posted && days >= 2 && <span style={{ color: C.red, fontWeight: 700 }}> · {days} days, not posted</span>}
                  {s.buyer ? ` · ${s.buyer}` : ''}{s.shipTo?.city ? ` · ${s.shipTo.city}${s.shipTo.state ? ' ' + s.shipTo.state : ''}` : ''}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
              <StagePill label="Collected" done={!!w.collected_at} onClick={() => stamp(s.id, 'collected_at', w.collected_at)} tip="Pulled from inventory" />
              <StagePill label="Packed" done={!!w.packed_at} onClick={() => stamp(s.id, 'packed_at', w.packed_at)} tip="Boxed and ready to post" />
              <StagePill label="Posted" done={posted} locked tip={posted ? 'Marked shipped on eBay' : 'Set when you mark the order shipped on eBay'} />
              <StagePill label="Delivered" done={!!w.delivered_at} onClick={() => stamp(s.id, 'delivered_at', w.delivered_at)} tip="Confirmed arrived — clears from this queue" />
              <div style={{ flex: 1 }} />
              <button title="Print a packing slip with the ship-to address" onClick={() => printPackingSlip(s, p)} style={{ ...S.btn('secondary'), padding: '5px 10px', fontSize: 11 }}>🖨 Slip</button>
              {p && <button title="Reprint this part's SKU sticker" onClick={() => printLabels([p])} style={{ ...S.btn('secondary'), padding: '5px 10px', fontSize: 11 }}>🏷 SKU</button>}
              <a href={orderUrl(s)} target="_blank" rel="noreferrer" title="Open the order on eBay to buy the postage label" style={{ ...S.btn('secondary'), padding: '5px 10px', fontSize: 11, textDecoration: 'none', display: 'inline-block' }}>eBay ↗</a>
              <button title="Open the order on eBay to ask for feedback, and mark it requested here"
                onClick={() => { window.open(orderUrl(s), '_blank', 'noreferrer'); stamp(s.id, 'feedback_at', w.feedback_at) }}
                style={{ ...S.btn('secondary'), padding: '5px 10px', fontSize: 11, color: w.feedback_at ? C.green : C.text, borderColor: w.feedback_at ? C.green : undefined }}>
                {w.feedback_at ? '★ Feedback ✓' : '★ Feedback'}
              </button>
            </div>
          </div>
        )
      })}
      <div style={{ fontSize: 10.5, color: C.muted, marginTop: 10 }}>Postage labels are bought on eBay (eBay ↗). <strong>Posted</strong> ticks automatically once you mark the order shipped there. Mark <strong>Delivered</strong> to clear an order from this queue.</div>
    </div>
  )
}

export default function Sales({ sales = [], parts = [], costing = {}, wf = {}, setStage = () => {} }) {
  const [period, setPeriod] = useState(90)
  const [query, setQuery] = useState('')
  const [detail, setDetail] = useState(null) // sale whose cost breakdown is open
  const [limit, setLimit] = useState(RENDER_CAP)
  const [now] = useState(() => Date.now()) // one clock read per mount — keeps render pure

  const partById = useMemo(() => new Map(parts.filter(p => !p.deletedAt).map(p => [p.id, p])), [parts])

  // Performance graphs (top of tab) — derive money + turnover per sale once, then
  // slice it by calendar bucket. Independent of the table's period/search filters.
  const [grain, setGrain] = useState('month')
  const [metric, setMetric] = useState('net')

  const derivedAll = useMemo(() => sales.filter(s => !s.cancelled).map(s => {
    const d = deriveSale(s, partById, costing)
    const p = d.p
    const adFee = adFeeOf(s)
    const gross = (+s.soldPrice || 0) + (+s.shipping || 0)
    return {
      t: s.soldAt ? new Date(s.soldAt).getTime() : null,
      net: d.net,
      profit: d.profit,
      gross,
      adFee,
      promoted: adFee > 0.005,
      adRate: adFee > 0.005 && gross > 0 ? (adFee / gross) * 100 : null, // ad fee as % of sale
      dts: p ? daysBetween(p.listedDate || p.acquiredDate || p.createdAt, s.soldAt) : null,
    }
  }).filter(x => x.t), [sales, partById, costing])

  const chart = useMemo(() => {
    const g = GRAINS.find(x => x.id === grain)
    const keys = []
    for (let i = g.n - 1; i >= 0; i--) keys.push(bucketStartMs(grain, now, i))
    const sums = new Map(keys.map(k => [k, 0]))
    for (const x of derivedAll) { const k = bucketKeyMs(grain, x.t); if (sums.has(k)) sums.set(k, sums.get(k) + metricVal(metric, x)) }
    const m = METRICS.find(x => x.id === metric)
    const step = Math.max(1, Math.ceil(keys.length / 6))
    const bars = keys.map((k, i) => ({ label: bucketLabel(grain, k), value: sums.get(k), current: i === keys.length - 1, showLabel: i % step === 0 || i === keys.length - 1 }))
    return { bars, money: m.money }
  }, [derivedAll, grain, metric, now])

  // Current bucket-to-date vs the same elapsed point in the previous bucket.
  const compare = useMemo(() => {
    const curStart = bucketStartMs(grain, now, 0)
    const prevStart = bucketStartMs(grain, now, 1)
    const prevEnd = prevStart + (now - curStart)
    let cur = 0, prev = 0
    for (const x of derivedAll) {
      const v = metricVal(metric, x)
      if (x.t >= curStart && x.t <= now) cur += v
      else if (x.t >= prevStart && x.t <= prevEnd) prev += v
    }
    return { cur, prev, delta: prev !== 0 ? ((cur - prev) / Math.abs(prev)) * 100 : null }
  }, [derivedAll, grain, metric, now])

  const rows = useMemo(() => {
    const cutoff = period ? now - period * 86400000 : 0
    const q = query.trim().toLowerCase()
    return sales
      .filter(s => !s.cancelled && (!period || (s.soldAt && new Date(s.soldAt).getTime() >= cutoff)))
      .filter(s => {
        if (!q) return true
        // Search the local record where we have one, plus the eBay text as a fallback.
        const p = s.partId && partById.get(s.partId)
        return `${p ? `${p.title} ${p.sku}` : ''} ${s.title} ${s.sku}`.toLowerCase().includes(q)
      })
  }, [sales, period, query, partById, now])

  const totals = useMemo(() => rows.reduce((a, s) => {
    const d = deriveSale(s, partById, costing)
    a.gross += (+s.soldPrice || 0) + (+s.shipping || 0)
    a.refunds += (+s.refund || 0)
    a.fees += d.fee
    a.net += d.net
    if (d.cost != null) { a.cogs += d.cost; a.matched++ }
    return a
  }, { gross: 0, refunds: 0, fees: 0, net: 0, cogs: 0, matched: 0 }), [rows, partById, costing])

  // Promoted vs organic, scoped to the selected period (not the search box).
  // Scoped to the SAME window the trend chart covers (driven by the Day/Week/
  // Month/Year toggle), so changing that toggle moves the chart and the pies
  // together rather than the pies quietly tracking the table's period filter.
  const promo = useMemo(() => {
    const g = GRAINS.find(x => x.id === grain)
    const cutoff = bucketStartMs(grain, now, g.n - 1)
    const inWin = derivedAll.filter(x => x.t >= cutoff)
    const pro = inWin.filter(x => x.promoted)
    const org = inWin.filter(x => !x.promoted)
    const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0)
    const avg = (arr, f) => { const v = arr.map(f).filter(n => n != null); return v.length ? v.reduce((a, n) => a + n, 0) / v.length : null }
    const adSpend = sum(pro, x => x.adFee)
    const proRev = sum(pro, x => x.net + x.adFee)
    // Split promoted sales by ad rate (ad fee as % of sale): Low ≤3%, Med 3–8%, High >8%.
    const tiers = { low: 0, med: 0, high: 0 }
    for (const x of pro) { const r = x.adRate ?? 0; if (r <= 3) tiers.low++; else if (r <= 8) tiers.med++; else tiers.high++ }
    return {
      orders: inWin.length, promoted: pro.length, organic: org.length,
      adSpend, adPct: proRev > 0 ? (adSpend / proRev) * 100 : null,
      proProfit: avg(pro, x => x.profit), orgProfit: avg(org, x => x.profit),
      proDts: avg(pro, x => x.dts), orgDts: avg(org, x => x.dts),
      tiers,
    }
  }, [derivedAll, grain, now])

  const shown = rows.slice(0, limit)

  // Export the currently-filtered rows (all of them, not just those rendered) to CSV.
  const exportCsv = () => {
    const esc = (v) => { const x = String(v ?? ''); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x }
    const header = ['Date', 'Item', 'SKU', 'Qty', 'Sale', 'Shipping', 'Fee', 'Refund', 'Net', 'Cost', 'Profit', 'Source']
    const lines = [header.join(',')]
    for (const s of rows) {
      const d = deriveSale(s, partById, costing)
      const p = d.p
      lines.push([
        s.soldAt ? new Date(s.soldAt).toISOString().slice(0, 10) : '',
        p ? (p.title || '') : (s.title || ''),
        p ? (p.sku || '') : (s.sku || ''),
        s.quantity ?? 1,
        (+s.soldPrice || 0).toFixed(2), (+s.shipping || 0).toFixed(2),
        (d.fee || 0).toFixed(2), (+s.refund || 0).toFixed(2), (d.net || 0).toFixed(2),
        d.cost == null ? '' : d.cost.toFixed(2), d.profit == null ? '' : d.profit.toFixed(2),
        p ? 'inventory' : (s.source === 'csv_orders_report' ? 'imported' : 'eBay only'),
      ].map(esc).join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `partvault-sales-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(a.href)
  }

  const th = { textAlign: 'left', padding: '9px 12px', color: C.muted, fontWeight: 700, fontSize: 11, whiteSpace: 'nowrap' }
  const td = (align = 'left') => ({ textAlign: align, padding: '9px 12px', color: C.text, whiteSpace: 'nowrap' })

  return (
    <div>
      <h2 style={{ ...S.h1, marginBottom: 4 }}>Recent Sales</h2>
      <div style={{ fontSize: 13, color: C.muted, marginBottom: 16 }}>Every eBay sale, newest first — what each item made after fees. Item &amp; SKU come from your inventory record (matched by eBay item number); sales with no inventory match are tagged <strong>eBay only</strong>.</div>

      {/* Performance overview — trend + comparison against the previous period. */}
      <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 12, padding: '16px 18px', marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {GRAINS.map(g => <button key={g.id} onClick={() => setGrain(g.id)} style={pillStyle(grain === g.id)}>{g.label}</button>)}
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {METRICS.map(m => <button key={m.id} onClick={() => setMetric(m.id)} style={pillStyle(metric === m.id)}>{m.label}</button>)}
          </div>
        </div>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: C.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3 }}>This {grainNoun[grain]} so far</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 28, fontWeight: 800, color: C.text }}>{showMetric(compare.cur, chart.money)}</span>
            {compare.delta != null && <DeltaBadge delta={compare.delta} />}
            <span style={{ fontSize: 12, color: C.muted }}>{compare.delta == null ? 'no prior period to compare' : `vs ${showMetric(compare.prev, chart.money)} at the same point last ${grainNoun[grain]}`}</span>
          </div>
        </div>
        <div style={{ maxWidth: 560 }}>
          <BarChart bars={chart.bars} money={chart.money} />
        </div>
      </div>

      <PromotedPanel promo={promo} periodLabel={grainWindowLabel(grain)} />

      <FulfilmentQueue sales={sales} partById={partById} wf={wf} setStage={setStage} now={now} />

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
        {PERIODS.map(([d, lbl]) => (
          <button key={d} onClick={() => setPeriod(d)}
            style={{ padding: '7px 14px', borderRadius: 20, border: `1.5px solid ${period === d ? C.accent : C.border}`, background: period === d ? C.accent : '#fff', color: period === d ? '#fff' : C.muted, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            {lbl}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search item or SKU…"
          style={{ ...S.input, marginBottom: 0, padding: '7px 12px', width: 220 }} />
        <button onClick={exportCsv} disabled={!rows.length} title="Download the filtered sales as a CSV (opens in Excel)"
          style={{ ...S.btn('secondary'), padding: '7px 12px', fontSize: 12, opacity: rows.length ? 1 : 0.5 }}>⤓ Export CSV</button>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <Stat label="Sold" value={rows.length} />
        <Stat label="Gross sales" value={fmt(totals.gross)} color={C.accent} />
        <Stat label="Refunds" value={totals.refunds > 0 ? '−' + fmt(totals.refunds) : fmt(0)} color={totals.refunds > 0 ? C.red : C.muted} />
        <Stat label="eBay fees" value={totals.fees > 0 ? '−' + fmt(totals.fees) : fmt(0)} color={C.red} />
        <Stat label="Net sales" value={fmt(totals.net)} color={C.green} />
        <Stat label="Profit" value={fmt(totals.net - totals.cogs)} sub={`${totals.matched}/${rows.length} cost-linked`} color={(totals.net - totals.cogs) >= 0 ? C.green : C.red} />
      </div>

      <div style={{ overflowX: 'auto', background: '#fff', border: `1px solid ${C.border}`, borderRadius: 12 }}>
        <table style={{ width: '100%', minWidth: 1000, borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: `2px solid ${C.border}` }}>
              <th style={th}>Date</th>
              <th style={th}>Item</th>
              <th style={th}>SKU</th>
              <th style={{ ...th, textAlign: 'right' }}>Qty</th>
              <th style={{ ...th, textAlign: 'right' }}>Sale</th>
              <th style={{ ...th, textAlign: 'right' }}>Ship</th>
              <th style={{ ...th, textAlign: 'right' }}>Fee</th>
              <th style={{ ...th, textAlign: 'right' }}>Net</th>
              <th style={{ ...th, textAlign: 'right' }}>Cost</th>
              <th style={{ ...th, textAlign: 'right' }}>Profit</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={10} style={{ padding: 24, textAlign: 'center', color: C.muted }}>No sales in this period.</td></tr>
            ) : shown.map(s => {
              const d = deriveSale(s, partById, costing)
              const p = d.p
              // Matched sale → show OUR inventory record (title + SKU). Unmatched →
              // there's no local record, so show the eBay text but flag it clearly
              // rather than passing it off as one of our records.
              const title = p ? (p.title || '—') : (s.title || '—')
              const sku = p ? (p.sku || '—') : (s.sku || '—')
              return (
                <tr key={s.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={td()}>{fmtDate(s.soldAt)}</td>
                  <td style={{ ...td(), maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis' }} title={title}>
                    {title}
                    {!p && <span title="No matching inventory item — shown from eBay" style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: C.muted, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: '1px 5px', verticalAlign: 'middle' }}>eBay only</span>}
                  </td>
                  <td style={{ ...td(), color: p ? C.text : C.muted }}>{sku}</td>
                  <td style={td('right')}>{s.quantity}</td>
                  <td style={td('right')}>{fmt(s.soldPrice)}</td>
                  <td style={td('right')}>{s.shipping ? fmt(s.shipping) : '—'}</td>
                  <td style={{ ...td('right'), color: C.red, cursor: d.fee ? 'pointer' : 'default', textDecoration: d.fee ? 'underline dotted' : 'none' }}
                      title={d.fee ? 'Click for breakdown' : ''}
                      onClick={() => d.fee && setDetail({ title, sub: `${sku} · ${fmtDate(s.soldAt)}`, entries: d.feeBreakdown || {}, totalLabel: 'Total eBay fee', totalValue: d.fee })}>
                    {d.fee ? '−' + fmt(d.fee) : '—'}
                  </td>
                  <td style={{ ...td('right'), fontWeight: 600 }}>{fmt(d.net)}</td>
                  <td style={{ ...td('right'), color: d.cost == null ? '#bbb' : C.red, cursor: d.cost == null ? 'default' : 'pointer', textDecoration: d.cost == null ? 'none' : 'underline dotted' }}
                      title={d.cost == null ? '' : 'Click for breakdown'}
                      onClick={() => d.cost != null && setDetail({ title, sub: `${sku} · ${fmtDate(s.soldAt)}${p ? '' : ' · cost from imported snapshot'}`, entries: d.breakdown || {}, totalLabel: 'Total cost', totalValue: d.cost || 0 })}>
                    {d.cost == null ? '—' : '−' + fmt(d.cost)}
                  </td>
                  <td style={{ ...td('right'), color: d.profit == null ? '#bbb' : d.profit >= 0 ? C.green : C.red }}>{d.profit == null ? '—' : fmt(d.profit)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 10, fontSize: 12, color: C.muted, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span>Showing {Math.min(limit, rows.length)} of {rows.length} sales.</span>
        {rows.length > limit && (
          <>
            <button onClick={() => setLimit(l => l + RENDER_CAP)} style={{ ...S.btn('secondary'), padding: '4px 10px', fontSize: 12 }}>Show {Math.min(RENDER_CAP, rows.length - limit)} more</button>
            <button onClick={() => setLimit(rows.length)} style={{ background: 'none', border: 'none', color: C.accent, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Show all</button>
          </>
        )}
      </div>
      <div style={{ marginTop: 6, fontSize: 12, color: C.muted }}>
        Net sales = Gross sales − refunds − eBay fees. Profit = Net sales − Cost. Click a <strong>Fee</strong> or <strong>Cost</strong> figure for its breakdown (— when there's no detail).
      </div>

      {detail && <BreakdownModal detail={detail} onClose={() => setDetail(null)} />}
    </div>
  )
}

// One line in the breakdown popup. Module-scoped so it isn't redefined per render.
function BRow({ label, val, sign = '−', strong, color, top, doubleBottom }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24, padding: '5px 0', borderTop: top ? `1px solid ${C.border}` : 'none', borderBottom: doubleBottom ? `3px double ${C.border}` : 'none', fontWeight: strong ? 700 : 400, color: color || C.text }}>
      <span>{label}</span>
      <span>{val < 0 ? `(${fmt(Math.abs(val))})` : `${sign === '+' ? '' : sign}${fmt(val)}`}</span>
    </div>
  )
}

// Generic breakdown popup: lists named line items and a ruled-off total. Used for
// both the cost breakdown and the eBay-fee breakdown.
function BreakdownModal({ detail, onClose }) {
  const entries = Object.entries(detail.entries || {})
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, padding: '20px 24px', width: 380, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 8px 30px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 4 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{detail.title}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, lineHeight: 1, cursor: 'pointer', color: C.muted }}>×</button>
        </div>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>{detail.sub}</div>
        <div style={{ fontSize: 13 }}>
          {entries.length === 0 && <div style={{ color: C.muted, padding: '4px 0' }}>No itemised detail recorded for this sale.</div>}
          {entries.map(([k, v]) => <BRow key={k} label={k} val={+v || 0} color={C.red} />)}
          <BRow label={detail.totalLabel} val={detail.totalValue || 0} strong top doubleBottom color={C.red} />
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, sub, color }) {
  return (
    <div style={{ ...S.card, borderTop: `3px solid ${color || C.accent}`, flex: '1 1 150px', minWidth: 140, padding: 16 }}>
      <div style={S.statLbl}>{label}</div>
      <div style={{ ...S.statVal, color: color || C.accent, fontSize: 24 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{sub}</div>}
    </div>
  )
}
