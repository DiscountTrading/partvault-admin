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

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const ANTHROPIC = Deno.env.get('ANTHROPIC_API_KEY')
    if (!ANTHROPIC) return json({ error: 'AI is not configured (missing ANTHROPIC_API_KEY secret)' }, 500)

    const url = Deno.env.get('SUPABASE_URL')!
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!
    const body = await req.json()
    const { storeId, mode = 'assess' } = body
    if (!storeId) return json({ error: 'storeId required' }, 400)

    // Authorise: caller must be a member of this store.
    const userClient = createClient(url, anon, { global: { headers: { Authorization: req.headers.get('Authorization') || '' } } })
    const { data: member } = await userClient.rpc('is_store_member', { p_store_id: storeId })
    if (!member) return json({ error: 'Not authorised' }, 403)

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

    // Mode: assess a part from its photo (default).
    const { photoBase64, photoUrl, car, categories, partId, existingTitle, existingPrice } = body
    let b64 = photoBase64
    if (!b64 && photoUrl) {
      const imgRes = await fetch(photoUrl)
      if (!imgRes.ok) return json({ error: `Could not fetch photo (${imgRes.status})` }, 400)
      const bytes = new Uint8Array(await imgRes.arrayBuffer())
      let bin = ''
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
      b64 = btoa(bin)
    }
    if (!b64) return json({ error: 'photoBase64 or photoUrl required' }, 400)
    const cats = Array.isArray(categories) && categories.length ? categories.join(', ') : 'Other Car & Truck Parts'
    const sys = `You are an expert Australian used car parts eBay seller. Return JSON only.\nCategories: ${cats}\nReturn: {"title":"max 80 chars","category":"exact","subcategory":"exact","condition":"Used – Good","description":"3-4 sentences","partNumber":"OEM or empty","listPrice":number,"weight":number,"notes":""}\nweight is the estimated packed shipping weight in GRAMS (whole number, e.g. 1500 for 1.5kg). Never return kilograms or a value below 50.`
    const aiRes = await callAnthropic({
      model: 'claude-sonnet-4-6', max_tokens: 800, system: sys,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
        { type: 'text', text: `Vehicle: ${car?.make || ''} ${car?.model || ''} ${car?.year || ''}. Identify this car part.` },
      ] }],
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
