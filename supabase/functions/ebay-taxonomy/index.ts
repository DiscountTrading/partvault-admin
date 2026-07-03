// Builds PartVault's per-marketplace category maps from eBay's Taxonomy API.
// Standalone + isolated (does NOT touch ebay-import) — worst case a bug here only
// affects category-map building, never live syncing/listing. Uses an eBay
// application token (client-credentials) — taxonomy is public data, so no seller
// account is needed to generate US/UK/CA maps.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

const APP_ID = Deno.env.get('EBAY_APP_ID') || 'Discount-PartVaul-PRD-36c135696-64f7f7bf'
const CERT_ID = Deno.env.get('EBAY_CERT_ID') || ''
const EBAY_TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token'

// PartVault's neutral top-level categories → a representative query used to ask
// eBay for the best-matching leaf category in each marketplace.
const FRIENDLY: Record<string, string> = {
  'Air & Fuel Delivery': 'car air intake fuel injector turbo',
  'Air Conditioning & Heating': 'car ac compressor heater core',
  'Brakes & Brake Parts': 'car brake caliper pads disc rotor',
  'Engines & Engine Parts': 'car engine cylinder head',
  'Engine Cooling': 'car radiator water pump thermostat',
  'Exhaust & Emission': 'car exhaust manifold catalytic converter muffler',
  'Exterior Parts': 'car bumper guard fender door mirror',
  'Ignition Systems': 'car ignition coil spark plug',
  'Interior Parts': 'car dashboard seat instrument cluster',
  'Lighting & Bulbs': 'car headlight tail light indicator',
  'Starters, Alternators & Wiring': 'car alternator starter motor ecu',
  'Steering & Suspension': 'car control arm shock absorber tie rod',
  'Transmission & Drivetrain': 'car gearbox transmission clutch driveshaft',
  'Wheels, Tyres & Parts': 'car alloy wheel tyre',
  'Towing Parts': 'car tow bar tow hitch',
  'Other Car & Truck Parts': 'car truck part',
  'Legacy Items': 'car truck part',
}

let _tok = { token: '', exp: 0 }
async function appToken(): Promise<string> {
  if (_tok.token && _tok.exp - Date.now() > 60000) return _tok.token
  const res = await fetch(EBAY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${btoa(`${APP_ID}:${CERT_ID}`)}` },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope' }),
  })
  const d = await res.json()
  if (!d.access_token) throw new Error(`eBay app token failed: ${d.error_description || 'unknown'}`)
  _tok = { token: d.access_token, exp: Date.now() + (d.expires_in || 7200) * 1000 }
  return d.access_token
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    if (!CERT_ID) return json({ error: 'EBAY_CERT_ID secret not configured' }, 500)
    const body = await req.json().catch(() => ({}))
    const marketplaces: string[] = Array.isArray(body.marketplaces) && body.marketplaces.length
      ? body.marketplaces
      : [body.marketplace || 'EBAY_AU']

    const token = await appToken()
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    const result: any = {}
    for (const marketplace of marketplaces) {
      // 1) default category tree id for this marketplace
      const tRes = await fetch(`https://api.ebay.com/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${encodeURIComponent(marketplace)}`, { headers })
      if (!tRes.ok) { result[marketplace] = { error: `tree id lookup failed: ${tRes.status}` }; continue }
      const treeId = (await tRes.json()).categoryTreeId
      if (!treeId) { result[marketplace] = { error: 'no categoryTreeId' }; continue }

      // 2) best-match leaf per friendly category via get_category_suggestions
      const rows: any[] = []
      for (const [friendly, q] of Object.entries(FRIENDLY)) {
        let ebayId = '', ebayName = ''
        try {
          const r = await fetch(`https://api.ebay.com/commerce/taxonomy/v1/category_tree/${treeId}/get_category_suggestions?q=${encodeURIComponent(q)}`, { headers })
          if (r.ok) {
            const d = await r.json()
            const sug = d.categorySuggestions?.[0]
            if (sug?.category?.categoryId) {
              ebayId = sug.category.categoryId
              const anc = (sug.categoryTreeNodeAncestors || []).map((a: any) => a.categoryName).reverse()
              ebayName = [...anc, sug.category.categoryName].filter(Boolean).join(' › ')
            }
          }
        } catch { /* leave blank; can re-run */ }
        rows.push({ marketplace, friendly_category: friendly, ebay_category_id: ebayId, ebay_category_name: ebayName, category_tree_id: treeId, updated_at: new Date().toISOString() })
      }
      const { error } = await sb.from('category_maps').upsert(rows, { onConflict: 'marketplace,friendly_category' })
      result[marketplace] = error
        ? { error: error.message }
        : { treeId, mapped: rows.filter(r => r.ebay_category_id).length, total: rows.length, rows: rows.map(r => ({ friendly: r.friendly_category, id: r.ebay_category_id, name: r.ebay_category_name })) }
    }
    return json({ ok: true, result })
  } catch (e: any) {
    return json({ error: e?.message || 'unknown error' }, 500)
  }
})
