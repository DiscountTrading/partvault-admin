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

    if (trusted && body.partId) {
      // Auto-assess flow: pull everything we need from the part row server-side
      // so there's no dependency on the phone staying open or connected.
      const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
      const { data: p } = await service.from('parts').select('store_id, car_id, title, list_price, photos, ai_assessed').eq('id', body.partId).single()
      if (!p) return json({ error: 'part not found' }, 404)
      if (p.ai_assessed) return json({ ok: true, skipped: 'already assessed' })
      const { data: stCfg } = await service.from('stores').select('settings').eq('id', p.store_id).single()
      const cc = stCfg?.settings?.captureAssess
      capCfg.category = cc?.category !== false
      capCfg.price = cc?.price !== false
      body.storeId = p.store_id
      body.carId = p.car_id
      body.existingTitle = p.title
      body.existingPrice = p.list_price
      body.categories = body.categories || PART_CATEGORIES
      let urls = Array.isArray(p.photos) ? p.photos.map(urlOf).filter(Boolean) : []
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

    // Mode: write an eBay listing description from a prebuilt prompt.
    if (mode === 'describe') {
      const { prompt } = body
      if (!prompt) return json({ error: 'prompt required' }, 400)
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
      const aiRes = await callAnthropic({
        model: 'claude-sonnet-4-6', max_tokens: 200,
        system: 'You identify Australian-market vehicles from photos. Return JSON only: {"make":"","model":"","year":"","confidence":"high|medium|low"}. Use the badges, body shape, lights and any visible build plate. year is the model year or a short range if unsure. Only fill a field if reasonably confident; leave "" otherwise.',
        messages: [{ role: 'user', content: [...blocks, { type: 'text', text: 'Identify this vehicle (Australian market).' }] }],
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
      const aiRes = await callAnthropic({
        model: 'claude-haiku-4-5-20251001', max_tokens: 120,
        system: 'You name a used car part for an eBay listing. Return JSON only: {"title":"max 80 chars"}. Front-load Make Model Year(s) and the part type, then a key qualifier (side/position). No filler, no ALL CAPS.',
        messages: [{ role: 'user', content: [...blocks, { type: 'text', text: `Vehicle: ${car.make || ''} ${car.model || ''} ${car.year || ''}. Give a concise eBay product name for this part.` }] }],
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
    const descGuide = `\nThe "description" field must be ${lengthGuide}, written for an eBay buyer.${incld.length ? ` Include where relevant: ${incld.join(', ')}.` : ''}${adcfg.customPromptNotes ? ` Store style notes (follow these exactly): ${adcfg.customPromptNotes}` : ''} Plain text only; do NOT add a store footer (it is appended later).`

    const catTree = Object.entries(CATEGORY_TREE).map(([c, subs]) => `${c}: ${subs.join(', ')}`).join('\n')
    const sys = `You are an expert Australian used car parts eBay seller. Return JSON only.\nReturn: {"title":"max 80 chars","category":"exact","subcategory":"exact","condition":"Used – Good","description":"see rules below","partNumber":"OEM or empty","listPrice":number,"weight":number,"notes":""}\nCATEGORY: choose the single best category, then a subcategory that is EXACTLY one of the options listed under that category. If none fit, use "Other". Do not invent a subcategory. A loose globe/bulb is "Globes & Bulbs" (or the specific light it's for), NOT a "Headlight Assembly" unless it is the whole light unit. The category list (category: allowed subcategories):\n${catTree}\ntitle MUST be optimised for eBay search (Cassini): front-load the exact terms buyers type — Make Model Year(s) PartType — then key qualifiers (side/position, OEM/part number, variant, colour). Use as much of the 80 chars as possible, no filler words, no ALL CAPS. Example: "Holden Commodore VE 2006-2013 Right Front Headlight Halogen 92193575 Genuine".\nweight is the estimated packed shipping weight in GRAMS (whole number, e.g. 1500 for 1.5kg). Never return kilograms or a value below 50.${descGuide}`
    const vehicleLine = `Donor vehicle: ${carInfo.make || ''} ${carInfo.model || ''} ${carInfo.year || ''}${carInfo.notes ? ` (notes: ${String(carInfo.notes).slice(0, 200)})` : ''}`.trim()
    const content: any[] = [
      { type: 'text', text: `PART photos (${partBlocks.length}) — identify THIS part:` },
      ...partBlocks,
    ]
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
    const aiRes = await callAnthropic({
      model: 'claude-sonnet-4-6', max_tokens: 1500, system: sys,
      messages: [{ role: 'user', content }],
    })
    const data = await aiRes.json()
    if (data.error) { await clearPendingOnFail(); return json({ error: data.error.message || 'AI error' }, 400) }
    const parsed = parseJson(textOf(data))
    if (!parsed) { await clearPendingOnFail(); return json({ error: 'Could not parse AI response' }, 502) }

    // If a partId is given (mobile background flow), write the result back
    // server-side with the service role so it doesn't depend on the caller's
    // RLS update rights or the app staying open.
    let applied = false
    if (partId) {
      const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
      const aiPrice = +parsed.listPrice || 0
      let update: Record<string, unknown>
      if (trusted) {
        // Capture (mobile): only the light items per the store's captureAssess
        // setting. Description / part number / specifics / fitment stay for admin,
        // so ai_assessed stays false (admin still shows "Needs AI").
        update = { ai_pending: false, ai_assessed: false }
        if (capCfg.category && parsed.category) { update.category = parsed.category; update.subcategory = parsed.subcategory || '' }
        if (capCfg.price && !(+existingPrice > 0) && aiPrice) update.list_price = aiPrice
        // Title was set at capture (AI-prefilled name); only fall back if blank.
        if (!existingTitle && parsed.title) update.title = parsed.title
      } else {
        // Full assessment (admin, server-side): everything.
        update = {
          subcategory: parsed.subcategory || '',
          condition: parsed.condition || 'Used – Good',
          description: parsed.description || null,
          part_number: parsed.partNumber || null,
          weight: parsed.weight || null,
          list_price: (+existingPrice > 0) ? +existingPrice : aiPrice,
          ai_assessed: true,
          ai_pending: false,
        }
        if (existingTitle) update.title = existingTitle
        else if (parsed.title) update.title = parsed.title
        if (parsed.category) update.category = parsed.category
      }
      const { error: upErr } = await service.from('parts').update(update).eq('id', partId).eq('store_id', storeId)
      if (upErr) return json({ error: `AI ran but saving failed: ${upErr.message}`, result: parsed }, 500)
      applied = true
    }
    return json({ ok: true, result: parsed, applied })
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
