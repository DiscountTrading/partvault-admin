// AI part assessment — holds the platform Anthropic key as a secret so no key
// lives in the front end or per-store settings. Any store member can call it
// (verified via their JWT); the key is never exposed to the client.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })

// Mirrors EBAY_AU_CATEGORIES in the front-end constants (keep in sync). The AI
// must pick a category AND a subcategory from this tree, so it's given the valid
// options instead of guessing.
const CATEGORY_TREE: Record<string, string[]> = {
  'Air & Fuel Delivery': ['Air Filters', 'Carburettors & Parts', 'Fuel Filters', 'Fuel Injectors', 'Fuel Pumps', 'Intercoolers', 'Throttle Bodies', 'Turbochargers & Parts', 'Other'],
  'Air Conditioning & Heating': ['A/C Compressors', 'A/C Condensers', 'Blower Motors', 'Evaporators', 'Heater Cores', 'Pollen Filters', 'Other'],
  'Brakes & Brake Parts': ['Brake Disc Rotors', 'Brake Drums', 'Brake Pads', 'Brake Shoes', 'Calipers & Brackets', 'Master Cylinders', 'Brake Hoses', 'ABS Sensors', 'Other'],
  'Engines & Engine Parts': ['Complete Engines', 'Cylinder Heads', 'Engine Mounts', 'Oil Pumps', 'Timing Belts & Kits', 'Valve Covers', 'Water Pumps', 'Other'],
  'Engine Cooling': ['Radiators', 'Water Pumps', 'Thermostats', 'Cooling Fans', 'Oil Coolers', 'Other'],
  'Exhaust & Emission': ['Catalytic Converters', 'DPF Filters', 'EGR Valves', 'Exhaust Manifolds', 'Mufflers', 'Exhaust Pipes', 'Other'],
  'Exterior Parts': ['Bumper Bars', 'Door Mirrors', 'Door Panels', 'Fenders / Guards', 'Grilles', 'Bonnet / Hood', 'Boot Lid', 'Other'],
  'Ignition Systems': ['Coil Packs', 'Glow Plugs', 'Ignition Coils', 'Spark Plugs', 'Distributor', 'Other'],
  'Interior Parts': ['Dashboards', 'Door Cards', 'Instrument Clusters', 'Seats', 'Seat Belts', 'Steering Wheels', 'Window Regulators', 'Other'],
  'Lighting & Bulbs': ['Headlight Assemblies', 'Tail Lights', 'Fog Lights', 'Indicators', 'Reverse Lights', 'Globes & Bulbs', 'Interior Lights', 'DRL', 'Other'],
  'Starters, Alternators & Wiring': ['Alternators', 'ECUs', 'Fuse Boxes', 'Starter Motors', 'Wiring Looms', 'Other'],
  'Steering & Suspension': ['Ball Joints', 'Coil Springs', 'Control Arms', 'Power Steering Pumps', 'Shock Absorbers', 'Tie Rod Ends', 'Wheel Bearings', 'Other'],
  'Transmission & Drivetrain': ['Clutch Kits', 'CV Boots', 'Driveshafts', 'Gearboxes -- Auto', 'Gearboxes -- Manual', 'Transfer Cases', 'Other'],
  'Wheels, Tyres & Parts': ['Tyres', 'Wheels -- Alloy', 'Wheels -- Steel', 'Wheel Nuts', 'Other'],
  'Towing Parts': ['Tow Bars', 'Trailer Sockets', 'Other'],
  'Other Car & Truck Parts': ['Other'],
  'Legacy Items': ['Other'],
}
const PART_CATEGORIES = Object.keys(CATEGORY_TREE)

// AI learning: the store's own recent listings become a style guide. We feed a
// few back into the prompt so new titles/descriptions match the seller's voice,
// structure and detail — and it improves as they create/edit more parts. Prefers
// same make, then same category, then any recent, de-duplicated.
async function getStyleExamples(service: any, storeId: string, make?: string, category?: string, excludeId?: string) {
  if (!storeId) return []
  const base = () => {
    let q = service.from('parts').select('title, description')
      .eq('store_id', storeId).not('description', 'is', null).neq('description', '')
      .order('updated_at', { ascending: false }).limit(6)
    if (excludeId) q = q.neq('id', excludeId)
    return q
  }
  const seen = new Set<string>()
  const out: any[] = []
  const add = (rows: any[]) => { for (const r of (rows || [])) { const d = String(r.description || '').trim(); if (d && !seen.has(d)) { seen.add(d); out.push({ title: r.title || '', description: d }) } } }
  try {
    if (make) add((await base().eq('make', make)).data)
    if (out.length < 3 && category) add((await base().eq('category', category)).data)
    if (out.length < 3) add((await base()).data)
  } catch { return [] }
  return out.slice(0, 6)
}
const styleBlock = (ex: any[]) =>
  ex.length ? `\n\nMatch THIS seller's established style — tone, structure and level of detail. Examples of their recent listings:\n${ex.map((e: any) => `• ${e.title ? e.title + ': ' : ''}${String(e.description).slice(0, 400)}`).join('\n')}` : ''

