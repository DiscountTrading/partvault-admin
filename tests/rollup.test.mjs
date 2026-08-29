// ═══════════════════════════════════════════════════════════════════════════
//  Group rollups — the numbers on the Compare cards.
//
//  Every assertion here is a figure a seller would make a buying decision on:
//  which category earns most per part, which takes longest to shift, how much is
//  still sitting on the shelf. Getting margin's denominator wrong, or letting
//  one three-year-old part drag an average, changes what they buy next week.
//
//  The day count is checked against the SAME formula as the part_insights view
//  (sold − acquired ?? created), because a Compare card that disagrees with the
//  By-part table about how long a thing took to sell is worse than no card.
//
//  Run: node tests/rollup.test.mjs
// ═══════════════════════════════════════════════════════════════════════════
import { groupMetrics, ungrouped, daysBetween, COMPARE_DIMENSIONS } from '../src/lib/rollup.js'

let pass = 0, fail = 0
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
const near = (name, got, want, tol = 0.01) => ok(name, got != null && Math.abs(got - want) <= tol, `got ${got}, want ~${want}`)

// costing off: partEffectiveCost then falls back to the part's own recorded
// costs, so these tests are about the rollup and not the cost model.
const COSTING = { enabled: false }   // costsEnabled() reads `enabled`, not `costsEnabled`
const part = (o) => ({
  status: 'sold', costs: { acquisition: 10 }, soldPrice: 100,
  acquiredDate: '2026-01-01', soldDate: '2026-01-11', createdAt: '2026-01-01',
  category: 'Lighting & Bulbs', ...o,
})
const byCategory = (p) => p.category || ''

console.log('\ndaysBetween — the shared date maths\n')
eq('a plain span', daysBetween('2026-01-01', '2026-01-11'), 10)
eq('same day is zero, not null', daysBetween('2026-01-01', '2026-01-01'), 0)
eq('a missing end is unknown', daysBetween('2026-01-01', null), null)
eq('a missing start is unknown', daysBetween(null, '2026-01-11'), null)
// A sold date before the acquired date is corrupt data, not a negative age.
eq('a backwards span is unknown, not negative', daysBetween('2026-01-11', '2026-01-01'), null)
eq('junk dates are unknown', daysBetween('not a date', '2026-01-01'), null)

console.log('\ngroupMetrics — the money\n')
{
  const rows = groupMetrics([
    part({ category: 'Lighting & Bulbs', soldPrice: 100, costs: { acquisition: 40 } }),
    part({ category: 'Lighting & Bulbs', soldPrice: 200, costs: { acquisition: 60 } }),
    part({ category: 'Brakes & Brake Parts', soldPrice: 50, costs: { acquisition: 30 } }),
  ], byCategory, COSTING)
  eq('one row per category', rows.length, 2)
  eq('richest first', rows[0].label, 'Lighting & Bulbs')
  eq('revenue sums the sold parts', rows[0].revenue, 300)
  eq('cost sums their costs', rows[0].cost, 100)
  eq('profit is revenue minus cost', rows[0].netProfit, 200)
  // The denominator that matters: margin is a share of REVENUE. Against cost it
  // would read 200% here and flatter every category with a cheap input.
  near('margin is profit over REVENUE', rows[0].margin, (200 / 300) * 100)
  near('profit per sold part', rows[0].profitPerSold, 100)
}
{
  // Comparability is the whole point of the screen: a big category with thin
  // margins must not out-rank a small one that earns more per part on the
  // measure the seller is actually using.
  const rows = groupMetrics([
    ...Array.from({ length: 40 }, () => part({ category: 'Bulk', soldPrice: 20, costs: { acquisition: 5 } })),
    part({ category: 'Rare', soldPrice: 400, costs: { acquisition: 50 } }),
  ], byCategory, COSTING)
  const bulk = rows.find(r => r.label === 'Bulk')
  const rare = rows.find(r => r.label === 'Rare')
  eq('total profit ranks the big category first', rows[0].label, 'Bulk')
  ok('but per-part profit tells the truth', rare.profitPerSold > bulk.profitPerSold,
    `rare ${rare.profitPerSold} vs bulk ${bulk.profitPerSold}`)
}

