import { useState, useMemo } from 'react'
import { C, S, fmt, totalCost, estimateCostBasis } from '../lib/constants'

// ============================================================================
// Vehicle analytics — which donor cars and which makes/models actually make
// money. Answers the buying question: "what should I bid on at auction?"
//
// All client-side from the parts + cars + costing already in App state.
//
// Accounting model (per donor car):
//   revenue   = Σ sold_price of its sold parts
//   opCost    = Σ per-part operating/selling cost (labour, admin, postage, eBay
//               fees) — EXCLUDES acquisition, because the car's purchase price IS
//               the acquisition and is counted once, at the car level.
//   invested  = car.purchase_price
//   netProfit = revenue − opCost − invested
//   recouped  = revenue / invested      (>100% ⇒ the car has paid for itself)
//   roi       = netProfit / invested
// ============================================================================

const money = v => (v == null ? '—' : fmt(v))
const pctStr = v => (v == null ? '—' : `${Math.round(v)}%`)
const days = (from, to) => {
  if (!from || !to) return null
  const d = Math.floor((new Date(to).getTime() - new Date(from).getTime()) / 86400000)
  return d >= 0 ? d : null
}
const avg = arr => (arr.length ? arr.reduce((a, v) => a + v, 0) / arr.length : null)

// ---- Conversion credit ------------------------------------------------------
// How much a part counts toward a car's "yield". A sold part is full credit; an
// unsold part counts partially and FADES with shelf age, so a car isn't punished
// for pulling lots of parts (volume is rewarded via the absolute yield score),
// but a fresh unsold part still ranks below a sold one and a stale one approaches
// zero. Knobs are business judgement:
const FRESH_WEIGHT = 0.7  // an unsold part just pulled is worth 70% of a sold one
const FADE_DAYS = 180     // its odds fade to ~0 by ~6 months on the shelf
const conversionCredit = (p, now) => {
  if (p.status === 'sold') return 1
  if (p.status === 'scrapped') return 0
  // in_stock / listed / deferred → fading partial credit by shelf age
  const age = days(p.listedDate || p.acquiredDate || p.createdAt, now) ?? 0
  return Math.max(0, FRESH_WEIGHT * (1 - age / FADE_DAYS))
}

// ---- Blended Car Score ------------------------------------------------------
// A single 0–100 ranking that folds the three things that make a donor car a good
// buy: business profit, conversion yield (incl. dead-part drag), and how fast the
// parts sell. Each axis is scored as a PERCENTILE against the rest of the fleet,
// so there are no arbitrary "good ROI" benchmarks and it self-calibrates as more
// cars are bought. Weights are business judgement and tunable here.
const SCORE_WEIGHTS = { profit: 0.40, yield: 0.30, speed: 0.30 }
// Returns a fn value -> percentile 0..100 (avg-rank for ties) over the given vals.
const percentileFn = (vals) => {
  const n = vals.length
  return (v) => {
    if (v == null || Number.isNaN(v)) return null
    if (n <= 1) return 100
    let below = 0, equal = 0
    for (const s of vals) { if (s < v) below++; else if (s === v) equal++ }
    const rank = below + (equal - 1) / 2 // average 0-indexed rank for ties
    return (rank / (n - 1)) * 100
  }
}
// Attach score + sub-scores to rows. Cars with no sales yet are "unproven"
// (score null) rather than scored low on incomplete data. Percentiles are built
// only from proven rows so the comparison set is like-for-like.
const withScores = (rows) => {
  const base = rows.filter(r => r.partsSold > 0)
  const profP = percentileFn(base.map(r => r.netProfit))
  const yldP = percentileFn(base.map(r => r.yieldScore))
  const spdP = percentileFn(base.filter(r => r.avgDts != null).map(r => -r.avgDts)) // faster = higher
  const W = SCORE_WEIGHTS
  return rows.map(r => {
    if (r.partsSold === 0) return { ...r, score: null, sProfit: null, sYield: null, sSpeed: null }
    const sProfit = profP(r.netProfit)
    const sYield = yldP(r.yieldScore)
    const sSpeed = r.avgDts != null ? spdP(-r.avgDts) : null
    let num = W.profit * sProfit + W.yield * sYield, den = W.profit + W.yield
    if (sSpeed != null) { num += W.speed * sSpeed; den += W.speed }
    return { ...r, score: Math.round(num / den), sProfit: Math.round(sProfit), sYield: Math.round(sYield), sSpeed: sSpeed == null ? null : Math.round(sSpeed) }
  })
}

