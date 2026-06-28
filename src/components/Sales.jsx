import { useState, useMemo } from 'react'
import { C, S, fmt, partEffectiveCost, estimateCostBasis, storageCostFor } from '../lib/constants'

const PERIODS = [[30, '30d'], [90, '90d'], [365, '12mo'], [0, 'All']]
const RENDER_CAP = 400

const fmtDate = t => t ? new Date(t).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: '2-digit' }) : '—'
// Net to the seller for a line: item + shipping paid − refund − eBay fee.
export const saleNet = s => (+s.soldPrice || 0) + (+s.shipping || 0) - (+s.refund || 0) - (+s.fees || 0)

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
    const manualPost = +c.postage || 0
    breakdown = {
      Purchase: (+c.acquisition || 0) + (+c.carShare || 0) + b.baseCost,
      Admin: b.admin, Labour: b.labour,
      Storage: storageCostFor(p, costing).value,
      Postage: manualPost > 0 ? manualPost : b.postage,
    }
    const known = Object.values(breakdown).reduce((a, v) => a + v, 0)
    const other = Math.round((cost - known) * 100) / 100
    if (other > 0.01) breakdown.Other = other          // recorded costs outside the 5 buckets
  } else if (hc) {
    breakdown = { Purchase: +hc.purchase || 0, Admin: +hc.admin || 0, Labour: +hc.labour || 0, Storage: +hc.storage || 0,
      Postage: +s.shipCost > 0 ? +s.shipCost : (+hc.postage || 0) } // real label cost wins
    cost = Object.values(breakdown).reduce((a, v) => a + v, 0)
  }
  return { p, fee, net, cost, breakdown, profit: cost != null ? net - cost : null }
}

export default function Sales({ sales = [], parts = [], costing = {} }) {
  const [period, setPeriod] = useState(90)
  const [query, setQuery] = useState('')
  const [detail, setDetail] = useState(null) // sale whose cost breakdown is open

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

  const shown = rows.slice(0, RENDER_CAP)
  const th = { textAlign: 'left', padding: '9px 12px', color: C.muted, fontWeight: 700, fontSize: 11, whiteSpace: 'nowrap' }
  const td = (align = 'left') => ({ textAlign: align, padding: '9px 12px', color: C.text, whiteSpace: 'nowrap' })

  return (
    <div>
      <h2 style={{ ...S.h1, marginBottom: 4 }}>Recent Sales</h2>
      <div style={{ fontSize: 13, color: C.muted, marginBottom: 16 }}>Every eBay sale, newest first — what each item made after fees. Item &amp; SKU come from your inventory record (matched by eBay item number); sales with no inventory match are tagged <strong>eBay only</strong>.</div>

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
                  <td style={{ ...td('right'), color: C.red }}>{d.fee ? '−' + fmt(d.fee) : '—'}</td>
                  <td style={{ ...td('right'), fontWeight: 600 }}>{fmt(d.net)}</td>
                  <td style={{ ...td('right'), color: d.cost == null ? '#bbb' : C.red, cursor: d.cost == null ? 'default' : 'pointer', textDecoration: d.cost == null ? 'none' : 'underline dotted' }}
                      title={d.cost == null ? '' : 'Click for breakdown'}
                      onClick={() => d.cost != null && setDetail({ s, d, title, sku })}>
                    {d.cost == null ? '—' : '−' + fmt(d.cost)}
                  </td>
                  <td style={{ ...td('right'), color: d.profit == null ? '#bbb' : d.profit >= 0 ? C.green : C.red }}>{d.profit == null ? '—' : fmt(d.profit)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 10, fontSize: 12, color: C.muted }}>
        {rows.length > RENDER_CAP ? `Showing newest ${RENDER_CAP} of ${rows.length}.` : `Showing ${rows.length} sales.`}
        {' '}Net sales = Gross sales − refunds − eBay fees. Cost = goods + overhead (click a Cost figure for its breakdown). Profit = Net sales − Cost (— when there's no cost source).
      </div>

      {detail && <CostBreakdown detail={detail} onClose={() => setDetail(null)} />}
    </div>
  )
}

// One line in the breakdown popup. Module-scoped so it isn't redefined per render.
function BRow({ label, val, sign = '−', strong, color, top }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24, padding: '5px 0', borderTop: top ? `1px solid ${C.border}` : 'none', fontWeight: strong ? 700 : 400, color: color || C.text }}>
      <span>{label}</span>
      <span>{val < 0 ? `(${fmt(Math.abs(val))})` : `${sign === '+' ? '' : sign}${fmt(val)}`}</span>
    </div>
  )
}

// Full derivation popup for one sale: Sale → Net → each cost category → Profit.
function CostBreakdown({ detail, onClose }) {
  const { s, d, title, sku } = detail
  const matched = !!d.p
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, padding: '20px 24px', width: 380, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 8px 30px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 4 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{title}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, lineHeight: 1, cursor: 'pointer', color: C.muted }}>×</button>
        </div>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>{sku} · {fmtDate(s.soldAt)} {matched ? '' : '· cost from imported snapshot'}</div>

        <div style={{ fontSize: 13 }}>
          <BRow label="Sale price" val={+s.soldPrice || 0} sign="+" />
          {(+s.shipping || 0) > 0 && <BRow label="Shipping received" val={+s.shipping} sign="+" />}
          {(+s.refund || 0) > 0 && <BRow label="Refund" val={+s.refund} color={C.red} />}
          {(d.fee || 0) > 0 && <BRow label="eBay fee" val={d.fee} color={C.red} />}
          <BRow label="Net" val={d.net} sign="+" strong top />
          {d.breakdown && Object.entries(d.breakdown).map(([k, v]) => (
            <BRow key={k} label={k} val={+v || 0} color={C.red} />
          ))}
          <BRow label="Total cost" val={d.cost || 0} color={C.red} top />
          <BRow label="Profit" val={d.profit} sign="+" strong top color={d.profit >= 0 ? C.green : C.red} />
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
