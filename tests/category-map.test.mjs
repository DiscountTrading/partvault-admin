// ═══════════════════════════════════════════════════════════════════════════
//  eBay category resolution tests.
//
//  Imports the SAME taxonomy.js the edge function runs. Covers the two things
//  that actually went wrong in production: a category id nobody had mapped (943
//  parts imported with no category) and a subcategory that was never derived at
//  all (every imported part). Also guards the subcategory lists in the edge
//  function against drifting from the app's own list — they're the same data in
//  two runtimes, and a silent divergence would put values in the database that
//  the part form doesn't offer.
//
//  Run:  node tests/category-map.test.mjs
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs'
import { SUB_LISTS, matchSubcategory, normName, flattenSubtree } from '../supabase/functions/ebay-import/taxonomy.js'

let passed = 0, failed = 0
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

console.log('\neBay category resolution\n')

console.log('Subcategory matching')
eq('exact name matches ours', matchSubcategory('Lighting & Bulbs', 'Tail Lights'), 'Tail Lights')
eq('eBay "Headlights" → our "Headlight Assemblies"', matchSubcategory('Lighting & Bulbs', 'Headlights'), 'Headlight Assemblies')
eq('plural/singular differences match', matchSubcategory('Brakes & Brake Parts', 'Brake Pad'), 'Brake Pads')
eq('a sub-part is NOT filed under the parent — it keeps eBay’s name',
  matchSubcategory('Brakes & Brake Parts', 'Brake Pad Wear Sensors'), 'Brake Pad Wear Sensors')
eq('"&" and "and" are the same word', matchSubcategory('Air & Fuel Delivery', 'Turbochargers and Parts'), 'Turbochargers & Parts')
eq('case and punctuation are ignored', matchSubcategory('Interior Parts', 'SEAT BELTS'), 'Seat Belts')
eq('an eBay name we have no equivalent for is KEPT, not flattened to Other',
  matchSubcategory('Interior Parts', 'Sun Visors'), 'Sun Visors')
eq('an unknown top-level category still keeps eBay’s name',
  matchSubcategory('Nonexistent Category', 'Widgets'), 'Widgets')
eq('an empty leaf name resolves to nothing', matchSubcategory('Interior Parts', ''), '')
ok('the shortest sensible match wins (no "Lights" swallowing everything)',
  matchSubcategory('Lighting & Bulbs', 'Fog Lights') === 'Fog Lights')

console.log('\nNormalisation')
eq('lowercases, strips punctuation, singularises', normName('Brake Disc Rotors'), 'brake disc rotor')
eq('expands &', normName('Wheels, Tyres & Parts'), 'wheel tyre and part')
ok('short words keep their s (a "s" is not a plural in "Gas")', normName('Gas') === 'gas')

console.log('\nSubtree flattening')
{
  // The shape eBay's get_category_subtree actually returns.
  const subtree = {
    category: { categoryId: '33707', categoryName: 'Lighting & Indicators' },
    childCategoryTreeNodes: [
      { category: { categoryId: '33710', categoryName: 'Headlights' }, leafCategoryTreeNode: true },
      {
        category: { categoryId: '33716', categoryName: 'Tail Lights' },
        childCategoryTreeNodes: [
          { category: { categoryId: '999001', categoryName: 'Tail Light Lenses' }, leafCategoryTreeNode: true },
        ],
      },
    ],
  }
  const rows = []
  flattenSubtree(subtree, 'Lighting & Bulbs', '33707', rows, 'EBAY_AU')
  eq('every node in the subtree becomes a row', rows.length, 4)
  ok('the root itself is included', rows.some(r => r.category_id === '33707'))
  ok('nested children are included', rows.some(r => r.category_id === '999001'))
  ok('every row carries our top-level category', rows.every(r => r.friendly_category === 'Lighting & Bulbs'))
  ok('every row carries the marketplace and root', rows.every(r => r.marketplace === 'EBAY_AU' && r.root_id === '33707'))
  eq('33710 (the id that imported 64 parts with no category) resolves',
    rows.find(r => r.category_id === '33710').subcategory, 'Headlight Assemblies')
  eq('a leaf with no equivalent of ours keeps eBay’s name',
    rows.find(r => r.category_id === '999001').subcategory, 'Tail Light Lenses')
  ok('a node with no category id is skipped, not crashed on', (() => {
    const out = []
    flattenSubtree({ childCategoryTreeNodes: [{ category: { categoryId: '1', categoryName: 'X' } }] }, 'Interior Parts', '33694', out, 'EBAY_AU')
    return out.length === 1
  })())
  ok('an empty response is survivable', (() => { const out = []; flattenSubtree(null, 'x', 'y', out, 'z'); return out.length === 0 })())
}

console.log('\nThe two copies of the subcategory lists agree')
{
  // The app's list is the source of truth; the edge function carries a copy
  // because it writes subcategory values into the database.
  const src = readFileSync(new URL('../src/lib/constants.js', import.meta.url), 'utf8')
  const start = src.indexOf('export const EBAY_AU_CATEGORIES')
  const body = src.slice(src.indexOf('{', start), src.indexOf('\n}', start) + 2)
  const appLists = Function(`return ${body}`)()

  const appKeys = Object.keys(appLists).sort()
  const edgeKeys = Object.keys(SUB_LISTS).sort()
  ok('same top-level categories', JSON.stringify(appKeys) === JSON.stringify(edgeKeys),
    `app: ${appKeys.filter(k => !edgeKeys.includes(k))} / edge: ${edgeKeys.filter(k => !appKeys.includes(k))}`)
  for (const k of appKeys) {
    ok(`same subcategories for ${k}`, JSON.stringify(appLists[k]) === JSON.stringify(SUB_LISTS[k]),
      `app ${JSON.stringify(appLists[k])} vs edge ${JSON.stringify(SUB_LISTS[k])}`)
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
