// Which eBay marketplace a store sells on, and how our friendly categories map
// onto that marketplace's category ids.
//
// A store's marketplace (settings.marketplace, default EBAY_AU) drives the eBay
// headers, the listing CURRENCY, and which category_maps row resolves a category
// id at list time. Parts store only the neutral friendly category; the eBay id is
// resolved here, per the store's marketplace — never stored on the part.
//
// ── Why these return a `readFailed` flag ────────────────────────────────────
// supabase-js does not throw. A missing table, a revoked grant and a transient
// connection error all come back as `{ data: null, error }`, and the original
// code here destructured `data` alone. So a failed read of `stores` was
// indistinguishable from a store that genuinely sells on eBay AU — and the
// answer is not a display value, it is the marketplace and currency a listing
// is PUBLISHED with. A UK store whose settings read blipped would have gone up
// in AUD on eBay AU, silently, with a 200 on the way out.
//
// A default is safe to render with and never to write from. These still return a
// usable default so a read-only path (building request headers, listing
// categories in the UI) carries on, but they SAY when the default is a guess,
// and requireMarketplace turns that guess into a refusal on the paths that write
// to eBay.

export type Marketplace = {
  mp: string
  currency: string
  lang: string
  treeId: string
  /** True when the store row could not be read, so `mp` is a fallback, not the store's setting. */
  readFailed: boolean
}

export const MARKETPLACE_CFG: Record<string, { currency: string; lang: string; treeId: string }> = {
  EBAY_AU: { currency: 'AUD', lang: 'en-AU', treeId: '15' },
  EBAY_US: { currency: 'USD', lang: 'en-US', treeId: '100' }, // US vehicle parts = eBay Motors tree 100
  EBAY_GB: { currency: 'GBP', lang: 'en-GB', treeId: '3' },
  EBAY_CA: { currency: 'CAD', lang: 'en-CA', treeId: '2' },
}

export const DEFAULT_MARKETPLACE = 'EBAY_AU'

// Legacy AU category ids — fallback if category_maps has no row (matches the
// pre-multi-country hardcoded map, so AU behaviour is unchanged).
export const AU_CATEGORY_FALLBACK: Record<string, string> = {
  'Air & Fuel Delivery':'33549','Air Conditioning & Heating':'33542','Brakes & Brake Parts':'33559',
  'Engines & Engine Parts':'33612','Engine Cooling':'33599','Exhaust & Emission':'33605',
  'Exterior Parts':'33637','Ignition Systems':'33687','Interior Parts':'33694',
  'Lighting & Bulbs':'33707','Starters, Alternators & Wiring':'33572','Steering & Suspension':'33579',
  'Transmission & Drivetrain':'33726','Wheels, Tyres & Parts':'33743','Towing Parts':'180143',
  'Other Car & Truck Parts':'9886','Legacy Items':'9886',
}

// The marketplace config for a stored setting value. An unrecognised marketplace
// is NOT a read failure — the store genuinely holds a value we do not support,
// and falling back to AU is the intended behaviour.
export function marketplaceFor(setting: unknown): Omit<Marketplace, 'readFailed'> {
  const mp = typeof setting === 'string' && MARKETPLACE_CFG[setting] ? setting : DEFAULT_MARKETPLACE
  return { mp, ...MARKETPLACE_CFG[mp] }
}

export async function storeMarketplace(sb: any, storeId: string): Promise<Marketplace> {
  try {
    const { data, error } = await sb.from('stores').select('settings').eq('id', storeId).single()
    // No row and a read error are different things. A store id with no row is a
    // caller bug the action will fail on anyway; an error means we do not KNOW
    // what this store sells on, which is the case worth refusing to guess at.
    if (error) {
      console.warn(`storeMarketplace: could not read store ${storeId} — ${error.message}. Falling back to ${DEFAULT_MARKETPLACE}.`)
      return { ...marketplaceFor(null), readFailed: true }
    }
    return { ...marketplaceFor(data?.settings?.marketplace), readFailed: false }
  } catch (e) {
    console.warn(`storeMarketplace: threw for store ${storeId} — ${String(e)}. Falling back to ${DEFAULT_MARKETPLACE}.`)
    return { ...marketplaceFor(null), readFailed: true }
  }
}

