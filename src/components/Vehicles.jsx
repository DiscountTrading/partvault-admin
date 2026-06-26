import { useState, useMemo } from 'react'
import { C, S, fmt, totalCost, estimateCostBasis, partEffectiveCost } from '../lib/constants'
import { parseVehicle } from '../lib/vehicles'
import { sb } from '../lib/supabase'

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
  const base = rows.filter(r => r.partsSold > 0 && !r.unassigned)
  const profP = percentileFn(base.map(r => r.netProfit))
  const yldP = percentileFn(base.map(r => r.yieldScore))
  const spdP = percentileFn(base.filter(r => r.avgDts != null).map(r => -r.avgDts)) // faster = higher
  const W = SCORE_WEIGHTS
  return rows.map(r => {
    if (r.partsSold === 0 || r.unassigned) return { ...r, score: null, sProfit: null, sYield: null, sSpeed: null }
    const sProfit = profP(r.netProfit)
    const sYield = yldP(r.yieldScore)
    const sSpeed = r.avgDts != null ? spdP(-r.avgDts) : null
    let num = W.profit * sProfit + W.yield * sYield, den = W.profit + W.yield
    if (sSpeed != null) { num += W.speed * sSpeed; den += W.speed }
    return { ...r, score: Math.round(num / den), sProfit: Math.round(sProfit), sYield: Math.round(sYield), sSpeed: sSpeed == null ? null : Math.round(sSpeed) }
  })
}

