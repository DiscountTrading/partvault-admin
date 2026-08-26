// ═══════════════════════════════════════════════════════════════════════════
//  Listing helpers — the small decisions that cost money if they're wrong.
//
//  categoryKeyFor is the key under which a category CORRECTION is remembered.
//  Too strict and the store re-teaches eBay the same fix forever; too loose and
//  one correction leaks onto unrelated parts. resolveShipping decides the weight
//  and dimensions a listing quotes, which is what the seller is charged when it
//  sells.
//
//  Run: node --experimental-strip-types tests/listing-helpers.test.mjs
// ═══════════════════════════════════════════════════════════════════════════
import {
  partTypeToken, categoryKeyFor, learnedCategoryFor, resolveShipping,
} from '../supabase/functions/ebay-import/ebay/listing-helpers.ts'

let pass = 0, fail = 0
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

console.log('\npartTypeToken — what KIND of part is this?\n')
const P = (title, extra = {}) => ({ title, make: 'Ford', model: 'Falcon', ...extra })

eq('drops the vehicle, keeps the part',
  partTypeToken(P('Ford Falcon Headlight Halogen')), 'halogen headlight')

// ⚠ KNOWN DEFECT, pinned here rather than fixed — see the note at the foot of
// this file. A series/badge code survives the filter and can push the actual
// noun out of the two-word token.
eq('a series code survives and displaces the noun (AU kept, "halogen" dropped)',
  partTypeToken(P('Ford Falcon AU Headlight Halogen')), 'au headlight')
eq('so the same part on another series keys differently',
  partTypeToken({ title: 'Holden Commodore VE Tail Light', make: 'Holden', model: 'Commodore' }), 'tail ve')
ok('order-independent, so the same part keys the same either way',
  partTypeToken(P('Ford Falcon Headlight Halogen')) === partTypeToken(P('Ford Falcon Halogen Headlight')))
ok('side and condition words do not change the kind',
  partTypeToken(P('Ford Falcon Front Left Genuine Used Headlight Halogen')) === partTypeToken(P('Ford Falcon Headlight Halogen')))
ok('years are not part of the kind',
  partTypeToken(P('Ford Falcon Headlight Halogen 2005-2010')) === partTypeToken(P('Ford Falcon Headlight Halogen')))
ok('a part number is removed rather than treated as a word',
  !partTypeToken(P('Ford Falcon Headlight 8P0959801A', { part_number: '8P0959801A' })).includes('8p0959801a'))
eq('an empty title yields no kind', partTypeToken(P('')), '')

console.log('\ncategoryKeyFor — where a correction is remembered')
eq('a real subcategory is specific enough on its own',
  categoryKeyFor({ category: 'Lighting & Bulbs', subcategory: 'Tail Lights' }), 'lighting & bulbs|tail lights')
ok('"Other" is NOT specific enough, so the part kind joins the key',
  categoryKeyFor(P('Ford Falcon Headlight Halogen', { category: 'Lighting & Bulbs', subcategory: 'Other' }))
    .startsWith('lighting & bulbs|other|'))
ok('a missing subcategory behaves like Other',
  categoryKeyFor(P('Ford Falcon Headlight Halogen', { category: 'Lighting & Bulbs' })).split('|').length === 3)
ok('two different kinds under Other do NOT share a key',
  categoryKeyFor(P('Ford Falcon Headlight Halogen', { category: 'Interior Parts', subcategory: 'Other' })) !==
  categoryKeyFor(P('Ford Falcon Window Switch', { category: 'Interior Parts', subcategory: 'Other' })))
ok('case and padding do not create a second key',
  categoryKeyFor({ category: '  Lighting & Bulbs ', subcategory: 'TAIL LIGHTS' }) ===
  categoryKeyFor({ category: 'lighting & bulbs', subcategory: 'tail lights' }))

console.log('\nlearnedCategoryFor — recalling one')
{
  const part = { category: 'Lighting & Bulbs', subcategory: 'Tail Lights' }
  const settings = { categoryLearning: { [categoryKeyFor(part)]: { id: '33716', name: 'Tail Lights' } } }
  eq('finds the remembered id', learnedCategoryFor(settings, part)?.id, '33716')
  ok('a different part does not inherit it',
    learnedCategoryFor(settings, { category: 'Interior Parts', subcategory: 'Seats' }) === null)
  ok('no settings is survivable', learnedCategoryFor(undefined, part) === null)
  ok('a malformed entry is ignored rather than thrown on',
    learnedCategoryFor({ categoryLearning: { [categoryKeyFor(part)]: { name: 'no id' } } }, part) === null)
}

console.log('\nresolveShipping — what the seller gets charged')
{
  const cats = { 'Lighting & Bulbs': { weightG: 1200, l: 40, w: 30, h: 20 } }
  const dims = { l: 30, w: 20, h: 15 }
  eq("the part's own weight wins",
    resolveShipping({ category: 'Lighting & Bulbs', weight: 2500 }, cats, 500, dims).weightG, 2500)
  eq('otherwise the category preset',
    resolveShipping({ category: 'Lighting & Bulbs' }, cats, 500, dims).weightG, 1200)
  eq('otherwise the store default',
    resolveShipping({ category: 'Interior Parts' }, cats, 500, dims).weightG, 500)
  eq('a zero weight never ships as zero',
    resolveShipping({ category: 'Interior Parts', weight: 0 }, cats, 500, dims).weightG, 500)
  eq('nor does a sub-gram weight',
    resolveShipping({ category: 'Interior Parts', weight: 0.4 }, cats, 500, dims).weightG, 500)
  const d = resolveShipping({ category: 'Interior Parts' }, cats, 500, {})
  ok('dimensions always come out positive', d.dimL > 0 && d.dimW > 0 && d.dimH > 0)
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)

// ═══════════════════════════════════════════════════════════════════════════
//  ⚠ FINDING — partTypeToken keeps series/badge codes
//
//  The token is meant to capture what KIND of part something is, so that a
//  category correction made once is recalled for similar parts. It filters out
//  the make, the model, years, sides and condition words, then keeps the first
//  two surviving words.
//
//  A series code is not filtered:
//     Ford Falcon AU Headlight Halogen  -> "au headlight"
//     Ford Falcon BA Headlight Halogen  -> "ba headlight"
//     Holden Commodore VE Tail Light    -> "tail ve"     (note: "light" dropped)
//
//  Two consequences. Corrections do not generalise across series — teach it once
//  for a VE and it asks again for the VF — and the code can displace the actual
//  noun, so "tail ve" is the key for a tail light.
//
//  NOT fixed here on purpose: the token IS the storage key in
//  stores.settings.categoryLearning, so changing it silently orphans every
//  correction already learned. That wants a decision (and probably a one-off
//  re-key) rather than a quiet edit. The tests above pin today's behaviour so
//  the change is deliberate whenever it happens.
// ═══════════════════════════════════════════════════════════════════════════
