import { useState, useMemo } from 'react'
import { C, S, fmt } from '../lib/constants'
import { groupMetrics, ungrouped, COMPARE_DIMENSIONS } from '../lib/rollup'
import useIsMobile from '../hooks/useIsMobile'

// ============================================================================
// Compare — the buying decision, as cards.
//
// The other Analytics pivots answer "how is this part / model / car doing?".
// This one answers the question you ask before you buy: of the kinds of stock I
// could pick up, which actually earns, and which sits on the shelf? So it groups
// the same parts by a dimension you choose — category, part type, make, model,
// condition, donor car — and puts one card against another.
//
// The numbers come from lib/rollup.js, which the By-model table can share, so a
// card and a table row cannot disagree about what a category earned.
//
// Sorting is on the measure you're comparing BY, not fixed to total profit:
// ranking by total profit alone just sorts by how much of that thing you happen
// to own, which is the question nobody asked.
// ============================================================================

const MEASURES = [
  { id: 'profitPerSold', label: 'Profit per part', hint: 'Net profit ÷ parts sold. The fairest comparison when one group is much bigger than another.', money: true },
  { id: 'netProfit',     label: 'Total profit',    hint: 'Everything this group has earned, after cost.', money: true },
  { id: 'margin',        label: 'Margin',          hint: 'Profit as a share of what the parts sold for.', pct: true },
  { id: 'medianDaysToSell', label: 'Days to sell', hint: 'The typical part, not the average — one shelf-warmer does not move a median.', days: true, lowerIsBetter: true },
  { id: 'sellThrough',   label: 'Sell-through',    hint: 'How many of these you have actually sold, out of everything you have held.', pct: true },
  { id: 'untapped',      label: 'Still on shelf',  hint: 'Asking price of what has not sold yet.', money: true },
]

