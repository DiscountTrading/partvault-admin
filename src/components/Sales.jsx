import { useState, useMemo } from 'react'
import { C, S, fmt, partEffectiveCost } from '../lib/constants'

const PERIODS = [[30, '30d'], [90, '90d'], [365, '12mo'], [0, 'All']]
const RENDER_CAP = 400

const fmtDate = t => t ? new Date(t).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: '2-digit' }) : '—'
// Net to the seller for a line: item + shipping paid − refund − eBay fee.
export const saleNet = s => (+s.soldPrice || 0) + (+s.shipping || 0) - (+s.refund || 0) - (+s.fees || 0)

export default function Sales({ sales = [], parts = [], costing = {} }) {
  const [period, setPeriod] = useState(90)
  const [query, setQuery] = useState('')

  const partById = useMemo(() => new Map(parts.filter(p => !p.deletedAt).map(p => [p.id, p])), [parts])

  const rows = useMemo(() => {
    const cutoff = period ? Date.now() - period * 86400000 : 0
    const q = query.trim().toLowerCase()
    return sales
      .filter(s => !s.cancelled && (!period || (s.soldAt && new Date(s.soldAt).getTime() >= cutoff)))
      .filter(s => !q || `${s.title} ${s.sku}`.toLowerCase().includes(q))
  }, [sales, period, query])

  const totals = useMemo(() => rows.reduce((a, s) => {
    a.gross += (+s.soldPrice || 0) + (+s.shipping || 0)
    a.fees += (+s.fees || 0)
    a.net += saleNet(s)
    const p = s.partId && partById.get(s.partId)
    if (p) { a.cogs += partEffectiveCost(p, costing).value; a.matched++ }
    return a
  }, { gross: 0, fees: 0, net: 0, cogs: 0, matched: 0 }), [rows, partById, costing])

  const shown = rows.slice(0, RENDER_CAP)
  const th = { textAlign: 'left', padding: '9px 12px', color: C.muted, fontWeight: 700, fontSize: 11, whiteSpace: 'nowrap' }
  const td = (align = 'left') => ({ textAlign: align, padding: '9px 12px', color: C.text, whiteSpace: 'nowrap' })

  return (
    <div>
      <h2 style={{ ...S.h1, marginBottom: 4 }}>Recent Sales</h2>
      <div style={{ fontSize: 13, color: C.muted, marginBottom: 16 }}>Every eBay sale, newest first — what each item made after fees.</div>

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
        <Stat label="Sales" value={rows.length} />
        <Stat label="Gross (incl. ship)" value={fmt(totals.gross)} color={C.accent} />
        <Stat label="eBay fees" value={'−' + fmt(totals.fees)} color={C.red} />
        <Stat label="Net after fees" value={fmt(totals.net)} color={C.green} />
        <Stat label="Est. profit" value={fmt(totals.net - totals.cogs)} sub={`${totals.matched}/${rows.length} cost-linked`} color={(totals.net - totals.cogs) >= 0 ? C.green : C.red} />
      </div>

      <div style={{ overflowX: 'auto', background: '#fff', border: `1px solid ${C.border}`, borderRadius: 12 }}>
        <table style={{ width: '100%', minWidth: 900, borderCollapse: 'collapse', fontSize: 13 }}>
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
              <th style={{ ...th, textAlign: 'right' }}>Profit</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={9} style={{ padding: 24, textAlign: 'center', color: C.muted }}>No sales in this period.</td></tr>
            ) : shown.map(s => {
              const p = s.partId && partById.get(s.partId)
              const profit = p ? saleNet(s) - partEffectiveCost(p, costing).value : null
              return (
                <tr key={s.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={td()}>{fmtDate(s.soldAt)}</td>
                  <td style={{ ...td(), maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis' }} title={s.title}>{s.title || '—'}</td>
                  <td style={{ ...td(), color: C.muted }}>{s.sku || '—'}</td>
                  <td style={td('right')}>{s.quantity}</td>
                  <td style={td('right')}>{fmt(s.soldPrice)}</td>
                  <td style={td('right')}>{s.shipping ? fmt(s.shipping) : '—'}</td>
                  <td style={{ ...td('right'), color: C.red }}>{s.fees ? '−' + fmt(s.fees) : '—'}</td>
                  <td style={{ ...td('right'), fontWeight: 600 }}>{fmt(saleNet(s))}</td>
                  <td style={{ ...td('right'), color: profit == null ? '#bbb' : profit >= 0 ? C.green : C.red }}>{profit == null ? '—' : fmt(profit)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 10, fontSize: 12, color: C.muted }}>
        {rows.length > RENDER_CAP ? `Showing newest ${RENDER_CAP} of ${rows.length}.` : `Showing ${rows.length} sales.`}
        {' '}Net = sale + shipping − refund − eBay fee. Profit also subtracts the part's cost (— when no inventory link).
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