// Use this on any path that PUBLISHES to eBay. Listing a part on the wrong
// marketplace in the wrong currency is not recoverable by retrying later — the
// listing is already live and wrong — so a read we could not complete has to
// stop the publish rather than pick a country for the seller.
export async function requireMarketplace(sb: any, storeId: string): Promise<Marketplace> {
  const mkt = await storeMarketplace(sb, storeId)
  if (mkt.readFailed) {
    throw new Error('Could not read this store\'s marketplace setting, so the listing currency and country are unknown. Nothing was sent to eBay. Try again in a moment.')
  }
  return mkt
}

export type CategoryMap = { map: Record<string, string>; readFailed: boolean }

// friendly category -> eBay category id for this marketplace (from category_maps,
// built by the ebay-taxonomy fn). Falls back to the legacy AU ids.
//
// The fallback is AU-only, so for a non-AU store a failed read does not merely
// lose accuracy — every id belongs to the wrong category tree. eBay rejects
// those outright, which at least fails loudly, but the caller should still be
// able to tell the seller WHY.
export async function categoryMapFor(sb: any, mp: string): Promise<CategoryMap> {
  const map: Record<string, string> = { ...AU_CATEGORY_FALLBACK }
  try {
    const { data, error } = await sb.from('category_maps')
      .select('friendly_category, ebay_category_id').eq('marketplace', mp)
    if (error) {
      console.warn(`categoryMapFor: could not read category_maps for ${mp} — ${error.message}. Using the legacy AU ids.`)
      return { map, readFailed: true }
    }
    for (const r of (data || [])) if (r.ebay_category_id) map[r.friendly_category] = r.ebay_category_id
    return { map, readFailed: false }
  } catch (e) {
    console.warn(`categoryMapFor: threw for ${mp} — ${String(e)}. Using the legacy AU ids.`)
    return { map, readFailed: true }
  }
}

// ── eBay category id → our category + subcategory ───────────────────────────
// The reverse direction of categoryMapFor, and the one the SYNC needs: eBay
// hands us a leaf category id ("33710"), we need "Lighting & Bulbs" +
// "Headlight Assemblies". This used to be a hand-written map of 45 ids, so any
// listing in one of eBay's several hundred other parts categories imported with
// NO category at all — 943 of them in the live store — and no imported part ever
// got a subcategory. Now it is resolved from eBay's OWN taxonomy: walk the
// subtree of each of our 16 top-level categories once, cache every descendant in
// ebay_category_lookup, and any id resolves locally from then on.
//
// Subcategory names come from eBay's leaf, matched onto our own list where one
// fits (eBay "Headlights" → our "Headlight Assemblies"); where nothing fits we
// keep eBay's name rather than flattening it to "Other" — it's more specific,
// and the part form already shows a value that isn't in its dropdown.
//
// The pure half of that lives in ../taxonomy.js so the Node tests exercise the
// same code. This is the cached read: category id → { category, subcategory }.
//
// A failed page here used to `break` exactly as "no more rows" does, so a read
// error and an empty cache were the same outcome: an empty map, and every part
// in that sync run silently uncategorised. The read still degrades rather than
// throwing — an import that categorises nothing beats an import that runs
// nothing — but a partial read now says so, because stopping mid-way through
// the pages leaves a map that is worse than empty: it categorises SOME parts and
// silently skips the rest, which looks like eBay's data being patchy.
export type CategoryLookup = {
  lookup: Map<string, { category: string; subcategory: string | null }>
  readFailed: boolean
  partial: boolean
}

export async function categoryLookupFor(sb: any, mp: string): Promise<CategoryLookup> {
  const lookup = new Map<string, { category: string; subcategory: string | null }>()
  const PAGE = 1000
  try {
    // Paged: the AU parts tree is a few thousand nodes, past PostgREST's default cap.
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await sb.from('ebay_category_lookup')
        .select('category_id, friendly_category, subcategory').eq('marketplace', mp).range(from, from + PAGE - 1)
      if (error) {
        console.warn(`categoryLookupFor: page at offset ${from} failed for ${mp} — ${error.message}. Cached ${lookup.size} ids so far.`)
        return { lookup, readFailed: true, partial: lookup.size > 0 }
      }
      if (!data?.length) break
      for (const r of data) lookup.set(String(r.category_id), { category: r.friendly_category, subcategory: r.subcategory })
      if (data.length < PAGE) break
    }
    return { lookup, readFailed: false, partial: false }
  } catch (e) {
    console.warn(`categoryLookupFor: threw for ${mp} — ${String(e)}. Cached ${lookup.size} ids.`)
    return { lookup, readFailed: true, partial: lookup.size > 0 }
  }
}