export default function Compare({ parts, cars, costing }) {
  const isMobile = useIsMobile()
  const [dimId, setDimId] = useState('category')
  const [measureId, setMeasureId] = useState('profitPerSold')
  const [picked, setPicked] = useState(null)   // null = show all groups
  const [soldOnly, setSoldOnly] = useState(false)

  const dim = COMPARE_DIMENSIONS.find(d => d.id === dimId) || COMPARE_DIMENSIONS[0]
  const measure = MEASURES.find(m => m.id === measureId) || MEASURES[0]

  // A donor car's key is its id, which is no use on a card — resolve it to the
  // vehicle. Every other dimension is already its own label.
  const carById = useMemo(() => new Map((cars || []).map(c => [c.id, c])), [cars])
  const labelFor = (key) => {
    if (dimId !== 'car') return key
    const c = carById.get(key)
    return c ? [c.make, c.model, c.year].filter(Boolean).join(' ') || 'Car' : 'Unknown car'
  }

  const all = useMemo(
    () => groupMetrics(parts, dim.of, costing, labelFor),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [parts, dimId, costing, carById],
  )
  const skipped = useMemo(() => ungrouped(parts, dim.of), [parts, dimId]) // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    let rows = picked ? all.filter(r => picked.has(r.key)) : all
    // A group that has never sold anything has no value for most measures, and a
    // wall of "—" cards buries the ones that do. Opt-in rather than default,
    // because "nothing here has ever sold" is itself worth seeing.
    if (soldOnly) rows = rows.filter(r => r.sold > 0)
    const v = (r) => r[measure.id]
    return [...rows].sort((a, b) => {
      const av = v(a), bv = v(b)
      if (av == null && bv == null) return 0
      if (av == null) return 1          // unknowns last, either direction
      if (bv == null) return -1
      return measure.lowerIsBetter ? av - bv : bv - av
    })
  }, [all, picked, soldOnly, measure])

  // Scale bars against the best value on screen, so the comparison is visual
  // before it is numeric.
  const best = shown.reduce((m, r) => {
    const v = r[measure.id]
    return v == null ? m : Math.max(m, Math.abs(v))
  }, 0)

  const fmtMeasure = (v) => {
    if (v == null) return '—'
    if (measure.money) return fmt(v)
    if (measure.pct) return `${Math.round(v)}%`
    if (measure.days) return `${v}d`
    return String(v)
  }

  const toggle = (key) => setPicked(prev => {
    const next = new Set(prev || all.map(r => r.key))
    if (next.has(key)) next.delete(key); else next.add(key)
    // Everything selected is the same as no filter — keep it as null so adding a
    // new category later shows up instead of being silently excluded.
    return next.size === all.length ? null : next
  })

  const pill = (on) => ({
    padding: isMobile ? '0 14px' : '5px 12px', height: isMobile ? 44 : undefined,
    borderRadius: 20, border: `1.5px solid ${on ? C.accent : C.border}`,
    background: on ? C.accent : '#fff', color: on ? '#fff' : C.text,
    fontSize: 13, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
  })

  return (
    <div>
      {/* Controls: what the cards ARE, then what they are ranked by. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontSize: 12, color: C.muted, fontWeight: 700 }}>Compare</span>
        <select value={dimId} onChange={e => { setDimId(e.target.value); setPicked(null) }}
          style={{ ...S.select, width: 'auto', minWidth: 130 }}>
          {COMPARE_DIMENSIONS.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
        </select>
        <span style={{ fontSize: 12, color: C.muted, fontWeight: 700 }}>by</span>
        <select value={measureId} onChange={e => setMeasureId(e.target.value)}
          style={{ ...S.select, width: 'auto', minWidth: 150 }}>
          {MEASURES.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: C.text, cursor: 'pointer', minHeight: 44 }}>
          <input type="checkbox" checked={soldOnly} onChange={e => setSoldOnly(e.target.checked)} style={{ width: 16, height: 16 }} />
          Only ones that have sold
        </label>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: C.muted }}>{measure.hint}</span>
      </div>

      {/* Which groups appear. Chips rather than a multi-select: you are picking
          two or three things to hold against each other, and you need to see
          what you picked without opening anything. */}
      {all.length > 1 && (
        <div className="pv-scroll" style={{ display: 'flex', gap: 6, flexWrap: isMobile ? 'nowrap' : 'wrap', overflowX: isMobile ? 'auto' : 'visible', marginBottom: 12, paddingBottom: isMobile ? 4 : 0 }}>
          <button onClick={() => setPicked(null)} style={{ ...pill(!picked), flexShrink: 0 }}>All {all.length}</button>
          {all.map(r => (
            <button key={r.key} onClick={() => toggle(r.key)} title={`${r.parts} parts · ${r.sold} sold`}
              style={{ ...pill(!!picked && picked.has(r.key)), flexShrink: 0, fontWeight: 600 }}>
              {r.label} <span style={{ opacity: 0.65 }}>{r.parts}</span>
            </button>
          ))}
        </div>
      )}

      {shown.length === 0 ? (
        <div style={{ ...S.card, textAlign: 'center', color: C.muted, fontSize: 14 }}>
          {all.length === 0
            ? `No parts have a ${dim.label.toLowerCase()} recorded, so there is nothing to compare yet.`
            : 'Nothing selected — pick a chip above, or press “All”.'}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${isMobile ? 250 : 268}px, 1fr))`, gap: 12, alignItems: 'start' }}>
          {shown.map((r, i) => {
            const v = r[measure.id]
            const barPct = best > 0 && v != null ? Math.max(2, (Math.abs(v) / best) * 100) : 0
            const neg = typeof v === 'number' && v < 0
            return (
              <div key={r.key} style={{ ...S.card, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: C.muted, fontVariantNumeric: 'tabular-nums' }}>{i + 1}</span>
                  <span title={r.label} style={{ fontSize: 15, fontWeight: 700, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{r.label}</span>
                </div>

                {/* The measure being compared, big, with a bar against the best
                    on screen so the ranking reads before the numbers do. */}
                <div>
                  <div style={{ fontSize: 24, fontWeight: 800, lineHeight: 1.1, fontFamily: "'Inter Tight',system-ui,sans-serif", color: neg ? C.red : C.text, fontVariantNumeric: 'tabular-nums' }}>
                    {fmtMeasure(v)}
                  </div>
                  <div style={{ height: 5, borderRadius: 3, background: C.panel, marginTop: 6, overflow: 'hidden' }}>
                    <div style={{ width: `${barPct}%`, height: '100%', background: neg ? C.red : C.accent }} />
                  </div>
                </div>

                {/* Everything else, so a card stands alone without switching the
                    measure to see whether the headline is worth anything. */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px 10px', fontSize: 12 }}>
                  <Stat label="Sold" value={`${r.sold} of ${r.parts}`} />
                  <Stat label="Sell-through" value={r.sellThrough == null ? '—' : `${Math.round(r.sellThrough)}%`} />
                  <Stat label="Profit" value={r.sold ? fmt(r.netProfit) : '—'} color={r.sold && r.netProfit < 0 ? C.red : undefined} />
                  <Stat label="Margin" value={r.margin == null ? '—' : `${Math.round(r.margin)}%`} />
                  <Stat label="Typical sale" value={r.medianDaysToSell == null ? '—' : `${r.medianDaysToSell}d`}
                    title={r.datedSold < r.sold ? `Based on ${r.datedSold} of ${r.sold} sold parts — the rest have no usable dates.` : undefined}
                    warn={r.sold > 0 && r.datedSold < r.sold} />
                  <Stat label="On shelf" value={fmt(r.untapped)} title="Asking price of the parts here that have not sold." />
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div style={{ fontSize: 11.5, color: C.muted, marginTop: 12 }}>
        Cost, profit and margin use the same estimate model as the rest of Analytics.
        Days-to-sell counts from the acquisition date (or the record date where there is none), like the By-part table.
        {skipped > 0 && ` ${skipped} part${skipped === 1 ? ' has' : 's have'} no ${dim.label.toLowerCase()} recorded and ${skipped === 1 ? 'is' : 'are'} not on any card.`}
      </div>
    </div>
  )
}

function Stat({ label, value, color, title, warn }) {
  // The "~" marks a figure resting on fewer parts than the group holds. It only
  // makes sense in front of a NUMBER — "~—" reads as a rendering fault, and an
  // unknown value is unknown rather than approximate.
  const known = value != null && value !== '—'
  const showWarn = warn && known
  return (
    <div style={{ minWidth: 0 }} title={title}>
      <span style={{ color: C.muted }}>{label} </span>
      <span style={{ fontWeight: 700, color: color || (showWarn ? C.yellow : C.text), fontVariantNumeric: 'tabular-nums' }}>
        {showWarn ? `~${value}` : value}
      </span>
    </div>
  )
}
