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

export default function Sales({ sales = [], parts = [], costing = {} }) {
  const [period, setPeriod] = useState(90)
  const [query, setQuery] = useState('')
  const [detail, setDetail] = useState(null) // sale whose cost breakdown is open
  const [limit, setLimit] = useState(RENDER_CAP)

  const partById = useMemo(() => new Map(parts.filter(p => !p.deletedAt).map(p => [p.id, p])), [parts])

  const rows = useMemo(() => {
    const cutoff = period ? Date.now() - period * 86400000 : 0
    const q = query.trim().toLowerCase()
    return sales
      .filter(s => !s.cancelled && (!period || (s.soldAt && new Date(s.soldAt).getTime() >= cutoff)))
      .filter(s => {
        if (!q) return true
        // Search the local record where we have one, plus the eBay text as a fallback.
        const p = s.partId && partById.get(s.partId)
        return `${p ? `${p.title} ${p.sku}` : ''} ${s.title} ${s.sku}`.toLowerCase().includes(q)
      })
  }, [sales, period, query, partById])

  const totals = useMemo(() => rows.reduce((a, s) => {
    const d = deriveSale(s, partById, costing)
    a.gross += (+s.soldPrice || 0) + (+s.shipping || 0)
    a.refunds += (+s.refund || 0)
    a.fees += d.fee
    a.net += d.net
    if (d.cost != null) { a.cogs += d.cost; a.matched++ }
    return a
  }, { gross: 0, refunds: 0, fees: 0, net: 0, cogs: 0, matched: 0 }), [rows, partById, costing])

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

      {/* 📦 To send — sales not yet marked shipped on eBay (refreshed by the 5-min
          live check, so posting on eBay clears them within minutes). */}
      {(() => {
        const cutoff = Date.now() - 30 * 86400000
        const toSend = sales.filter(s =>
          s.fulfillmentStatus && s.fulfillmentStatus !== 'FULFILLED' &&
          !s.cancelled && !s.refunded &&
          s.soldAt && new Date(s.soldAt).getTime() > cutoff
        ).sort((a, b) => new Date(a.soldAt) - new Date(b.soldAt)) // oldest first — ship those first
        if (!toSend.length) return null
        const ebayDomain = getActiveMarketplace().ebayDomain
        return (
          <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 12, padding: '12px 16px', marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: C.text, marginBottom: 8 }}>
              📦 To send — {toSend.length} order{toSend.length === 1 ? '' : 's'} awaiting shipment
            </div>
            {toSend.map(s => {
              const p = s.partId ? partById.get(s.partId) : null
              const thumb = p?.photos?.[0]?.url
              const days = Math.floor((Date.now() - new Date(s.soldAt).getTime()) / 86400000)
              return (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderTop: '1px solid #fde68a' }}>
                  {thumb
                    ? <img src={thumb} alt="" style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 8, flexShrink: 0 }} />
                    : <div style={{ width: 44, height: 44, borderRadius: 8, background: '#fef3c7', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0 }}>📦</div>}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p?.title || s.title}</div>
                    <div style={{ fontSize: 11, color: C.muted }}>
                      {p?.sku || s.sku || 'no SKU'} · {fmt(s.soldPrice)}{s.shipping > 0 ? ` + ${fmt(s.shipping)} post` : ''} · sold {fmtDate(s.soldAt)}
                      {days >= 2 && <span style={{ color: C.red, fontWeight: 700 }}> · {days} days ago</span>}
                      {s.buyer ? ` · ${s.buyer}` : ''}{s.shipTo?.city ? ` · ${s.shipTo.city}${s.shipTo.state ? ' ' + s.shipTo.state : ''}` : ''}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button title="Print a packing slip with the ship-to address" onClick={() => printPackingSlip(s, p)}
                      style={{ ...S.btn('secondary'), padding: '5px 10px', fontSize: 11 }}>🖨 Slip</button>
                    {p && <button title="Reprint this part's SKU sticker" onClick={() => printLabels([p])}
                      style={{ ...S.btn('secondary'), padding: '5px 10px', fontSize: 11 }}>🏷 SKU</button>}
                    <a href={`https://www.${ebayDomain}/mesh/ord/details?orderid=${encodeURIComponent(s.orderId)}`} target="_blank" rel="noreferrer"
                      title="Open the order on eBay to buy the postage label"
                      style={{ ...S.btn('secondary'), padding: '5px 10px', fontSize: 11, textDecoration: 'none', display: 'inline-block' }}>eBay ↗</a>
                  </div>
                </div>
              )
            })}
            <div style={{ fontSize: 10.5, color: C.muted, marginTop: 8 }}>Postage labels are purchased on eBay (eBay ↗). Once you mark the order posted there, it drops off this list within a few minutes.</div>
          </div>
        )
      })()}

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
