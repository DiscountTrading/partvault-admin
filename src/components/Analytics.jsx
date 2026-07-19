import { useState } from 'react'
import { C, S } from '../lib/constants'
import Insights from './Insights'
import Vehicles from './Vehicles'
import SpellingCleanup from './SpellingCleanup'

// ============================================================================
// Analytics — one place to understand the stock, pivoted three ways. Formerly
// two separate tabs (Insights = per part, Vehicles = per car/model) that were
// really the same "read-only analytics over the same parts" surface grouped on
// a different key. The pivot pills swap the grouping; each engine keeps its own
// data source and math (Insights loads the part_insights view; Vehicles rolls
// up client-side from parts/cars/sales), so nothing analytic changed in the
// merge — only the shell.
// ============================================================================

const PIVOTS = [
  { id: 'part',  label: '🧩 By part',  sub: "What's making money, what's moving, and what's clogging the shelves." },
  { id: 'model', label: '🚗 By model', sub: 'Which makes and models actually make money — so you know what to buy next.' },
  { id: 'car',   label: '🔧 By car',   sub: 'Which donor cars actually make money — true ROI on each vehicle you bought.' },
]

export default function Analytics({ storeId, initial, parts, cars, sales, costing, onVehiclesChanged }) {
  const [pivot, setPivot] = useState('part')
  const [tidyOpen, setTidyOpen] = useState(false)

  // A Dashboard drill-down always targets individual parts, so snap to By part
  // whenever a new one arrives. Done as a during-render state adjustment (the
  // React-recommended alternative to a setState-in-effect) keyed on the drill's
  // timestamp, so the user is still free to switch pivots afterwards.
  const [seenTs, setSeenTs] = useState(initial?._ts)
  if (initial?._ts !== seenTs) {
    setSeenTs(initial?._ts)
    if (initial?._ts) setPivot('part')
  }

  const meta = PIVOTS.find(p => p.id === pivot) || PIVOTS[0]

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 4 }}>
        <h2 style={{ ...S.h1, margin: 0 }}>Analytics</h2>
        <div style={{ width: 1, height: 22, background: C.border, margin: '0 4px' }} />
        {PIVOTS.map(p => (
          <button key={p.id} onClick={() => setPivot(p.id)} title={p.sub}
            style={{ padding: '5px 14px', borderRadius: 20, border: `1.5px solid ${pivot === p.id ? C.accent : C.border}`, background: pivot === p.id ? C.accent : '#fff', color: pivot === p.id ? '#fff' : C.text, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
            {p.label}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button onClick={() => setTidyOpen(o => !o)}
          style={{ padding: '5px 14px', borderRadius: 20, border: `1.5px solid ${tidyOpen ? C.accent : C.border}`, background: tidyOpen ? '#fff4ef' : '#fff', color: C.text, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
          🧹 Tidy spellings
        </button>
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>{meta.sub}</div>

      {tidyOpen && <SpellingCleanup storeId={storeId} parts={parts} cars={cars} onApplied={onVehiclesChanged} />}

      {pivot === 'part'
        ? <Insights storeId={storeId} initial={initial} />
        : <Vehicles parts={parts} cars={cars} sales={sales} costing={costing} level={pivot === 'car' ? 'cars' : 'models'} />}
    </div>
  )
}