// Spelling follows the store's marketplace (default AU English).
const spellingLine = (mp?: string) => ({
  EBAY_US: '\nUse US English spelling and terms (tire, color, aluminum, windshield, hood, fender).',
  EBAY_CA: '\nUse Canadian English spelling and terms (tire, colour, aluminum, windshield).',
  EBAY_GB: '\nUse British English spelling and terms (tyre, colour, aluminium, windscreen, bonnet, wing).',
} as Record<string, string>)[mp || ''] || ''
// Market wording per marketplace (default AU): seller nationality + currency.
const MARKET_WORDS: Record<string, { adj: string; market: string; currency: string }> = {
  EBAY_US: { adj: 'American', market: 'US', currency: 'USD' },
  EBAY_GB: { adj: 'British', market: 'UK', currency: 'GBP' },
  EBAY_CA: { adj: 'Canadian', market: 'Canadian', currency: 'CAD' },
  EBAY_AU: { adj: 'Australian', market: 'Australian', currency: 'AUD' },
}
const marketWords = (mp?: string) => MARKET_WORDS[mp || ''] || MARKET_WORDS.EBAY_AU
// Best-effort store marketplace lookup (empty string = unknown → AU wording).
async function storeMarketplaceId(url: string, storeId?: string): Promise<string> {
  if (!storeId) return ''
  try {
    const svc = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data } = await svc.from('stores').select('settings').eq('id', storeId).single()
    return data?.settings?.marketplace || ''
  } catch { return '' }
}

