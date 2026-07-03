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

// PartVault's neutral top-level categories → keyword sets used to name-match the
// best leaf category within each marketplace's car-parts branch. `neg` excludes
// false positives (e.g. don't let "Engine Cooling" win the plain "engine" match).
const FRIENDLY: Record<string, { kw: string[]; neg?: string[] }> = {
  'Air & Fuel Delivery': { kw: ['fuel', 'air intake', 'turbo', 'carburett', 'carburet', 'injector', 'throttle', 'intercooler', 'air filter'] },
  'Air Conditioning & Heating': { kw: ['air conditioning', 'a/c', 'heater', 'heating', 'condenser', 'compressor', 'evaporator'] },
  'Brakes & Brake Parts': { kw: ['brake'] },
  'Engine Cooling': { kw: ['cooling', 'radiator', 'water pump', 'thermostat', 'coolant'] },
  'Engines & Engine Parts': { kw: ['engine', 'cylinder head', 'camshaft', 'crankshaft', 'piston', 'valve cover', 'timing'], neg: ['cooling', 'mount'] },
  'Exhaust & Emission': { kw: ['exhaust', 'emission', 'catalytic', 'muffler', 'manifold', 'dpf', 'egr'] },
  'Exterior Parts': { kw: ['exterior', 'bumper', 'guard', 'fender', 'mirror', 'bonnet', 'hood', 'grille', 'body', 'panel'] },
  'Ignition Systems': { kw: ['ignition', 'spark plug', 'glow plug', 'coil', 'distributor'] },
  'Interior Parts': { kw: ['interior', 'dash', 'seat', 'instrument', 'steering wheel', 'window regulator'] },
  'Lighting & Bulbs': { kw: ['light', 'lamp', 'bulb', 'headlight', 'tail', 'indicator', 'globe'] },
  'Starters, Alternators & Wiring': { kw: ['alternator', 'starter', 'wiring', 'ecu', 'fuse', 'loom'] },
  'Steering & Suspension': { kw: ['steering', 'suspension', 'shock', 'strut', 'control arm', 'ball joint', 'tie rod', 'coil spring', 'wheel bearing'] },
  'Transmission & Drivetrain': { kw: ['transmission', 'gearbox', 'clutch', 'drivetrain', 'driveshaft', 'differential', 'cv ', 'transfer case'] },
  'Wheels, Tyres & Parts': { kw: ['wheel', 'tyre', 'tire', 'rim'] },
  'Towing Parts': { kw: ['tow', 'towing', 'hitch', 'trailer socket'] },
  'Other Car & Truck Parts': { kw: ['other'] },
  'Legacy Items': { kw: ['other'] },
}

// Flatten the tree into leaf nodes under the car-parts branch, each with its
// lowercased name + full path, so we can name-match deterministically.
function collectLeaves(root: any): { id: string; name: string; path: string }[] {
  const out: { id: string; name: string; path: string }[] = []
  const walk = (node: any, ancestors: string[]) => {
    const name = node?.category?.categoryName || ''
    const id = node?.category?.categoryId || ''
    const path = [...ancestors, name]
    const kids = node?.childCategoryTreeNodes || []
    if (node?.leafCategoryTreeNode && id) out.push({ id, name: name.toLowerCase(), path: path.join(' › ').toLowerCase() })
    for (const k of kids) walk(k, path)
  }
  walk(root, [])
  return out
}

// Find the "Car & Truck Parts & Accessories" (US/AU) / "Car Parts & Accessories"
// (UK/CA) subtree so we never match siblings like Trailer Parts or Electronics.
function findPartsBranch(root: any): any {
  let hit: any = null
  const walk = (node: any) => {
    if (hit) return
    const n = (node?.category?.categoryName || '').toLowerCase()
    if (/car (&|and) truck parts/.test(n) || /car parts (&|and) accessories/.test(n)) { hit = node; return }
    for (const k of (node?.childCategoryTreeNodes || [])) walk(k)
  }
  walk(root)
  if (hit) return hit
  // Fallback: broader "Parts & Accessories" node, else whole tree.
  const walk2 = (node: any) => {
    if (hit) return
    const n = (node?.category?.categoryName || '').toLowerCase()
    if (/parts (&|and) accessories/.test(n)) { hit = node; return }
    for (const k of (node?.childCategoryTreeNodes || [])) walk2(k)
  }
  walk2(root)
  return hit || root
}

// Score a leaf for a friendly category: name hits weigh 3, path hits 1; negatives disqualify.
function scoreLeaf(leaf: { name: string; path: string }, spec: { kw: string[]; neg?: string[] }): number {
  for (const n of (spec.neg || [])) if (leaf.name.includes(n)) return -1
  let s = 0
  for (const k of spec.kw) { if (leaf.name.includes(k)) s += 3; else if (leaf.path.includes(k)) s += 1 }
  return s
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
      // US vehicle parts live in eBay Motors = category tree 100 (the default US
      // tree 0 excludes Motors). Stored under EBAY_US (where the store lists).
      // AU/UK/CA include parts in their main tree via get_default_category_tree_id.
      let treeId = ''
      if (marketplace === 'EBAY_US') {
        treeId = '100'
      } else {
        const tRes = await fetch(`https://api.ebay.com/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${encodeURIComponent(marketplace)}`, { headers })
        if (!tRes.ok) { result[marketplace] = { error: `tree id lookup failed: ${tRes.status}` }; continue }
        treeId = (await tRes.json()).categoryTreeId
      }
      if (!treeId) { result[marketplace] = { error: 'no categoryTreeId' }; continue }

      // 2) fetch the full tree once, isolate the car-parts branch, collect its leaves
      const treeRes = await fetch(`https://api.ebay.com/commerce/taxonomy/v1/category_tree/${treeId}`, { headers })
      if (!treeRes.ok) { result[marketplace] = { error: `tree fetch failed: ${treeRes.status}` }; continue }
      const tree = await treeRes.json()
      const branch = findPartsBranch(tree.rootCategoryNode)
      const leaves = collectLeaves(branch)
      const topLevel = (tree.rootCategoryNode?.childCategoryTreeNodes || []).map((n: any) => n?.category?.categoryName).filter(Boolean)
      const debug = { branch: branch?.category?.categoryName || null, leafCount: leaves.length, topLevel, sampleLeaves: leaves.slice(0, 6).map((l) => l.name) }
      if (!leaves.length) { result[marketplace] = { error: 'no leaves under parts branch', debug }; continue }

      // 3) name-match each friendly category to its best-scoring leaf
      const rows: any[] = []
      for (const [friendly, spec] of Object.entries(FRIENDLY)) {
        let best: any = null, bestScore = 0
        for (const lf of leaves) {
          const sc = scoreLeaf(lf, spec)
          if (sc > bestScore) { bestScore = sc; best = lf }
        }
        rows.push({
          marketplace, friendly_category: friendly,
          ebay_category_id: best?.id || '', ebay_category_name: best ? best.path : '',
          category_tree_id: treeId, updated_at: new Date().toISOString(),
        })
      }
      const { error } = await sb.from('category_maps').upsert(rows, { onConflict: 'marketplace,friendly_category' })
      result[marketplace] = error
        ? { error: error.message, debug }
        : { treeId, mapped: rows.filter(r => r.ebay_category_id).length, total: rows.length, debug, rows: rows.map(r => ({ friendly: r.friendly_category, id: r.ebay_category_id, name: r.ebay_category_name })) }
    }
    return json({ ok: true, result })
  } catch (e: any) {
    return json({ error: e?.message || 'unknown error' }, 500)
  }
})
