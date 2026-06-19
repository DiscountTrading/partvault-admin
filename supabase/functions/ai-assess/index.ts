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

// Mirrors CATEGORY_NAMES in the front-end constants — used when the assessment
// is triggered server-side (no client to pass the list).
const PART_CATEGORIES = [
  'Air & Fuel Delivery', 'Air Conditioning & Heating', 'Brakes & Brake Parts', 'Engines & Engine Parts',
  'Engine Cooling', 'Exhaust & Emission', 'Exterior Parts', 'Ignition Systems', 'Interior Parts',
  'Lighting & Bulbs', 'Starters, Alternators & Wiring', 'Steering & Suspension', 'Transmission & Drivetrain',
  'Wheels, Tyres & Parts', 'Towing Parts', 'Other Car & Truck Parts', 'Legacy Items',
]

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const ANTHROPIC = Deno.env.get('ANTHROPIC_API_KEY')
    if (!ANTHROPIC) return json({ error: 'AI is not configured (missing ANTHROPIC_API_KEY secret)' }, 500)

    const url = Deno.env.get('SUPABASE_URL')!
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!
    const TRIGGER_SECRET = Deno.env.get('ASSESS_TRIGGER_SECRET')
    const body = await req.json()
    const mode = body.mode || 'assess'
    // A trusted server-side trigger (DB webhook) authenticates with a shared
    // secret instead of a user JWT, and loads the part's data from the database.
    const trusted = !!(body.triggerSecret && TRIGGER_SECRET && body.triggerSecret === TRIGGER_SECRET)
    const urlOf = (v: any) => { if (!v) return null; if (typeof v === 'object') return v.url || v.ebay_url || null; try { const o = JSON.parse(v); return o.url || o.ebay_url || v } catch { return v } }

    if (trusted && body.partId) {
      // Auto-assess flow: pull everything we need from the part row server-side
      // so there's no dependency on the phone staying open or connected.
      const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
      const { data: p } = await service.from('parts').select('store_id, car_id, title, list_price, photos, ai_assessed').eq('id', body.partId).single()
      if (!p) return json({ error: 'part not found' }, 404)
      if (p.ai_assessed) return json({ ok: true, skipped: 'already assessed' })
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
    const urlOf = (v: any) => { if (!v) return null; if (typeof v === 'object') return v.url || v.ebay_url || null; try { const o = JSON.parse(v); return o.url || o.ebay_url || v } catch { return v } }
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

    const cats = Array.isArray(categories) && categories.length ? categories.join(', ') : 'Other Car & Truck Parts'
    const sys = `You are an expert Australian used car parts eBay seller. Return JSON only.\nCategories: ${cats}\nReturn: {"title":"max 80 chars","category":"exact","subcategory":"exact","condition":"Used – Good","description":"3-4 sentences","partNumber":"OEM or empty","listPrice":number,"weight":number,"notes":""}\ntitle MUST be optimised for eBay search (Cassini): front-load the exact terms buyers type — Make Model Year(s) PartType — then key qualifiers (side/position, OEM/part number, variant, colour). Use as much of the 80 chars as possible, no filler words, no ALL CAPS. Example: "Holden Commodore VE 2006-2013 Right Front Headlight Halogen 92193575 Genuine".\nweight is the estimated packed shipping weight in GRAMS (whole number, e.g. 1500 for 1.5kg). Never return kilograms or a value below 50.`
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
    const aiRes = await callAnthropic({
      model: 'claude-sonnet-4-6', max_tokens: 800, system: sys,
      messages: [{ role: 'user', content }],
    })
    const data = await aiRes.json()
    if (data.error) return json({ error: data.error.message || 'AI error' }, 400)
    const parsed = parseJson(textOf(data))
    if (!parsed) return json({ error: 'Could not parse AI response' }, 502)

    // If a partId is given (mobile background flow), write the result back
    // server-side with the service role so it doesn't depend on the caller's
    // RLS update rights or the app staying open.
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
        list_price: (+existingPrice > 0) ? +existingPrice : aiPrice,
        ai_assessed: true,
        ai_pending: false,
      }
      if (parsed.title || existingTitle) update.title = parsed.title || existingTitle
      if (parsed.category) update.category = parsed.category
      const { error: upErr } = await service.from('parts').update(update).eq('id', partId).eq('store_id', storeId)
      if (upErr) return json({ error: `AI ran but saving failed: ${upErr.message}`, result: parsed }, 500)
      applied = true
    }
    return json({ ok: true, result: parsed, applied })
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