console.log('\ngroupMetrics — how long things take\n')
{
  const rows = groupMetrics([
    part({ acquiredDate: '2026-01-01', soldDate: '2026-01-11' }),   // 10
    part({ acquiredDate: '2026-01-01', soldDate: '2026-01-21' }),   // 20
    part({ acquiredDate: '2026-01-01', soldDate: '2029-01-01' }),   // 1096 — the shelf-warmer
  ], byCategory, COSTING)
  const r = rows[0]
  eq('all three dated', r.datedSold, 3)
  // The reason both exist: the mean here is ~375 days, which describes none of
  // these parts. The median says what a part of this kind usually does.
  eq('median is the typical part', r.medianDaysToSell, 20)
  ok('mean is dragged by the outlier', r.avgDaysToSell > 300, String(r.avgDaysToSell))
}
{
  const rows = groupMetrics([
    part({ acquiredDate: null, createdAt: '2026-01-01', soldDate: '2026-01-06' }),
    part({ acquiredDate: null, createdAt: null, soldDate: '2026-01-06' }),
  ], byCategory, COSTING)
  eq('falls back to createdAt, exactly as the view does', rows[0].medianDaysToSell, 5)
  eq('a part with no usable date is not counted as zero days', rows[0].datedSold, 1)
  eq('though it still counts as a sale', rows[0].sold, 2)
}

console.log('\ngroupMetrics — what is and is not in a group\n')
{
  const rows = groupMetrics([
    part({ status: 'sold' }), part({ status: 'listed', listPrice: 75 }),
    part({ status: 'in_stock', listPrice: 25 }), part({ status: 'scrapped' }),
  ], byCategory, COSTING)
  const r = rows[0]
  eq('every part counts toward the group', r.parts, 4)
  eq('only sold parts count as sold', r.sold, 1)
  eq('listed and in-stock are the unsold shelf', r.unsold, 2)
  // Scrapped is neither sold nor sellable, so it drags sell-through down —
  // which is right: it was bought and never earned.
  eq('sell-through is over ALL parts, scrapped included', r.sellThrough, 25)
  eq('untapped is the asking price of what is still on the shelf', r.untapped, 100)
}
{
  const rows = groupMetrics([part({ deletedAt: '2026-02-01' }), part({})], byCategory, COSTING)
  eq('deleted parts are excluded entirely', rows[0].parts, 1)
}
{
  const parts = [part({ category: '' }), part({ category: null }), part({ category: 'Brakes & Brake Parts' })]
  const rows = groupMetrics(parts, byCategory, COSTING)
  // An "Other" bucket mixing uncategorised parts with real ones would look like
  // a finding. They are excluded, and counted separately so the screen can say.
  eq('parts with no value for the dimension get no card', rows.length, 1)
  eq('and are counted so the screen can admit it', ungrouped(parts, byCategory), 2)
}
{
  const rows = groupMetrics([part({ status: 'in_stock', listPrice: 40 })], byCategory, COSTING)
  const r = rows[0]
  eq('a group that has never sold still gets a card', r.parts, 1)
  eq('with no invented margin', r.margin, null)
  eq('no invented per-part profit', r.profitPerSold, null)
  eq('and no invented days', r.medianDaysToSell, null)
  eq('but its shelf value is real', r.untapped, 40)
}
deep_empty()
function deep_empty() {
  eq('no parts is an empty list, not a throw', groupMetrics([], byCategory, COSTING).length, 0)
  eq('undefined parts is survivable', groupMetrics(undefined, byCategory, COSTING).length, 0)
}

console.log('\nCOMPARE_DIMENSIONS — every one resolves against a real part\n')
{
  const p = { category: 'Lighting & Bulbs', subcategory: 'Headlight Assemblies', make: 'Ford', model: 'Falcon', condition: 'Used – Good', car_id: 'c1' }
  for (const d of COMPARE_DIMENSIONS) {
    ok(`${d.label} reads a value`, !!d.of(p), `got ${JSON.stringify(d.of(p))}`)
  }
  eq('model is qualified by make, so two Falcons are not two makes', COMPARE_DIMENSIONS.find(d => d.id === 'model').of(p), 'Ford Falcon')
  // A model with no make would group "Ranger" under itself across manufacturers.
  eq('a model with no make is excluded rather than ambiguous',
    COMPARE_DIMENSIONS.find(d => d.id === 'model').of({ model: 'Ranger' }), '')
  ok('every dimension has a distinct id', new Set(COMPARE_DIMENSIONS.map(d => d.id)).size === COMPARE_DIMENSIONS.length)
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
