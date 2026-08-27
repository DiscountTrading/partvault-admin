// ═══════════════════════════════════════════════════════════════════════════
//  Marketplace resolution — which country and currency a part is listed in.
//
//  The point of this suite is one distinction the original code could not make:
//  a store that genuinely sells on eBay AU, and a store whose settings we FAILED
//  TO READ. supabase-js never throws, so both arrived as the same value, and the
//  answer is not a display string — it is the marketplace and currency a listing
//  is published with. A UK store whose read blipped would have gone live in AUD
//  on eBay AU.
//
//  So every read here is exercised three ways: it worked, it errored, it threw.
//
//  Run: node --experimental-strip-types tests/marketplace.test.mjs
// ═══════════════════════════════════════════════════════════════════════════
import {
  MARKETPLACE_CFG, AU_CATEGORY_FALLBACK, DEFAULT_MARKETPLACE, marketplaceFor,
  storeMarketplace, requireMarketplace, categoryMapFor, categoryLookupFor,
} from '../supabase/functions/ebay-import/ebay/marketplace.ts'

let pass = 0, fail = 0
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
const deep = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
const threw = async (name, fn, match) => {
  try { await fn(); ok(name, false, 'did not throw') }
  catch (e) { ok(name, !match || match.test(String(e.message)), `message was "${e.message}"`) }
}

// Silence the deliberate console.warn on every failure path — the warnings are
// the point in production and noise here.
console.warn = () => {}

// A stand-in for the supabase-js client, built to return exactly what the real
// one returns: { data, error } — never a throw — unless told to throw.
const fakeSb = (handlers) => ({
  from(table) {
    const h = handlers[table]
    const q = {
      select: () => q,
      eq: () => q,
      range: (from, to) => { q._range = [from, to]; return typeof h === 'function' ? h(q._range) : h },
      single: () => (typeof h === 'function' ? h() : h),
      then: (res, rej) => Promise.resolve(typeof h === 'function' ? h() : h).then(res, rej),
    }
    return q
  },
})
const boom = () => { throw new Error('connection reset') }

console.log('\nmarketplaceFor — a stored setting to a config\n')
deep('a known marketplace', marketplaceFor('EBAY_GB'), { mp: 'EBAY_GB', currency: 'GBP', lang: 'en-GB', treeId: '3' })
eq('an unknown one falls back to AU', marketplaceFor('EBAY_NZ').mp, 'EBAY_AU')
eq('so does null', marketplaceFor(null).mp, 'EBAY_AU')
eq('and a non-string', marketplaceFor(42).mp, 'EBAY_AU')
eq('the default is AU', DEFAULT_MARKETPLACE, 'EBAY_AU')
ok('every configured marketplace has a currency, language and tree id',
  Object.values(MARKETPLACE_CFG).every(c => c.currency && c.lang && c.treeId))
// US vehicle parts live in eBay Motors (tree 100), not the default US tree — a
// wrong tree id means every category lookup for a US store misses.
eq('US uses the eBay Motors tree', MARKETPLACE_CFG.EBAY_US.treeId, '100')
ok('no two marketplaces share a currency by accident',
  new Set(Object.values(MARKETPLACE_CFG).map(c => c.currency)).size === Object.keys(MARKETPLACE_CFG).length)