export default function Vehicles({ parts = [], cars = [], costing = {} }) {
  const [level, setLevel] = useState('models') // 'models' | 'cars'
  const [carSort, setCarSort] = useState({ key: 'score', dir: 'desc' })
  const [modelSort, setModelSort] = useState({ key: 'score', dir: 'desc' })
  const [query, setQuery] = useState('')

  // Per-part operating cost: everything except the acquisition/car cost (counted
  // once at the car level) and the synthetic base-cost proxy. Mirrors the app's
  // cost model (partEffectiveCost) minus those two so we don't double-count the
  // car's purchase price against itself.
  const opCost = (p) => {
    const recorded = totalCost(p) - (+p.costs?.acquisition || 0)
    const b = estimateCostBasis(p, costing, 0, 0)
    const manualPost = +(p.costs?.postage) || 0
    const supplement = b.labour + b.admin + (manualPost > 0 ? 0 : b.postage) // exclude baseCost
    return recorded + supplement
  }

  // ---- per-car roll-up --------------------------------------------------
  const carRows = useMemo(() => {
    const now = new Date().toISOString()
    const byCar = new Map()
    for (const p of parts) {
      if (p.deletedAt || !p.car_id) continue
      if (!byCar.has(p.car_id)) byCar.set(p.car_id, [])
      byCar.get(p.car_id).push(p)
    }
    return cars.map(car => {
      const cp = byCar.get(car.id) || []
      const sold = cp.filter(p => p.status === 'sold')
      const onShelf = cp.filter(p => p.status === 'in_stock' || p.status === 'listed')
      const revenue = sold.reduce((a, p) => a + (+p.soldPrice || 0), 0)
      const opTotal = sold.reduce((a, p) => a + opCost(p), 0)
      const invested = +car.purchase_price || 0
      const netProfit = revenue - opTotal - invested
      const dts = sold.map(p => days(p.acquiredDate || car.purchase_date || p.createdAt, p.soldDate)).filter(v => v != null)
      // Age-weighted yield: sold parts count full, unsold fade with shelf age.
      const yieldScore = cp.reduce((a, p) => a + conversionCredit(p, now), 0)
      return {
        id: car.id,
        name: [car.make, car.model, car.year].filter(Boolean).join(' ') || 'Unknown vehicle',
        make: car.make || '', model: car.model || '',
        purchase_date: car.purchase_date || null,
        invested,
        partsTotal: cp.length,
        partsSold: sold.length,
        partsOnShelf: onShelf.length,
        sellThrough: cp.length ? (sold.length / cp.length) * 100 : null,
        yieldScore,
        yieldPct: cp.length ? (yieldScore / cp.length) * 100 : null,
        revenue,
        opCost: opTotal,
        netProfit,
        recouped: invested > 0 ? (revenue / invested) * 100 : null,
        roi: invested > 0 ? (netProfit / invested) * 100 : null,
        avgDts: avg(dts) != null ? Math.round(avg(dts)) : null,
        untapped: onShelf.reduce((a, p) => a + (+p.list_price || 0), 0),
      }
    })
  }, [parts, cars, costing])

  // ---- per make/model roll-up (aggregate cars of the same model) ---------
  const modelRows = useMemo(() => {
    const byModel = new Map()
    for (const c of carRows) {
      const key = `${c.make} ${c.model}`.trim().toLowerCase() || 'unknown'
      if (!byModel.has(key)) byModel.set(key, { make: c.make, model: c.model, cars: [] })
      byModel.get(key).cars.push(c)
    }
    return [...byModel.values()].map(g => {
      const invested = g.cars.reduce((a, c) => a + c.invested, 0)
      const revenue = g.cars.reduce((a, c) => a + c.revenue, 0)
      const opC = g.cars.reduce((a, c) => a + c.opCost, 0)
      const partsTotal = g.cars.reduce((a, c) => a + c.partsTotal, 0)
      const partsSold = g.cars.reduce((a, c) => a + c.partsSold, 0)
      const yieldScore = g.cars.reduce((a, c) => a + c.yieldScore, 0)
      const netProfit = revenue - opC - invested
      const dts = g.cars.map(c => c.avgDts).filter(v => v != null)
      return {
        id: `${g.make} ${g.model}`.trim(),
        name: `${g.make} ${g.model}`.trim() || 'Unknown',
        numCars: g.cars.length,
        invested,
        partsTotal,
        partsSold,
        sellThrough: partsTotal ? (partsSold / partsTotal) * 100 : null,
        yieldScore,
        yieldPct: partsTotal ? (yieldScore / partsTotal) * 100 : null,
        revenue,
        netProfit,
        recouped: invested > 0 ? (revenue / invested) * 100 : null,
        roi: invested > 0 ? (netProfit / invested) * 100 : null,
        avgDts: avg(dts) != null ? Math.round(avg(dts)) : null,
        revenuePerCar: g.cars.length ? revenue / g.cars.length : null,
        untapped: g.cars.reduce((a, c) => a + c.untapped, 0),
      }
    })
  }, [carRows])

  // ---- summary ----------------------------------------------------------
  const summary = useMemo(() => {
    const invested = carRows.reduce((a, c) => a + c.invested, 0)
    const revenue = carRows.reduce((a, c) => a + c.revenue, 0)
    const opC = carRows.reduce((a, c) => a + c.opCost, 0)
    const net = revenue - opC - invested
    const withCost = carRows.filter(c => c.invested > 0)
    return {
      cars: carRows.length,
      invested,
      revenue,
      net,
      roi: invested > 0 ? (net / invested) * 100 : null,
      paidOff: withCost.filter(c => c.recouped != null && c.recouped >= 100).length,
      withCost: withCost.length,
    }
  }, [carRows])

  const scoredCars = useMemo(() => withScores(carRows), [carRows])
  const scoredModels = useMemo(() => withScores(modelRows), [modelRows])

  const q = query.trim().toLowerCase()
  const filteredCars = q ? scoredCars.filter(r => r.name.toLowerCase().includes(q)) : scoredCars
  const filteredModels = q ? scoredModels.filter(r => r.name.toLowerCase().includes(q)) : scoredModels

  const sortRows = (rows, { key, dir }) => [...rows].sort((a, b) => {
    const av = a[key], bv = b[key]
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    if (typeof av === 'string') return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
    return dir === 'asc' ? av - bv : bv - av
  })

  const toggle = (setSort) => (key) => setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' })

  // Blended-score cell: a coloured 0–100 badge with the sub-scores on hover.
  // "new" = no sales yet (unproven), so we don't score it on incomplete data.
  const scoreCell = (r) => {
    if (r.score == null) return <span style={{ color: '#bbb', fontSize: 12 }}>new</span>
    const col = r.score >= 67 ? C.green : r.score >= 34 ? C.yellow : C.red
    const tip = `Profit ${r.sProfit ?? '—'} · Yield ${r.sYield ?? '—'} · Speed ${r.sSpeed ?? '—'}  (percentile vs fleet)`
    return <span title={tip} style={{ display: 'inline-block', minWidth: 32, textAlign: 'center', background: col + '22', color: col, border: `1px solid ${col}55`, borderRadius: 6, padding: '2px 8px', fontWeight: 700 }}>{r.score}</span>
  }

  // Column definitions per level. `pos` flags profit/ROI columns that get
  // red/green colouring.
  const MODEL_COLS = [
    { key: 'name', label: 'Make / Model', align: 'left', w: 200, render: r => r.name },
    { key: 'score', label: 'Score', align: 'center', w: 80, render: scoreCell },
    { key: 'numCars', label: 'Cars', align: 'right', w: 70, render: r => r.numCars },
    { key: 'invested', label: 'Invested', align: 'right', w: 100, render: r => money(r.invested) },
    { key: 'partsSold', label: 'Parts sold', align: 'right', w: 110, render: r => `${r.partsSold}/${r.partsTotal}` },
    { key: 'yieldScore', label: 'Yield', align: 'right', w: 80, render: r => r.yieldScore == null ? '—' : r.yieldScore.toFixed(1) },
    { key: 'invested', label: 'Invested', align: 'right', w: 100, render: r => money(r.invested) },
    { key: 'partsSold', label: 'Parts sold', align: 'right', w: 110, render: r => `${r.partsSold}/${r.partsTotal}` },
    { key: 'yieldScore', label: 'Yield', align: 'right', w: 80, render: r => r.yieldScore == null ? '—' : r.yieldScore.toFixed(1) },
    { key: 'sellThrough', label: 'Sell-through', align: 'right', w: 110, render: r => pctStr(r.sellThrough) },
    { key: 'revenue', label: 'Revenue', align: 'right', w: 110, render: r => money(r.revenue) },
    { key: 'netProfit', label: 'Net profit', align: 'right', w: 110, pos: true, render: r => money(r.netProfit) },
    { key: 'roi', label: 'ROI', align: 'right', w: 90, pos: true, render: r => pctStr(r.roi) },
    { key: 'recouped', label: 'Recouped', align: 'right', w: 100, render: r => pctStr(r.recouped) },
    { key: 'revenuePerCar', label: 'Rev / car', align: 'right', w: 100, render: r => money(r.revenuePerCar) },
    { key: 'avgDts', label: 'Avg days to sell', align: 'right', w: 130, render: r => r.avgDts == null ? '—' : `${r.avgDts}d` },
    { key: 'untapped', label: 'Untapped', align: 'right', w: 100, render: r => money(r.untapped) },
  ]
  const CAR_COLS = [
    { key: 'name', label: 'Vehicle', align: 'left', w: 200, render: r => r.name },
    { key: 'score', label: 'Score', align: 'center', w: 80, render: scoreCell },
    { key: 'purchase_date', label: 'Bought', align: 'left', w: 110, render: r => r.purchase_date || '—' },
    { key: 'invested', label: 'Invested', align: 'right', w: 100, render: r => money(r.invested) },
    { key: 'partsSold', label: 'Parts sold', align: 'right', w: 110, render: r => `${r.partsSold}/${r.partsTotal}` },
    { key: 'yieldScore', label: 'Yield', align: 'right', w: 80, render: r => r.yieldScore == null ? '—' : r.yieldScore.toFixed(1) },
    { key: 'sellThrough', label: 'Sell-through', align: 'right', w: 110, render: r => pctStr(r.sellThrough) },
    { key: 'revenue', label: 'Revenue', align: 'right', w: 110, render: r => money(r.revenue) },
    { key: 'netProfit', label: 'Net profit', align: 'right', w: 110, pos: true, render: r => money(r.netProfit) },
    { key: 'roi', label: 'ROI', align: 'right', w: 90, pos: true, render: r => pctStr(r.roi) },
    { key: 'recouped', label: 'Recouped', align: 'right', w: 100, render: r => pctStr(r.recouped) },
    { key: 'avgDts', label: 'Avg days to sell', align: 'right', w: 130, render: r => r.avgDts == null ? '—' : `${r.avgDts}d` },
    { key: 'untapped', label: 'Untapped', align: 'right', w: 100, render: r => money(r.untapped) },
  ]

  const isModels = level === 'models'
  const cols = isModels ? MODEL_COLS : CAR_COLS
  const sort = isModels ? modelSort : carSort
  const onSort = toggle(isModels ? setModelSort : setCarSort)
  const rows = sortRows(isModels ? filteredModels : filteredCars, sort)

  const posColor = v => v == null ? C.text : v > 0 ? C.green : v < 0 ? C.red : C.text

  return (
    <div>
      <h2 style={{ ...S.h1, marginBottom: 4 }}>Vehicle Analytics</h2>
      <div style={{ fontSize: 13, color: C.muted, marginBottom: 16 }}>
        Which donor cars and models actually make money — so you know what to buy next.
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <Card label="Donor cars" value={summary.cars} sub={`${summary.paidOff}/${summary.withCost} paid off`} />
        <Card label="Invested in cars" value={money(summary.invested)} color={C.blue} />
        <Card label="Revenue from parts" value={money(summary.revenue)} color={C.accent} />
        <Card label="Net profit" value={money(summary.net)} sub={summary.roi == null ? null : `${Math.round(summary.roi)}% ROI`} color={summary.net >= 0 ? C.green : C.red} />
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        {[['models', '🚗 By model'], ['cars', '🔧 By car']].map(([id, label]) => (
          <button key={id} onClick={() => setLevel(id)}
            style={{ padding: '7px 14px', borderRadius: 20, border: `1.5px solid ${level === id ? C.accent : C.border}`, background: level === id ? C.accent : '#fff', color: level === id ? '#fff' : C.muted, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            {label}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder={isModels ? 'Search models…' : 'Search vehicles…'}
          style={{ ...S.input, marginBottom: 0, padding: '7px 12px', width: 200 }} />
      </div>

      <div style={{ overflowX: 'auto', background: '#fff', border: `1px solid ${C.border}`, borderRadius: 12 }}>
        <table style={{ width: '100%', minWidth: 1000, borderCollapse: 'collapse', fontSize: 13, tableLayout: 'fixed' }}>
          <colgroup>{cols.map(c => <col key={c.key} style={{ width: c.w }} />)}</colgroup>
          <thead>
            <tr style={{ borderBottom: `2px solid ${C.border}` }}>
              {cols.map(col => (
                <th key={col.key} onClick={() => onSort(col.key)}
                  style={{ textAlign: col.align, padding: '10px 12px', color: C.muted, fontWeight: 700, fontSize: 11, whiteSpace: 'nowrap', cursor: 'pointer', userSelect: 'none' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexDirection: col.align === 'right' ? 'row-reverse' : 'row' }}>
                    <span style={{ width: 9, fontSize: 10, color: sort.key === col.key ? C.text : '#cbd5e1' }}>
                      {sort.key === col.key ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
                    </span>
                    {col.label}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={cols.length} style={{ padding: 24, textAlign: 'center', color: C.muted }}>
                {cars.length === 0 ? 'No donor cars yet. Add cars in Inventory to track vehicle profitability.' : 'No vehicles match.'}
              </td></tr>
            ) : rows.map(r => (
              <tr key={r.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                {cols.map(col => (
                  <td key={col.key} style={{ textAlign: col.align, padding: '10px 12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: col.key === 'name' ? 600 : 400, color: col.pos ? posColor(r[col.key]) : C.text }}>
                    {col.render(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 10, fontSize: 12, color: C.muted, lineHeight: 1.6 }}>
        Showing {rows.length} {isModels ? 'models' : 'vehicles'}.
        <strong> Score</strong> (0–100) blends profit ({Math.round(SCORE_WEIGHTS.profit * 100)}%), yield ({Math.round(SCORE_WEIGHTS.yield * 100)}%)
        and sell-speed ({Math.round(SCORE_WEIGHTS.speed * 100)}%), each ranked as a percentile against the rest of your fleet — hover a badge for the
        sub-scores. Cars with no sales yet show <em>new</em>.
        <strong> Net profit</strong> = parts revenue − selling costs (labour, postage, eBay fees) − car purchase price.
        <strong> Yield</strong> credits each sold part as 1 and each unsold part as a fading fraction
        ({Math.round(FRESH_WEIGHT * 100)}% when freshly pulled, decaying to 0 by {FADE_DAYS} days on the shelf).
        <strong> Recouped</strong> ≥ 100% means the car has paid for itself.
        <strong> Untapped</strong> is the list value still on the shelf.
      </div>
    </div>
  )
}

function Card({ label, value, sub, color }) {
  return (
    <div style={{ ...S.card, borderTop: `3px solid ${color || C.accent}`, flex: '1 1 180px', minWidth: 160, padding: 18 }}>
      <div style={S.statLbl}>{label}</div>
      <div style={{ ...S.statVal, color: color || C.accent, fontSize: 26 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{sub}</div>}
    </div>
  )
}