export default function Vehicles({ parts = [], cars = [], costing = {}, onRefresh }) {
  const [level, setLevel] = useState('models') // 'models' | 'cars'
  const [carSort, setCarSort] = useState({ key: 'score', dir: 'desc' })
  const [modelSort, setModelSort] = useState({ key: 'score', dir: 'desc' })
  const [query, setQuery] = useState('')
  const [parsing, setParsing] = useState(false)
  const [parseMsg, setParseMsg] = useState('')

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

  // ---- per make/model roll-up (DIRECT from part fields) ------------------
  // eBay-imported parts carry make/model on the part itself (not a donor car),
  // so the model leaderboard aggregates parts directly — full catalogue coverage,
  // independent of whether a donor car was ever created. Cost here is the app's
  // standard ESTIMATED basis (partEffectiveCost) since there's no real per-car
  // purchase price at this level; the By-car view is where true ROI lives.
  const modelRows = useMemo(() => {
    const now = new Date().toISOString()
    const byModel = new Map()
    for (const p of parts) {
      if (p.deletedAt) continue
      const make = (p.make || '').trim(), model = (p.model || '').trim()
      const key = (make || model) ? `${make} ${model}`.trim().toLowerCase() : '__unassigned__'
      if (!byModel.has(key)) byModel.set(key, { make, model, parts: [] })
      byModel.get(key).parts.push(p)
    }
    return [...byModel.entries()].map(([key, g]) => {
      const cp = g.parts
      const sold = cp.filter(p => p.status === 'sold')
      const onShelf = cp.filter(p => p.status === 'in_stock' || p.status === 'listed')
      const revenue = sold.reduce((a, p) => a + (+p.soldPrice || 0), 0)
      const cost = sold.reduce((a, p) => a + partEffectiveCost(p, costing).value, 0)
      const netProfit = revenue - cost
      const dts = sold.map(p => days(p.acquiredDate || p.createdAt, p.soldDate)).filter(v => v != null)
      const yieldScore = cp.reduce((a, p) => a + conversionCredit(p, now), 0)
      const unassigned = key === '__unassigned__'
      return {
        id: key,
        name: unassigned ? '— Unassigned (no make/model) —' : (`${g.make} ${g.model}`.trim() || g.make || g.model),
        unassigned,
        partsTotal: cp.length,
        partsSold: sold.length,
        sellThrough: cp.length ? (sold.length / cp.length) * 100 : null,
        yieldScore,
        yieldPct: cp.length ? (yieldScore / cp.length) * 100 : null,
        revenue,
        netProfit,
        margin: revenue > 0 ? (netProfit / revenue) * 100 : null,
        avgDts: avg(dts) != null ? Math.round(avg(dts)) : null,
        untapped: onShelf.reduce((a, p) => a + (+p.list_price || 0), 0),
      }
    })
  }, [parts, costing])

  // ---- summary (catalogue-wide, from all parts) -------------------------
  const summary = useMemo(() => {
    const live = parts.filter(p => !p.deletedAt)
    const sold = live.filter(p => p.status === 'sold')
    const revenue = sold.reduce((a, p) => a + (+p.soldPrice || 0), 0)
    const cost = sold.reduce((a, p) => a + partEffectiveCost(p, costing).value, 0)
    const unparsed = live.filter(p => !(p.make || '').trim()).length
    return {
      revenue,
      estProfit: revenue - cost,
      cars: cars.length,
      unparsed,
      total: live.length,
    }
  }, [parts, cars, costing])

  const scoredCars = useMemo(() => withScores(carRows), [carRows])
  const scoredModels = useMemo(() => withScores(modelRows), [modelRows])

  // Backfill make/model/year onto parts that have none, by parsing the title.
  // Only fills blanks (never overwrites a set make), so it's safe to re-run.
  const runParse = async () => {
    setParsing(true); setParseMsg('Reading titles…')
    const targets = parts.filter(p => !p.deletedAt && !(p.make || '').trim())
    const updates = []
    const unmatched = []
    for (const p of targets) {
      const v = parseVehicle(p.title || '')
      if (v.make) updates.push({ id: p.id, make: v.make, model: v.model || null, year: v.year || null })
      else if (p.title) unmatched.push(p.title)
    }
    // Log every unmatched title to the console so we can widen the lists, and
    // keep a few on screen.
    if (unmatched.length) console.log(`[parse] ${unmatched.length} unmatched titles:`, unmatched)
    const sample = unmatched.slice(0, 8).map(s => `“${s.slice(0, 60)}”`).join('  ·  ')
    if (updates.length === 0) {
      setParseMsg(`No make matched from ${targets.length} titles. Examples: ${sample}`); setParsing(false); return
    }
    // Per-row UPDATE (not upsert — upsert's INSERT path trips parts' NOT NULL
    // columns like sku). Bounded concurrency keeps it fast without flooding.
    let done = 0, failed = 0
    const CONC = 25
    for (let i = 0; i < updates.length; i += CONC) {
      const batch = updates.slice(i, i + CONC)
      const errs = await Promise.all(batch.map(u =>
        sb.from('parts').update({ make: u.make, model: u.model, year: u.year }).eq('id', u.id)
          .then(({ error }) => { if (error) console.error('[parse] update failed', u.id, error.message); return error ? 1 : 0 })
      ))
      failed += errs.reduce((a, b) => a + b, 0)
      done += batch.length
      setParseMsg(`Updating ${done}/${updates.length}…`)
    }
    setParseMsg(`Done — set make/model on ${updates.length - failed} parts${failed ? `, ${failed} write errors (see console)` : ''}, ${unmatched.length} unmatched${unmatched.length ? ' (see console)' : ''}. Refreshing…`)
    setParsing(false)
    onRefresh && onRefresh()
  }

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
    { key: 'name', label: 'Make / Model', align: 'left', w: 220, render: r => r.name },
    { key: 'score', label: 'Score', align: 'center', w: 80, render: scoreCell },
    { key: 'partsSold', label: 'Parts sold', align: 'right', w: 110, render: r => `${r.partsSold}/${r.partsTotal}` },
    { key: 'yieldScore', label: 'Yield', align: 'right', w: 80, render: r => r.yieldScore == null ? '—' : r.yieldScore.toFixed(1) },
    { key: 'sellThrough', label: 'Sell-through', align: 'right', w: 110, render: r => pctStr(r.sellThrough) },
    { key: 'revenue', label: 'Revenue', align: 'right', w: 110, render: r => money(r.revenue) },
    { key: 'netProfit', label: 'Est. profit', align: 'right', w: 110, pos: true, render: r => money(r.netProfit) },
    { key: 'margin', label: 'Est. margin', align: 'right', w: 100, pos: true, render: r => pctStr(r.margin) },
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
        <Card label="Revenue (all sales)" value={money(summary.revenue)} color={C.accent} />
        <Card label="Est. profit" value={money(summary.estProfit)} sub={summary.revenue > 0 ? `${Math.round((summary.estProfit / summary.revenue) * 100)}% margin` : null} color={summary.estProfit >= 0 ? C.green : C.red} />
        <Card label="Donor cars tracked" value={summary.cars} sub="with purchase price" color={C.blue} />
        <Card label="Parts without make" value={summary.unparsed} sub={`of ${summary.total} — parse to fill`} color={summary.unparsed > 0 ? C.yellow : C.green} />
      </div>

      {summary.unparsed > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', background: C.yellow + '14', border: `1px solid ${C.yellow}55`, borderRadius: 10, padding: '12px 16px', marginBottom: 16 }}>
          <span style={{ fontSize: 13, color: C.text, flex: 1, minWidth: 220 }}>
            <strong>{summary.unparsed}</strong> parts (mostly eBay imports) have no make/model, so they don't roll up by model.
            Parse them from their titles to populate the leaderboard.
          </span>
          {parseMsg && <span style={{ fontSize: 12, color: C.muted }}>{parseMsg}</span>}
          <button onClick={runParse} disabled={parsing} style={{ ...S.btn('primary'), padding: '8px 14px', fontSize: 13, opacity: parsing ? 0.6 : 1 }}>
            {parsing ? '⏳ Parsing…' : '✨ Parse from titles'}
          </button>
        </div>
      )}
      {summary.unparsed === 0 && parseMsg && (
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 16 }}>{parseMsg}</div>
      )}

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
                {isModels
                  ? (modelRows.length === 0 ? 'No parts yet.' : 'No models match.')
                  : (cars.length === 0 ? 'No donor cars yet. Add cars in Inventory to track per-vehicle ROI.' : 'No vehicles match.')}
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
        and sell-speed ({Math.round(SCORE_WEIGHTS.speed * 100)}%), each ranked as a percentile vs the rest — hover a badge for the sub-scores.
        <strong> Yield</strong> credits each sold part as 1 and each unsold part as a fading fraction
        ({Math.round(FRESH_WEIGHT * 100)}% when freshly pulled, decaying to 0 by {FADE_DAYS} days on the shelf).
        {isModels
          ? <> <strong> By model</strong> covers every part by its make/model; <strong>Est. profit</strong> uses the app's estimated cost basis (no per-car purchase price at this level — see <strong>By car</strong> for true ROI).</>
          : <> <strong> Net profit</strong> = parts revenue − selling costs (labour, postage, eBay fees) − car purchase price. <strong>Recouped</strong> ≥ 100% means the car has paid for itself.</>}
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