console.log('\nstoreMarketplace — the read that decides the listing currency\n')
{
  const sb = fakeSb({ stores: () => ({ data: { settings: { marketplace: 'EBAY_GB' } }, error: null }) })
  const m = await storeMarketplace(sb, 'store-1')
  eq('a GB store lists in GB', m.mp, 'EBAY_GB')
  eq('in GBP', m.currency, 'GBP')
  eq('and the read is known good', m.readFailed, false)
}
{
  const sb = fakeSb({ stores: () => ({ data: { settings: {} }, error: null }) })
  const m = await storeMarketplace(sb, 'store-1')
  eq('a store with no marketplace set is AU', m.mp, 'EBAY_AU')
  // This is the distinction that did not exist before: an unset setting is a
  // real answer, so the publish may proceed.
  eq('and that is a real answer, not a guess', m.readFailed, false)
}
{
  const sb = fakeSb({ stores: () => ({ data: null, error: { message: 'permission denied for table stores' } }) })
  const m = await storeMarketplace(sb, 'store-1')
  eq('a failed read still returns something usable', m.mp, 'EBAY_AU')
  ok('but says the answer is a guess', m.readFailed === true)
}
{
  const sb = fakeSb({ stores: boom })
  const m = await storeMarketplace(sb, 'store-1')
  ok('a thrown read is a guess too, not an unhandled error', m.readFailed === true)
  eq('and still yields a usable default', m.currency, 'AUD')
}
{
  const sb = fakeSb({ stores: () => ({ data: { settings: { marketplace: 'EBAY_XX' } }, error: null }) })
  const m = await storeMarketplace(sb, 'store-1')
  eq('an unsupported stored marketplace falls back', m.mp, 'EBAY_AU')
  ok('and is NOT a read failure — we read it fine, we just do not support it', m.readFailed === false)
}

console.log('\nrequireMarketplace — the publish paths must not guess a country\n')
{
  const sb = fakeSb({ stores: () => ({ data: { settings: { marketplace: 'EBAY_US' } }, error: null }) })
  eq('a good read passes straight through', (await requireMarketplace(sb, 's')).mp, 'EBAY_US')
}
await threw('a failed read REFUSES rather than listing in the wrong currency',
  () => requireMarketplace(fakeSb({ stores: () => ({ data: null, error: { message: 'timeout' } }) }), 's'),
  /Nothing was sent to eBay/)
await threw('a thrown read refuses too',
  () => requireMarketplace(fakeSb({ stores: boom }), 's'))
{
  // The message reaches the seller, so it has to say what happened, what it
  // cost them (nothing), and what to do — not "error: timeout".
  let msg = ''
  try { await requireMarketplace(fakeSb({ stores: boom }), 's') } catch (e) { msg = e.message }
  ok('the refusal says nothing was sent', /Nothing was sent to eBay/.test(msg))
  ok('and what to do about it', /[Tt]ry again/.test(msg))
  ok('without leaking the database error at the seller', !/connection reset/.test(msg))
}

console.log('\ncategoryMapFor — friendly category to an eBay category id\n')
{
  const sb = fakeSb({ category_maps: () => ({ data: [
    { friendly_category: 'Lighting & Bulbs', ebay_category_id: '9999' },
    { friendly_category: 'Brand New Category', ebay_category_id: '1234' },
    { friendly_category: 'Broken Row', ebay_category_id: null },
  ], error: null }) })
  const { map, readFailed } = await categoryMapFor(sb, 'EBAY_US')
  eq('a mapped category overrides the AU fallback', map['Lighting & Bulbs'], '9999')
  eq('a category only the map knows is added', map['Brand New Category'], '1234')
  eq('a row with no id does not erase the fallback', map['Broken Row'], undefined)
  eq('an unmapped category keeps its AU fallback', map['Brakes & Brake Parts'], AU_CATEGORY_FALLBACK['Brakes & Brake Parts'])
  eq('and the read is known good', readFailed, false)
}
{
  const sb = fakeSb({ category_maps: () => ({ data: null, error: { message: 'relation does not exist' } }) })
  const { map, readFailed } = await categoryMapFor(sb, 'EBAY_US')
  ok('a failed read still returns the legacy map', Object.keys(map).length === Object.keys(AU_CATEGORY_FALLBACK).length)
  // For a US store every id in that map belongs to the wrong tree. eBay rejects
  // them, so it fails loudly — but the caller can now say why.
  ok('and says so, because for a non-AU store every id in it is from the wrong tree', readFailed === true)
}
{
  const { readFailed } = await categoryMapFor(fakeSb({ category_maps: boom }), 'EBAY_AU')
  ok('a thrown read reports failure rather than escaping', readFailed === true)
}
{
  const { map, readFailed } = await categoryMapFor(fakeSb({ category_maps: () => ({ data: [], error: null }) }), 'EBAY_AU')
  eq('an EMPTY table is not a failure — AU legitimately runs on the fallback', readFailed, false)
  eq('and the fallback is intact', map['Legacy Items'], '9886')
}
ok('every fallback id is a bare number, as eBay category ids are',
  Object.values(AU_CATEGORY_FALLBACK).every(v => /^\d+$/.test(v)))