// ── AI metering (plan enforcement) ──────────────────────────────────────────
// Full (Sonnet) assessments are the platform's real variable cost, so their
// monthly limit is enforced HERE (server-side; the client only explains).
// Founder stores are unlimited. Fail-open on any error — never let a metering
// hiccup block a paying user's work.
const AI_FULL_LIMITS: Record<string, number> = { trial: 100, basic: 50, pro: 1000, business: 3000 }
async function meterFullAI(url: string, storeId?: string): Promise<{ allowed: boolean; used: number; limit: number; tier: string; viaCredit?: boolean }> {
  const unlimited = { allowed: true, used: 0, limit: 0, tier: 'unknown' }
  if (!storeId) return unlimited
  try {
    const svc = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: st } = await svc.from('stores').select('plan').eq('id', storeId).single()
    const plan = st?.plan || {}
    if (plan.founder) { svc.rpc('increment_ai_usage', { p_store_id: storeId, p_kind: 'full' }).then(() => {}, () => {}); return { ...unlimited, tier: 'founder' } }
    const tier = plan.tier || 'business'
    const limit = AI_FULL_LIMITS[tier] ?? AI_FULL_LIMITS.business
    const month = new Date().toISOString().slice(0, 7)
    const { data: usage } = await svc.from('ai_usage').select('full_count').eq('store_id', storeId).eq('month', month).maybeSingle()
    const used = usage?.full_count || 0
    if (used >= limit) {
      // Monthly allowance exhausted — fall back to purchased credit packs.
      const { data: consumed } = await svc.rpc('consume_ai_credit', { p_store_id: storeId })
      if (consumed === true) { await svc.rpc('increment_ai_usage', { p_store_id: storeId, p_kind: 'full' }); return { allowed: true, used: used + 1, limit, tier, viaCredit: true } }
      return { allowed: false, used, limit, tier }
    }
    await svc.rpc('increment_ai_usage', { p_store_id: storeId, p_kind: 'full' })
    return { allowed: true, used: used + 1, limit, tier }
  } catch { return unlimited }
}
// Light (Haiku) calls are near-free — tracked for visibility, never blocked.
function meterLightAI(url: string, storeId?: string) {
  if (!storeId) return
  try {
    const svc = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    svc.rpc('increment_ai_usage', { p_store_id: storeId, p_kind: 'light' }).then(() => {}, () => {})
  } catch { /* ignore */ }
}
const aiLimitMsg = (m: { used: number; limit: number; tier: string }) =>
  `Monthly AI limit reached (${m.limit} full assessments on the ${m.tier} plan) and no AI credits left. Upgrade your plan or buy an AI credit pack, or it resets next month.`

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  let body: any = null
  try {
    const ANTHROPIC = Deno.env.get('ANTHROPIC_API_KEY')
    if (!ANTHROPIC) return json({ error: 'AI is not configured (missing ANTHROPIC_API_KEY secret)' }, 500)

    const url = Deno.env.get('SUPABASE_URL')!
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!
    const TRIGGER_SECRET = Deno.env.get('ASSESS_TRIGGER_SECRET')
    body = await req.json()
    const mode = body.mode || 'assess'
    // A trusted server-side trigger (DB webhook) authenticates with a shared
    // secret instead of a user JWT, and loads the part's data from the database.
    const trusted = !!(body.triggerSecret && TRIGGER_SECRET && body.triggerSecret === TRIGGER_SECRET)
    const urlOf = (v: any) => { if (!v) return null; if (typeof v === 'object') return v.url || v.ebay_url || null; try { const o = JSON.parse(v); return o.url || o.ebay_url || v } catch { return v } }
    // Capture (mobile) auto-assess does only the light items; the rest is done in
    // admin. Which light items run is a per-store setting (default category+price).
    const capCfg = { category: true, price: true }

    // Mode: help assistant — answers "how do I…" questions from PartVault help
    // knowledge (fast Haiku). Hands off to "Message us" when unsure.
    if (mode === 'help') {
      const q = String(body.question || '').slice(0, 2000)
      if (!q) return json({ error: 'question required' }, 400)
      meterLightAI(url, body.storeId)
      const history = (Array.isArray(body.history) ? body.history : []).slice(-6)
        .map((h: any) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content || '').slice(0, 2000) }))
      const sys = `You are the PartVault help assistant. PartVault is a car-parts inventory + eBay reselling platform: a mobile field app (app.partvault.app) to photograph donor cars and capture parts fast, and an admin app (admin.partvault.app) to review, price and publish parts to eBay. Key facts you can rely on:
- The mobile app is cars-first: create a donor car, then add its parts. Imported eBay history creates PARTS, not cars, so the mobile Cars list only shows cars added in the app; the admin Vehicles tab additionally infers "generated" cars from imported parts.
- After capture, AI auto-assesses each part (title, description, category, price, part number, weight); admin has ✨ Generate / ✨ Options for descriptions.
- eBay: connect a store's eBay account in admin Settings; sync is one button; listings publish live from admin.
- Plans: 14-day free trial, then Basic/Pro/Business (monthly, 12-month, or paid-upfront). AI has a monthly limit per plan plus top-up credit packs.
- Each store is tied to ONE eBay marketplace (AU/US/UK/CA), chosen at creation and locked once the first part is added; a different country = a new store.
Answer concisely and practically (1–4 sentences). If you're unsure or it needs a human, say so and tell them to use "Message us" below. Never invent features.`
      const aiRes = await callAnthropic({
        model: 'claude-haiku-4-5-20251001', max_tokens: 500, system: sys,
        messages: [...history, { role: 'user', content: q }],
      })
      const data = await aiRes.json()
      if (data.error) return json({ error: data.error.message || 'AI error' }, 400)
      return json({ ok: true, answer: textOf(data) })
    }

    if (trusted && body.partId) {
      // Auto-assess flow: pull everything we need from the part row server-side
      // so there's no dependency on the phone staying open or connected.
      const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
      const { data: p } = await service.from('parts').select('store_id, car_id, title, list_price, photos, ai_assessed, make, model, year').eq('id', body.partId).single()
      if (!p) return json({ error: 'part not found' }, 404)
      if (p.ai_assessed) return json({ ok: true, skipped: 'already assessed' })
      const { data: stCfg } = await service.from('stores').select('settings').eq('id', p.store_id).single()
      const cc = stCfg?.settings?.captureAssess
      capCfg.category = cc?.category !== false
      capCfg.price = cc?.price !== false
      body.storeId = p.store_id
      body.car = body.car || { make: p.make, model: p.model, year: p.year }
      body.carId = p.car_id
      body.existingTitle = p.title
      body.existingPrice = p.list_price
      body.categories = body.categories || PART_CATEGORIES
      let urls = Array.isArray(p.photos) ? p.photos.map(urlOf).filter(Boolean) : []
      // A photo the user tagged as the part/model-number close-up (flagged in the
      // part.photos JSON) — surfaced to the model so it reads the number exactly.
      const pnPhoto = Array.isArray(p.photos) ? p.photos.find((x: any) => x && typeof x === 'object' && (x.part_number || x.role === 'part_number')) : null
      if (pnPhoto) body.partNumberUrl = urlOf(pnPhoto)
      if (!urls.length) {
        const { data: ph } = await service.from('photos').select('url').eq('parent_type', 'part').eq('parent_id', body.partId).order('display_order')
        urls = (ph || []).map((x: any) => x.url).filter(Boolean)
      }
      if (!urls.length) return json({ error: 'part has no photos to assess' }, 400)
      body.photoUrls = urls
    }

    const { storeId } = body
    if (!storeId) return json({ error: 'storeId required' }, 400)

    // Authorise: a store member (via JWT) OR a trusted trigger call.
    if (!trusted) {
      const userClient = createClient(url, anon, { global: { headers: { Authorization: req.headers.get('Authorization') || '' } } })
      const { data: member } = await userClient.rpc('is_store_member', { p_store_id: storeId })
      if (!member) return json({ error: 'Not authorised' }, 403)
    }

    const callAnthropic = (payload: Record<string, unknown>) => fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const textOf = (data: any) => (data.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim()
    const parseJson = (raw: string) => { try { return JSON.parse(raw) } catch { const m = raw?.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null } }

    // Mode: write an eBay listing description from a prebuilt prompt. With
    // body.options > 1, returns several ranked variants ({descriptions:[...]})
    // for the seller to pick from; otherwise a single {text}.
    if (mode === 'describe') {
      const { prompt: rawPrompt } = body
      if (!rawPrompt) return json({ error: 'prompt required' }, 400)
      const meter = await meterFullAI(url, body.storeId)
      if (!meter.allowed) return json({ error: aiLimitMsg(meter) }, 429)
      // Learn from the store's own recent descriptions (style guide) + write in
      // the store's marketplace spelling (tyre/colour vs tire/color).
      let prompt = rawPrompt
      try {
        const svc = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
        const [{ data: stRow }, ex] = await Promise.all([
          svc.from('stores').select('settings').eq('id', body.storeId).single(),
          getStyleExamples(svc, body.storeId, body.make, body.category, body.partId),
        ])
        prompt = rawPrompt + spellingLine(stRow?.settings?.marketplace) + styleBlock(ex)
      } catch { /* best effort */ }
      const optionCount = Math.min(Math.max(Math.round(+body.options || 1), 1), 6)
      if (optionCount > 1) {
        const aiRes = await callAnthropic({
          model: 'claude-sonnet-4-6', max_tokens: 1800,
          messages: [{ role: 'user', content: `${prompt}\n\nProvide ${optionCount} DISTINCT description options, ranked best/most-likely first — genuinely vary the angle, emphasis and wording (not trivially reworded). If the part's side/position is uncertain (left vs right, driver vs passenger, front vs rear, upper vs lower), you MUST include options for BOTH sides — best guess first, the opposite side as another option. Return JSON only: {"descriptions":["...","..."]}` }],
        })
        const data = await aiRes.json()
        if (data.error) return json({ error: data.error.message || 'AI error' }, 400)
        const parsed = parseJson(textOf(data))
        const descriptions = Array.isArray(parsed?.descriptions) ? parsed.descriptions.filter((x: any) => typeof x === 'string' && x.trim()).slice(0, optionCount) : []
        if (!descriptions.length) return json({ error: 'No options generated' }, 400)
        return json({ ok: true, descriptions })
      }
      const aiRes = await callAnthropic({
        model: 'claude-sonnet-4-6', max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      })
      const data = await aiRes.json()
      if (data.error) return json({ error: data.error.message || 'AI error' }, 400)
      return json({ ok: true, text: textOf(data) })
    }

    // Mode: identify a car (make/model/year) from its photos — replaces VIN
    // lookup. Reads the badges/shape and any visible plates.
    if (mode === 'identify-car') {
      const carUrls = (Array.isArray(body.photoUrls) ? body.photoUrls : []).filter(Boolean).slice(0, 6)
      const carB64s = (Array.isArray(body.photoBase64s) ? body.photoBase64s : (body.photoBase64 ? [body.photoBase64] : [])).filter(Boolean).slice(0, 6)
      const blocks: any[] = [
        ...carUrls.map((u: string) => ({ type: 'image', source: { type: 'url', url: u } })),
        ...carB64s.map((b: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b } })),
      ]
      if (!blocks.length) return json({ error: 'At least one car photo is required' }, 400)
      meterLightAI(url, body.storeId)
      const mkCar = marketWords(await storeMarketplaceId(url, body.storeId))
      const aiRes = await callAnthropic({
        model: 'claude-sonnet-4-6', max_tokens: 200,
        system: `You identify ${mkCar.market}-market vehicles from photos. Return JSON only: {"make":"","model":"","year":"","confidence":"high|medium|low"}. Use the badges, body shape, lights and any visible build plate. year is the model year or a short range if unsure. Only fill a field if reasonably confident; leave "" otherwise.`,
        messages: [{ role: 'user', content: [...blocks, { type: 'text', text: `Identify this vehicle (${mkCar.market} market).` }] }],
      })
      const data = await aiRes.json()
      if (data.error) return json({ error: data.error.message || 'AI error' }, 400)
      const parsed = parseJson(textOf(data))
      if (!parsed) return json({ error: 'Could not identify the car' }, 502)
      return json({ ok: true, result: parsed })
    }

    // Mode: quick product name from photos (fast/cheap, Haiku) — used to pre-fill
    // the editable title while capturing, without the full assessment.
    if (mode === 'quick-name') {
      const urls = (Array.isArray(body.photoUrls) ? body.photoUrls : (body.photoUrl ? [body.photoUrl] : [])).filter(Boolean).slice(0, 3)
      const b64s = (Array.isArray(body.photoBase64s) ? body.photoBase64s : (body.photoBase64 ? [body.photoBase64] : [])).filter(Boolean).slice(0, 3)
      const blocks: any[] = [
        ...urls.map((u: string) => ({ type: 'image', source: { type: 'url', url: u } })),
        ...b64s.map((b: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b } })),
      ]
      if (!blocks.length) return json({ error: 'At least one photo is required' }, 400)
      const car = body.car || {}
      const nameCount = Math.min(Math.max(Math.round(+body.options || 1), 1), 6)
      const vehicleTxt = `Vehicle: ${car.make || ''} ${car.model || ''} ${car.year || ''}.`
      // Title spelling follows the marketplace — buyers search "tyre" in AU/UK
      // but "tire" in US/CA, so this directly affects search visibility.
      meterLightAI(url, body.storeId)
      const nameSpell = spellingLine(await storeMarketplaceId(url, body.storeId))
      if (nameCount > 1) {
        const aiRes = await callAnthropic({
          model: 'claude-haiku-4-5-20251001', max_tokens: 400,
          system: `You name a used car part for an eBay listing. Return JSON only: {"titles":["max 80 chars", ...]}. Give ${nameCount} DISTINCT title options, best/most-likely first. CRITICAL: if the part has a side/position that cannot be certain from the photo — left vs right, driver vs passenger, front vs rear, upper vs lower — you MUST include BOTH variants among the options (your best guess first, the opposite side as another option). Otherwise vary the part type/variant/qualifier. Front-load Make Model Year(s) then the part type, then the key qualifier (side/position). No filler, no ALL CAPS.${nameSpell}`,
          messages: [{ role: 'user', content: [...blocks, { type: 'text', text: `${vehicleTxt} Give ${nameCount} concise eBay product name options for this part.` }] }],
        })
        const data = await aiRes.json()
        if (data.error) return json({ error: data.error.message || 'AI error' }, 400)
        const parsed = parseJson(textOf(data))
        const titles = Array.isArray(parsed?.titles) ? parsed.titles.filter((x: any) => typeof x === 'string' && x.trim()).slice(0, nameCount) : []
        if (!titles.length) return json({ error: 'Could not name the part' }, 502)
        return json({ ok: true, titles })
      }
      const aiRes = await callAnthropic({
        model: 'claude-haiku-4-5-20251001', max_tokens: 120,
        system: `You name a used car part for an eBay listing. Return JSON only: {"title":"max 80 chars"}. Front-load Make Model Year(s) and the part type, then a key qualifier (side/position). No filler, no ALL CAPS.${nameSpell}`,
        messages: [{ role: 'user', content: [...blocks, { type: 'text', text: `${vehicleTxt} Give a concise eBay product name for this part.` }] }],
      })
      const data = await aiRes.json()
      if (data.error) return json({ error: data.error.message || 'AI error' }, 400)
      const parsed = parseJson(textOf(data))
      if (!parsed?.title) return json({ error: 'Could not name the part' }, 502)
      return json({ ok: true, title: parsed.title })
    }

    // Mode: parse make/model/year from a listing title (cheap, Haiku).
    if (mode === 'parse-title') {
      const { title } = body
      if (!title) return json({ error: 'title required' }, 400)
      const aiRes = await callAnthropic({
        model: 'claude-haiku-4-5-20251001', max_tokens: 200,
        messages: [{ role: 'user', content: `Extract make, model, and year range from this eBay car parts listing title. Return JSON only: {"make":"","model":"","year":""}\n\nThe "year" field should be a string like "2011-2017" for a range, or "2014" for a single year, or empty if unknown.\n\nTitle: ${title}` }],
      })
      const data = await aiRes.json()
      if (data.error) return json({ error: data.error.message || 'AI error' }, 400)
      const parsed = parseJson(textOf(data))
      if (!parsed) return json({ error: 'Could not parse AI response' }, 502)
      return json({ ok: true, result: parsed })
    }

    // Mode: assess a part from its photos (default). Uses every part photo
    // (angles, label close-ups, part-number stamps) plus the donor car's photos
    // and details as context for a more accurate assessment.
    const { photoBase64, photoBase64s, photoUrl, photoUrls, car, carId, categories, partId, existingTitle, existingPrice } = body
    const urls = (Array.isArray(photoUrls) ? photoUrls : (photoUrl ? [photoUrl] : [])).filter(Boolean).slice(0, 8)
    const b64s = (Array.isArray(photoBase64s) ? photoBase64s : (photoBase64 ? [photoBase64] : [])).filter(Boolean).slice(0, 8)
    const partBlocks: any[] = [
      ...urls.map((u: string) => ({ type: 'image', source: { type: 'url', url: u } })),
      ...b64s.map((b: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b } })),
    ]
    if (!partBlocks.length) return json({ error: 'At least one photo is required' }, 400)

    // Store marketplace → seller nationality, currency and spelling in prompts.
    const mpId = await storeMarketplaceId(url, storeId)
    const mw = marketWords(mpId)

    // ── STAGE 1 — instant capture result (mobile trigger) ───────────────────
    // Haiku + one photo → TOP category + price only. Clears ai_pending so the
    // phone updates in ~2s. Then we fall through to the full Sonnet assessment
    // below (same invocation) which finishes in the background — so it's done by
    // the time the part is reviewed in admin. The phone updates on the DB write,
    // not when the function returns, so nothing waits for stage 2.
    if (trusted && partId) {
      try {
        const catList = Object.keys(CATEGORY_TREE).join(', ')
        const lightSys = `You are an expert ${mw.adj} used car parts seller. Return JSON only: {"category":"exact","listPrice":number}. Pick the single best TOP-LEVEL category from: ${catList}. listPrice = a realistic ${mw.currency} used price.`
        const carTxt = `${car?.make || ''} ${car?.model || ''} ${car?.year || ''}`.trim()
        const aiRes = await callAnthropic({
          model: 'claude-haiku-4-5-20251001', max_tokens: 120, temperature: 0, system: lightSys,
          messages: [{ role: 'user', content: [partBlocks[0], { type: 'text', text: `Vehicle: ${carTxt}. Top category + fair used ${mw.currency} price.` }] }],
        })
        const d = await aiRes.json()
        const q = d.error ? null : parseJson(textOf(d))
        const stage1: Record<string, unknown> = { ai_pending: false }
        if (q) {
          if (capCfg.category && q.category) stage1.category = q.category
          if (capCfg.price && !(+existingPrice > 0) && +q.listPrice > 0) stage1.list_price = +q.listPrice
        }
        await createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!).from('parts').update(stage1).eq('id', partId).eq('store_id', storeId)
      } catch (_) {
        try { await createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!).from('parts').update({ ai_pending: false }).eq('id', partId) } catch (__) { /* ignore */ }
      }
      // …fall through to the full assessment (Stage 2) below.
    }

    // Authoritative donor-car details + photos (best-effort context).
    let carInfo: any = car || {}
    const carBlocks: any[] = []
    if (carId) {
      try {
        const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
        const { data: c } = await service.from('cars').select('make,model,year,notes,photos').eq('id', carId).single()
        if (c) {
          carInfo = { make: c.make || carInfo.make, model: c.model || carInfo.model, year: c.year || carInfo.year, notes: c.notes }
          const { data: ph } = await service.from('photos').select('url').eq('parent_type', 'car').eq('parent_id', carId).order('display_order').limit(4)
          let carPhotos: string[] = (ph || []).map((p: any) => p.url).filter(Boolean)
          if (!carPhotos.length && Array.isArray(c.photos)) carPhotos = c.photos.map(urlOf).filter(Boolean)
          for (const u of carPhotos.slice(0, 3)) carBlocks.push({ type: 'image', source: { type: 'url', url: u } })
        }
      } catch (_) { /* context is best-effort */ }
    }

    // Honour the store's Settings → Descriptions config so the generated
    // description follows the store's chosen length / inclusions / custom wording.
    const DESC_DEFAULTS = { includeMake: true, includeModel: true, includeSeries: true, includeYearRange: true, includePartNumber: true, includeConditionDetail: true, descriptionLength: 'medium', includeInstallLink: false, installLinkUrl: '', customPromptNotes: '' }
    let adcfg: any = DESC_DEFAULTS
    try {
      const svc = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
      const { data: st } = await svc.from('stores').select('settings').eq('id', storeId).single()
      adcfg = { ...DESC_DEFAULTS, ...(st?.settings?.aiDescription || {}) }
    } catch (_) { /* defaults */ }
    const lengthGuide = ({ short: '2-3 sentences', medium: '1-2 short paragraphs', long: 'a thorough, detailed multi-paragraph description' } as any)[adcfg.descriptionLength] || '1-2 short paragraphs'
    const incld: string[] = []
    if (adcfg.includeMake) incld.push('make')
    if (adcfg.includeModel) incld.push('model')
    if (adcfg.includeSeries) incld.push('series/badge variant')
    if (adcfg.includeYearRange) incld.push('year-range compatibility')
    if (adcfg.includePartNumber) incld.push('the OEM part number if known')
    if (adcfg.includeConditionDetail) incld.push('condition detail')
    if (adcfg.includeInstallLink && adcfg.installLinkUrl) incld.push(`a line pointing to the install guide at ${adcfg.installLinkUrl}`)
    const descGuide = `\nThe "description" field must be ${lengthGuide}, written for an eBay buyer.${incld.length ? ` Include where relevant: ${incld.join(', ')}.` : ''}${adcfg.customPromptNotes ? ` Store style notes (follow these exactly): ${adcfg.customPromptNotes}` : ''} Plain text only; do NOT add a store footer (it is appended later).${spellingLine(mpId)}`

    // AI learning: bias the auto-assessment toward the store's own recent style.
    let descLearn = ''
    try {
      const svc2 = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
      const ex = await getStyleExamples(svc2, storeId, carInfo.make || car?.make, undefined, partId)
      descLearn = styleBlock(ex)
    } catch { /* best effort */ }
    const catTree = Object.entries(CATEGORY_TREE).map(([c, subs]) => `${c}: ${subs.join(', ')}`).join('\n')
    const sys = `You are an expert ${mw.adj} used car parts eBay seller. Return JSON only.\nReturn: {"title":"max 80 chars","category":"exact","subcategory":"exact","condition":"Used – Good","description":"see rules below","partNumber":"OEM or empty","listPrice":number,"weight":number,"removalMinutes":number,"notes":""}\nremovalMinutes is a rough, generic estimate of the labour MINUTES to remove this part from the vehicle (whole number; e.g. a globe ~5, a door mirror ~15, a guard ~45, an engine ~240). It's only an initial basis, not exact.\nCATEGORY: choose the single best category, then a subcategory that is EXACTLY one of the options listed under that category. If none fit, use "Other". Do not invent a subcategory. A loose globe/bulb is "Globes & Bulbs" (or the specific light it's for), NOT a "Headlight Assembly" unless it is the whole light unit. The category list (category: allowed subcategories):\n${catTree}\ntitle MUST be optimised for eBay search (Cassini): front-load the exact terms buyers type — Make Model Year(s) PartType — then key qualifiers (side/position, OEM/part number, variant, colour). Use as much of the 80 chars as possible, no filler words, no ALL CAPS. Example: "Holden Commodore VE 2006-2013 Right Front Headlight Halogen 92193575 Genuine".\nweight is the estimated packed shipping weight in GRAMS (whole number, e.g. 1500 for 1.5kg). Never return kilograms or a value below 50.${descGuide}${descLearn}`
    const vehicleLine = `Donor vehicle: ${carInfo.make || ''} ${carInfo.model || ''} ${carInfo.year || ''}${carInfo.notes ? ` (notes: ${String(carInfo.notes).slice(0, 200)})` : ''}`.trim()
    const partNumberUrl = String(body.partNumberUrl || '')
    const content: any[] = [{ type: 'text', text: `PART photos (${partBlocks.length}) — identify THIS part:` }]
    urls.forEach((u: string) => {
      content.push({ type: 'image', source: { type: 'url', url: u } })
      if (partNumberUrl && u === partNumberUrl) content.push({ type: 'text', text: '☝ The photo above is a close-up of the part / model NUMBER — read it carefully and return it exactly as "partNumber".' })
    })
    b64s.forEach((b: string) => content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b } }))
    if (carBlocks.length) {
      content.push({ type: 'text', text: `DONOR VEHICLE photos (${carBlocks.length}) — context only, to confirm the make/model/variant. Do NOT describe the car; identify the PART above.` })
      content.push(...carBlocks)
    }
    const multi = partBlocks.length > 1 ? 'The part photos are the same part from different angles/close-ups — read any part numbers, labels or stampings.' : ''
    content.push({ type: 'text', text: `${vehicleLine}\n${multi}\nIdentify the part and return the JSON.` })
    // For the capture trigger, never leave a part stuck on "Assessing…": clear
    // ai_pending even if the AI call or parsing fails (admin can re-run later).
    const clearPendingOnFail = async () => {
      if (trusted && partId) {
        try { await createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!).from('parts').update({ ai_pending: false }).eq('id', partId) } catch (_) { /* ignore */ }
      }
    }
    // Plan enforcement: the full Sonnet assessment is the metered unit. For the
    // background capture flow, skip quietly (part stays editable, stage-1 already
    // cleared ai_pending); for a user-invoked run, explain the limit.
    const meter = await meterFullAI(url, storeId)
    if (!meter.allowed) {
      await clearPendingOnFail()
      if (trusted && partId) return json({ ok: true, skipped: 'ai_limit', message: aiLimitMsg(meter) })
      return json({ error: aiLimitMsg(meter) }, 429)
    }
    const aiRes = await callAnthropic({
      model: 'claude-sonnet-4-6', max_tokens: 1500, temperature: 0, system: sys,
      messages: [{ role: 'user', content }],
    })
    const data = await aiRes.json()
    if (data.error) { await clearPendingOnFail(); return json({ error: data.error.message || 'AI error' }, 400) }
    const parsed = parseJson(textOf(data))
    if (!parsed) { await clearPendingOnFail(); return json({ error: 'Could not parse AI response' }, 502) }

    // ── Learn from your own pricing history ─────────────────────────────────
    // Reuse the price you actually used/sold for the same part: match on OEM
    // part number first, then make/model/category. Your edits become the basis.
    let learnedPrice = 0; let learnedFrom = ''
    try {
      const svc = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
      const pickPrice = (rows: any[]) => { for (const r of (rows || [])) { const p = +r.sold_price || +r.list_price || 0; if (p > 0) return p } return 0 }
      const mk = carInfo?.make || car?.make || ''
      const md = carInfo?.model || car?.model || ''
      const pn = String(parsed.partNumber || '').trim()
      if (pn.length >= 4 && !/does not apply|n\/a|unknown|unbranded/i.test(pn)) {
        let q = svc.from('parts').select('list_price, sold_price, created_at').eq('store_id', storeId).ilike('part_number', pn).order('created_at', { ascending: false }).limit(8)
        if (partId) q = q.neq('id', partId)
        learnedPrice = pickPrice((await q).data); if (learnedPrice) learnedFrom = 'part number'
      }
      if (!learnedPrice && mk && md && parsed.category) {
        let q = svc.from('parts').select('list_price, sold_price, created_at').eq('store_id', storeId).eq('make', mk).eq('model', md).eq('category', parsed.category).order('created_at', { ascending: false }).limit(8)
        if (partId) q = q.neq('id', partId)
        learnedPrice = pickPrice((await q).data); if (learnedPrice) learnedFrom = 'similar part'
      }
    } catch (_) { /* best effort */ }

    // If a partId is given (mobile background flow), write the result back
    // server-side with the service role so it doesn't depend on the caller's
    // RLS update rights or the app staying open.
    // Stage 2 (and admin server-side): write the FULL assessment. For a captured
    // part this lands a bit after Stage 1, so it's ready by the time it's reviewed.
    let applied = false
    if (partId) {
      const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
      const aiPrice = +parsed.listPrice || 0
      const update: Record<string, unknown> = {
        subcategory: parsed.subcategory || '',
        condition: parsed.condition || 'Used – Good',
        description: parsed.description || null,
        part_number: parsed.partNumber || null,
        weight: parsed.weight || null,
        removal_minutes: +parsed.removalMinutes || null,
        ai_assessed: true,
        ai_pending: false,
      }
      // Price: your learned price (from history) wins. Otherwise, for a capture,
      // Stage 1 already set it; for an admin run, fill it if there's none yet.
      if (learnedPrice > 0) update.list_price = learnedPrice
      else if (!trusted) update.list_price = (+existingPrice > 0) ? +existingPrice : aiPrice
      if (existingTitle) update.title = existingTitle
      else if (parsed.title) update.title = parsed.title
      if (parsed.category) update.category = parsed.category
      const { error: upErr } = await service.from('parts').update(update).eq('id', partId).eq('store_id', storeId)
      if (upErr) return json({ error: `AI ran but saving failed: ${upErr.message}`, result: parsed }, 500)
      applied = true
    }
    return json({ ok: true, result: parsed, applied, learnedPrice, learnedFrom })
  } catch (e) {
    // Never leave a capture-triggered part stuck on "Assessing…".
    try {
      if (body?.triggerSecret && body?.partId) {
        await createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!).from('parts').update({ ai_pending: false }).eq('id', body.partId)
      }
    } catch (_) { /* ignore */ }
    return json({ error: (e as Error).message }, 500)
  }
})