console.log('\ncategoryLookupFor — eBay category id back to ours, paged\n')
{
  // Two full pages then a short one: the loop must not stop at the first page.
  const pages = [
    Array.from({ length: 1000 }, (_, i) => ({ category_id: 1000 + i, friendly_category: 'Lighting & Bulbs', subcategory: 'Headlight Assemblies' })),
    Array.from({ length: 1000 }, (_, i) => ({ category_id: 2000 + i, friendly_category: 'Interior Parts', subcategory: null })),
    [{ category_id: 9999, friendly_category: 'Towing Parts', subcategory: 'Tow Bars' }],
  ]
  const sb = fakeSb({ ebay_category_lookup: ([from]) => ({ data: pages[from / 1000] ?? [], error: null }) })
  const { lookup, readFailed, partial } = await categoryLookupFor(sb, 'EBAY_AU')
  eq('every page is read', lookup.size, 2001)
  deep('an id resolves to our category and subcategory', lookup.get('1000'), { category: 'Lighting & Bulbs', subcategory: 'Headlight Assemblies' })
  eq('ids are keyed as strings, because eBay sends them as strings', lookup.get('9999')?.subcategory, 'Tow Bars')
  eq('a null subcategory survives as null', lookup.get('2000')?.subcategory, null)
  eq('a complete read is not a failure', readFailed, false)
  eq('nor partial', partial, false)
}
{
  const sb = fakeSb({ ebay_category_lookup: () => ({ data: [], error: null }) })
  const { lookup, readFailed } = await categoryLookupFor(sb, 'EBAY_AU')
  eq('an empty cache is empty', lookup.size, 0)
  // Before, this was indistinguishable from the error case below.
  eq('and is NOT a failure — the taxonomy walk simply has not run yet', readFailed, false)
}
{
  const sb = fakeSb({ ebay_category_lookup: () => ({ data: null, error: { message: 'permission denied' } }) })
  const { lookup, readFailed, partial } = await categoryLookupFor(sb, 'EBAY_AU')
  eq('a failed first page yields nothing', lookup.size, 0)
  ok('but is reported as a failure, not as an empty cache', readFailed === true)
  eq('and is not partial, because nothing was read', partial, false)
}
{
  // The nastiest case: page one lands, page two fails. The map then categorises
  // SOME parts and silently skips the rest, which reads as eBay's data being
  // patchy rather than as our read being broken.
  const sb = fakeSb({ ebay_category_lookup: ([from]) => from === 0
    ? { data: Array.from({ length: 1000 }, (_, i) => ({ category_id: i, friendly_category: 'Interior Parts', subcategory: null })), error: null }
    : { data: null, error: { message: 'statement timeout' } } })
  const { lookup, readFailed, partial } = await categoryLookupFor(sb, 'EBAY_AU')
  eq('what was read is kept', lookup.size, 1000)
  ok('the failure is reported', readFailed === true)
  ok('and flagged as PARTIAL, which is worse than empty — it looks like it worked', partial === true)
}
{
  const { readFailed } = await categoryLookupFor(fakeSb({ ebay_category_lookup: boom }), 'EBAY_AU')
  ok('a thrown page reports failure rather than escaping', readFailed === true)
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
