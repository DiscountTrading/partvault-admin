import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const PROXY                   = 'https://partvault-proxy.leap00.workers.dev'
// eBay developer keyset — a single application identity shared by every store.
// These are platform-level config, NOT per-store data. Set them as edge-function
// secrets (Supabase dashboard → Edge Functions → Secrets). Fallbacks keep the
// existing app working if the secrets are not yet set; CERT_ID has no fallback
// because it is a client secret and must never be hard-coded.
const APP_ID                  = Deno.env.get('EBAY_APP_ID')  || 'Discount-PartVaul-PRD-36c135696-64f7f7bf'
const CERT_ID                 = Deno.env.get('EBAY_CERT_ID') || ''
const RUNAME                  = Deno.env.get('EBAY_RUNAME')  || 'Discount_Tradin-Discount-PartVa-jhtznvhgx'
const EDGE_FN_VERSION         = '3.14.45'
const CHUNK_SIZE              = 20
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000
const FUNCTION_TIMEOUT_MS     = 45 * 1000 // safety net; the chunk soft-limits at ~18s
const EBAY_TOKEN_URL          = 'https://api.ebay.com/identity/v1/oauth2/token'
const EBAY_SCOPES = 'https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.inventory.readonly https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly https://api.ebay.com/oauth/api_scope/sell.finances https://api.ebay.com/oauth/api_scope/sell.account.readonly'

const CATEGORY_ID_MAP: Record<string, string> = {
  '33549':'Air & Fuel Delivery','33542':'Air Conditioning & Heating',
  '33559':'Brakes & Brake Parts','33612':'Engines & Engine Parts',
  '33599':'Engine Cooling','33605':'Exhaust & Emission',
  '33637':'Exterior Parts','33687':'Ignition Systems',
  '33694':'Interior Parts','33707':'Lighting & Bulbs',
  '33572':'Starters, Alternators & Wiring','33579':'Steering & Suspension',
  '33726':'Transmission & Drivetrain','33743':'Wheels, Tyres & Parts',
  '180143':'Towing Parts','9886':'Other Car & Truck Parts',
  // Subcategories mapped to parent
  '50459':'Interior Parts','33705':'Interior Parts','33716':'Lighting & Bulbs',
  '33596':'Transmission & Drivetrain','262161':'Exterior Parts',
  '9887':'Other Car & Truck Parts','33712':'Lighting & Bulbs',
  '33648':'Exterior Parts','46102':'Interior Parts','61941':'Exterior Parts',
  '33706':'Interior Parts','33700':'Interior Parts','33545':'Interior Parts',
  '262085':'Brakes & Brake Parts','33557':'Air & Fuel Delivery',
  '33709':'Lighting & Bulbs','33566':'Brakes & Brake Parts',
  '262188':'Interior Parts','262221':'Starters, Alternators & Wiring',
  '33675':'Interior Parts','33558':'Air & Fuel Delivery',
  '262200':'Interior Parts','61304':'Engines & Engine Parts',
  '262183':'Ignition Systems','33546':'Air Conditioning & Heating',
  '173950':'Air & Fuel Delivery','183718':'Other Car & Truck Parts',
  '33704':'Interior Parts','39754':'Interior Parts',
}

// Build the eBay item specifics + confident fitment for a part, using the
// Taxonomy aspect list for its leaf category. Three passes: derive from our
// structured data, AI-fill the rest from the part photos, neutral fallback for
// required leftovers. Shared by publish_listings and preview_listing so the
// preview shows exactly what will be sent.
async function fillAspects(
  part: any,
  categoryId: string,
  categoryTreeId: string,
  ebayHeaders: Record<string, string>,
  aiPhotos: string[],
): Promise<{ aspects: Record<string, string[]>; fitmentList: any[]; specs: any[] }> {
  const aspects: Record<string, string[]> = {}
  let fitmentList: any[] = []
  let specsOut: any[] = [] // full list of every aspect eBay offers for this category
  const titleLc = (part.title || '').toLowerCase()
  const placement = () => {
    const out: string[] = []
    if (/\bfront\b/.test(titleLc)) out.push('Front')
    if (/\b(rear|back)\b/.test(titleLc)) out.push('Rear')
    if (/\b(left|lh|l\/h|driver)\b/.test(titleLc)) out.push('Left')
    if (/\b(right|rh|r\/h|passenger)\b/.test(titleLc)) out.push('Right')
    return out.length ? out.join(', ') : null
  }
  const derive = (name: string): string | null => {
    const n = name.toLowerCase()
    if (/\b(brand|manufacturer)\b/.test(n) && !/part/.test(n)) return part.make || null
    if (/make/.test(n)) return part.make || null
    if (/model/.test(n)) return part.model || null
    if (/year/.test(n)) return part.year ? String(part.year) : null
    if (/(part\s*number|^mpn$|oe[\/\s]?oem|reference|interchange|supersed)/.test(n)) return part.part_number || null
    if (/placement/.test(n)) return placement()
    // NB: do NOT derive "Type" from our internal category — eBay's Type aspect
    // means the product type (e.g. "Headlight Bulb"), not our taxonomy. Let the
    // AI fill it from the photo instead.
    return null
  }
  try {
    const aRes = await fetch(`https://api.ebay.com/commerce/taxonomy/v1/category_tree/${categoryTreeId}/get_item_aspects_for_category?category_id=${categoryId}`, { headers: ebayHeaders })
    if (aRes.ok) {
      const aData = await aRes.json()
      const NEUTRAL = ['unbranded', 'does not apply', 'unknown', 'not specified', 'unspecified', 'other', 'na', 'n/a']
      const specs = (aData.aspects || []).map((a: any) => ({
        name: a.localizedAspectName as string,
        required: !!a.aspectConstraint?.aspectRequired,
        selectionOnly: a.aspectConstraint?.aspectMode === 'SELECTION_ONLY',
        allowed: (a.aspectValues || []).map((v: any) => v.localizedValue).filter(Boolean) as string[],
      }))
      specsOut = specs
      const inAllowedOf = (allowed: string[], val: string) => allowed.find((v) => v.toLowerCase() === String(val).toLowerCase())

      // Pass 1 — fill from our own structured part/car data.
      for (const s of specs) {
        if (aspects[s.name]) continue
        const d = derive(s.name)
        if (!d) continue
        if (!s.selectionOnly || !s.allowed.length) aspects[s.name] = [d]
        else { const m = inAllowedOf(s.allowed, d); if (m) aspects[s.name] = [m] }
      }

      // Pass 2 — AI fills the remaining specifics + confident fitment from the photos.
      const todo = specs.filter((s: any) => !aspects[s.name]).slice(0, 30)
      const ANTHROPIC = Deno.env.get('ANTHROPIC_API_KEY')
      if (ANTHROPIC && aiPhotos.length && todo.length) {
        try {
          const aspList = todo.map((s: any) => s.selectionOnly && s.allowed.length
            ? `- ${s.name} (choose exactly one, verbatim: ${s.allowed.slice(0, 40).join(' | ')})`
            : `- ${s.name} (free text, max 60 chars)`).join('\n')
          const sys = `You are an expert Australian auto-parts eBay lister. Identify the part from the PHOTOS first — the provided Category is only a hint and may be wrong; trust the photos if they disagree. From the part photos and the known donor vehicle, do TWO things and return JSON only:\n{"aspects": {<aspectName>: <value>}, "fitment": [{"make":"","model":"","yearFrom":2012,"yearTo":2017,"trim":"","engine":""}]}\ntrim and engine are optional — include them only when the part is specific to that trim/engine; leave "" otherwise.\nASPECTS: fill in as MANY of the listed aspects as you reasonably can — do not leave fields blank when a sensible value is determinable. Use the photos, the identified part type, the donor vehicle, and standard knowledge of this kind of used auto part. Infer reasonable values for things like Type, Placement, Brand (the OEM make, or "Unbranded" for generic), Colour, Material, Surface Finish, Country/Region of Manufacture, and — for a clearly identified part — typical specs (e.g. the Voltage/Wattage/base size of a known bulb, the standard size of a known component). For "choose one" aspects return ONE listed option verbatim (pick the closest match), otherwise omit. Read any dimension, size, wattage, voltage, bulb base or part number that is PRINTED or visible in the photos and fill the matching aspect (Item Diameter, Item Length, Bulb Size, Voltage, Wattage, etc.). Do NOT fabricate a precise measurement, exact part number, or warranty term you cannot see or safely infer. Leave an aspect blank ONLY when you genuinely cannot determine a sensible value.\nFITMENT — list the vehicles this part actually fits (confidence is about whether it genuinely fits, NOT about how few you list):\n• VEHICLE-SPECIFIC parts (body panels, light assemblies, looms, ECUs, trim, mirrors): list only vehicles you are confident share the IDENTICAL part (same OEM/interchange number) — the donor vehicle plus platform-shared siblings you are sure about. Omit uncertain ones.\n• STANDARDISED / UNIVERSAL parts (a globe/bulb of a standard base such as H1/H4/H7/H11/HB3/9005, a fuse, a wiper blade of a given size, a standard spin-on oil filter, a common belt): these genuinely fit MANY vehicles. First identify the exact specification, then list the common Australian-market vehicles that use that spec — up to 20 popular models with realistic year ranges. This is accurate, not guessing, so do NOT restrict it to just the donor car.\nNever list a vehicle that does not actually take this part. Return an empty array only if you truly cannot tell.`
          const usr = `Part: ${part.title || ''}\nVehicle: ${part.make || ''} ${part.model || ''} ${part.year || ''}\nCategory: ${part.category || ''}\nPart number: ${part.part_number || 'unknown'}\n${aiPhotos.length > 1 ? `\nThe ${aiPhotos.length} photos are all of the SAME part from different angles/close-ups — use them together.` : ''}\nAspects to fill:\n${aspList}`
          const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'x-api-key': ANTHROPIC, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
            body: JSON.stringify({
              model: 'claude-sonnet-4-6', max_tokens: 1400, system: sys,
              messages: [{ role: 'user', content: [
                ...aiPhotos.map((u: string) => ({ type: 'image', source: { type: 'url', url: u } })),
                { type: 'text', text: usr },
              ] }],
            }),
          })
          if (aiRes.ok) {
            const aiData = await aiRes.json()
            const raw = (aiData.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim()
            let map: any = null
            try { map = JSON.parse(raw) } catch { const mm = raw.match(/\{[\s\S]*\}/); if (mm) map = JSON.parse(mm[0]) }
            const aspMap = map?.aspects || map || {}
            for (const s of todo) {
              const v = aspMap[s.name]
              if (!v || typeof v !== 'string') continue
              if (s.selectionOnly && s.allowed.length) { const m = inAllowedOf(s.allowed, v); if (m) aspects[s.name] = [m] }
              else aspects[s.name] = [v.slice(0, 65)]
            }
            if (Array.isArray(map?.fitment)) fitmentList = map.fitment.slice(0, 50)
          }
        } catch (_) { /* AI is best-effort */ }
      }

      // Always include the donor vehicle in the fitment (the AI adds extra models
      // on top). Never let the donor car be dropped.
      if (part.make && part.model) {
        const dl = (s: any) => String(s || '').toLowerCase()
        const hasDonor = fitmentList.some((f: any) => dl(f.make) === dl(part.make) && dl(f.model) === dl(part.model))
        if (!hasDonor) {
          const ys = String(part.year || '').match(/\d{4}/g) || []
          fitmentList.unshift({ make: part.make, model: part.model, yearFrom: ys[0] ? +ys[0] : undefined, yearTo: ys[1] ? +ys[1] : (ys[0] ? +ys[0] : undefined), trim: '', engine: '' })
        }
      }

      // Compatible-vehicle item specifics (multi-value) from the fitment.
      if (fitmentList.length) {
        const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))]
        const makes = uniq(fitmentList.map((f: any) => f.make))
        const models = uniq(fitmentList.map((f: any) => f.model))
        const years = uniq(fitmentList.flatMap((f: any) => {
          const out: string[] = []; const yf = +f.yearFrom, yt = +f.yearTo || yf
          if (yf) for (let y = yf; y <= yt && y - yf < 40; y++) out.push(String(y))
          return out
        }))
        for (const s of specs) {
          const nlc = s.name.toLowerCase()
          if (!/compat/.test(nlc)) continue
          let vals = /make/.test(nlc) ? makes : /model/.test(nlc) ? models : /year/.test(nlc) ? years : []
          if (s.allowed.length) vals = vals.map((v) => inAllowedOf(s.allowed, v)).filter(Boolean) as string[]
          if (vals.length) aspects[s.name] = uniq([...(aspects[s.name] || []), ...vals]).slice(0, 30)
        }
      }

      // Pass 3 — required-but-empty → sensible/neutral value.
      for (const s of specs) {
        if (aspects[s.name] || !s.required) continue
        const nlc = s.name.toLowerCase()
        if (/\b(brand|manufacturer)\b/.test(nlc) && !/part/.test(nlc))
          aspects[s.name] = [s.allowed.length ? (inAllowedOf(s.allowed, 'Unbranded') || s.allowed[0]) : (part.make || 'Unbranded')]
        else if (/part\s*number|mpn/i.test(nlc)) aspects[s.name] = [part.part_number || 'Does Not Apply']
        else if (s.allowed.length) aspects[s.name] = [s.allowed.find((v: string) => NEUTRAL.includes(v.toLowerCase())) || s.allowed[0]]
        else aspects[s.name] = ['Unbranded']
      }
    }
  } catch (_) { /* best effort */ }
  // Manual overrides win over the AI — the user's corrections in the listing
  // preview (and, later, the mapping page) are authoritative.
  const ov = part.ebay_overrides || {}
  if (ov.specifics && typeof ov.specifics === 'object') {
    for (const [k, v] of Object.entries(ov.specifics)) {
      if (v == null || v === '') delete aspects[k]
      else aspects[k] = [String(v)]
    }
  }
  if (Array.isArray(ov.fitment)) fitmentList = ov.fitment
  return { aspects, fitmentList, specs: specsOut }
}

// Build the full listing description (body + "Compatible with" block + footer)
// exactly as it will be sent to eBay. Shared by publish + preview so the preview
// is a faithful image of the real listing.
function buildDescription(part: any, _fitmentList: any[], footer: string): string {
  // Just the product description + the store footer. Vehicle fitment is NOT
  // repeated here — it lives in the item specifics and the Parts Compatibility
  // list (which is what eBay search actually uses), so duplicating it in the
  // description adds no search value and clutters the listing.
  const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const descBody = part.description || part.notes || part.title || ''
  return [descBody, footer].filter(Boolean).map((s: string) => esc(s).replace(/\n/g, '<br>')).join('<br><br>') || (part.title || part.sku || '')
}

// Resolve the package weight (grams) + dimensions (cm) exactly as publish does:
// part weight > category preset > store default, guarded against zero/sub-gram.
function resolveShipping(part: any, shipCats: any, shipDefW: number, shipDefDims: any) {
  const preset = shipCats[part.category] || {}
  const presetOrDefaultG = +preset.weightG > 0 ? +preset.weightG : shipDefW
  let weightG = Math.round(+part.weight > 0 ? +part.weight : presetOrDefaultG)
  if (!Number.isFinite(weightG) || weightG < 2) weightG = Math.round(presetOrDefaultG)
  const dimL = +preset.l > 0 ? +preset.l : (+shipDefDims.l > 0 ? +shipDefDims.l : 30)
  const dimW = +preset.w > 0 ? +preset.w : (+shipDefDims.w > 0 ? +shipDefDims.w : 20)
  const dimH = +preset.h > 0 ? +preset.h : (+shipDefDims.h > 0 ? +shipDefDims.h : 15)
  return { weightG, dimL, dimW, dimH }
}

// Application access token (client-credentials) for the Buy/Commerce data APIs
// (Browse, Catalog) — no user consent needed; cached in-isolate until expiry.
let _appToken = { token: '', exp: 0 }
async function getAppToken(): Promise<string> {
  if (_appToken.token && _appToken.exp - Date.now() > 60000) return _appToken.token
  const res = await fetch(EBAY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${btoa(`${APP_ID}:${CERT_ID}`)}` },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope' }),
  })
  const d = await res.json()
  if (!d.access_token) throw new Error(`eBay app token failed: ${d.error_description || 'unknown'}`)
  _appToken = { token: d.access_token, exp: Date.now() + (d.expires_in || 7200) * 1000 }
  return d.access_token
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  console.log(`[${EDGE_FN_VERSION}] ${req.method} request received`)
  try {
    return await handleRequest(req)
  } catch (e: any) {
    console.error('Unhandled error:', e.message)
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})

async function handleRequest(req: Request): Promise<Response> {
  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const body = await req.json()
  const { action, storeId, jobId } = body

  // ── XML HELPERS ─────────────────────────────────────────────────────────────

  const getTag = (xml: string, tag: string): string =>
    xml.match(new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 's'))?.[1]?.trim() ?? ''

  const getTotalPages = (xml: string): number =>
    parseInt(xml.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/)?.[1] ?? '1')

  const getItemIds = (xml: string): string[] =>
    [...xml.matchAll(/<ItemID>(\d+)<\/ItemID>/g)].map(m => m[1])

  const parseEbayWeight = (xml: string): number | null => {
    const majorMatch = xml.match(/<WeightMajor[^>]*\bunit="([^"]*)"[^>]*>([^<]*)<\/WeightMajor>/i)
      ?? xml.match(/<WeightMajor[^>]*>([^<]*)<\/WeightMajor>/i)
    const minorMatch = xml.match(/<WeightMinor[^>]*\bunit="([^"]*)"[^>]*>([^<]*)<\/WeightMinor>/i)
      ?? xml.match(/<WeightMinor[^>]*>([^<]*)<\/WeightMinor>/i)

    const majorUnit = majorMatch?.length === 3 ? majorMatch[1].toLowerCase() : ''
    const majorVal  = parseFloat(majorMatch?.length === 3 ? majorMatch[2] : (majorMatch?.[1] ?? '')) || 0
    const minorUnit = minorMatch?.length === 3 ? minorMatch[1].toLowerCase() : ''
    const minorVal  = parseFloat(minorMatch?.length === 3 ? minorMatch[2] : (minorMatch?.[1] ?? '')) || 0

    if (majorVal === 0 && minorVal === 0) return null

    const toGrams = (v: number, u: string): number => {
      switch (u) {
        case 'lbs': return v * 453.592
        case 'oz':  return v * 28.3495
        case 'kg':  return v * 1000
        case 'gm': case 'g': return v
        default: console.warn(`Unknown weight unit: "${u}"`); return 0
      }
    }

    const grams = Math.round(toGrams(majorVal, majorUnit) + toGrams(minorVal, minorUnit))
    return grams < 2 ? null : grams
  }

  const parseEbayStartDate = (xml: string): string | null =>
    getTag(xml, 'StartTime').match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null

  const extractItemSpecifics = (xml: string): Record<string, string> => {
    const result: Record<string, string> = {}
    for (const m of xml.matchAll(/<NameValueList>(.*?)<\/NameValueList>/gs)) {
      const name = getTag(m[1], 'Name')
      const value = getTag(m[1], 'Value')
      if (name) result[name] = value
    }
    return result
  }

  const parseTransactions = (xml: string): Array<{ itemId: string; title: string; salePrice: number; shipping: number; soldAt: string | null }> => {
    const results: Array<{ itemId: string; title: string; salePrice: number; shipping: number; soldAt: string | null }> = []
    for (const txMatch of xml.matchAll(/<Transaction>([\s\S]*?)<\/Transaction>/g)) {
      const txXml = txMatch[1]
      const itemSection = txXml.match(/<Item>([\s\S]*?)<\/Item>/)?.[1] ?? ''
      const itemId = getTag(itemSection, 'ItemID')
      if (!itemId) continue
      const title     = getTag(itemSection, 'Title')
      const salePrice = parseFloat(getTag(txXml, 'TransactionPrice')) || 0
      // Shipping the buyer paid: prefer the explicit shipping cost, else infer
      // from total paid minus item price.
      const explicitShip = parseFloat(getTag(txXml, 'ShippingServiceCost'))
      const amountPaid   = parseFloat(getTag(txXml, 'AmountPaid'))
      const shipping = !isNaN(explicitShip) ? explicitShip : (!isNaN(amountPaid) ? Math.max(0, amountPaid - salePrice) : 0)
      const soldAt    = getTag(txXml, 'PaidTime') || getTag(txXml, 'CreatedDate') || null
      results.push({ itemId, title, salePrice, shipping, soldAt })
    }
    return results
  }

  const fetchItemDetails = async (itemIds: string[]): Promise<Record<string, any>> => {
    const url = `https://open.api.ebay.com/shopping?callname=GetMultipleItems&responseencoding=JSON&appid=${APP_ID}&ItemID=${itemIds.join(',')}&IncludeSelector=Details,ItemSpecifics&version=967&siteid=15`
    try {
      const res = await fetch(url)
      if (!res.ok) return {}
      const data = await res.json()
      const map: Record<string, any> = {}
      for (const item of (data?.Item || [])) {
        if (item?.ItemID) map[item.ItemID] = item
      }
      return map
    } catch { return {} }
  }

  // ── eBay TRADING API ────────────────────────────────────────────────────────

  const trading = async (token: string, certId: string, callName: string, xmlBody: string): Promise<string> => {
    const res = await fetch(`${PROXY}/ebay/trading`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml',
        'Authorization': `Bearer ${token}`,
        'X-EBAY-API-CALL-NAME': callName,
        'X-EBAY-API-APP-NAME': APP_ID,
        'X-EBAY-API-CERT-NAME': certId,
        'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
        'X-EBAY-API-SITEID': '15',
      },
      body: xmlBody,
    })
    return res.text()
  }

  // ── TOKEN MANAGEMENT ────────────────────────────────────────────────────────

  const getToken = async (): Promise<{ token: string; certId: string }> => {
    const { data: rows, error } = await sb.rpc('get_ebay_tokens', { p_store_id: storeId })
    if (error || !rows?.length) throw new Error('eBay token not found — please reconnect in Settings')
    const t = rows[0]
    if (!t.access_token) throw new Error('No eBay access token — please reconnect in Settings')

    const expiresAt = t.expires_at ? new Date(t.expires_at).getTime() : 0
    if (expiresAt && expiresAt - Date.now() >= TOKEN_REFRESH_BUFFER_MS) {
      return { token: t.access_token, certId: CERT_ID }
    }

    if (!t.refresh_token) throw new Error('Access token expired — please reconnect in Settings')

    console.log(`Refreshing token (expires ${t.expires_at})...`)
    const credentials = btoa(`${APP_ID}:${CERT_ID}`)
    const refreshRes = await fetch(EBAY_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: t.refresh_token,
        scope:         EBAY_SCOPES,
      }),
    })
    const refreshData = await refreshRes.json()
    if (!refreshData.access_token) {
      throw new Error(`Token refresh failed: ${refreshData.error_description || 'unknown'} — please reconnect in Settings`)
    }

    const newExpiresAt = new Date(Date.now() + refreshData.expires_in * 1000).toISOString()
    const { error: updateErr } = await sb.rpc('update_ebay_access_token', {
      p_store_id:     storeId,
      p_access_token: refreshData.access_token,
      p_expires_at:   newExpiresAt,
      p_expires_in:   refreshData.expires_in,
    })
    if (updateErr) console.error('Failed to persist refreshed token:', updateErr.message)
    else console.log(`Token refreshed, new expiry: ${newExpiresAt}`)

    return { token: refreshData.access_token, certId: CERT_ID }
  }

  const fetchAllIds = async (token: string, certId: string, listType: string): Promise<string[]> => {
    // eBay caps SoldList DurationInDays at 60; older sales come via backfill_orders
    // (GetSellerTransactions with ModifiedTimeFilter), not this listing query.
    const durationParam = listType === 'SoldList' ? '<DurationInDays>59</DurationInDays>' : ''
    const xml1 = await trading(token, certId, 'GetMyeBaySelling', `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <${listType}><Include>true</Include>${durationParam}<Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>1</PageNumber></Pagination></${listType}>
</GetMyeBaySellingRequest>`)
    if (getTag(xml1, 'Ack') === 'Failure') throw new Error(getTag(xml1, 'LongMessage') || 'eBay API error')

    const totalPages = getTotalPages(xml1)
    const ids: string[] = getItemIds(xml1)
    for (let p = 2; p <= Math.min(totalPages, 50); p++) {
      const xml = await trading(token, certId, 'GetMyeBaySelling', `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <${listType}><Include>true</Include>${durationParam}<Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${p}</PageNumber></Pagination></${listType}>
</GetMyeBaySellingRequest>`)
      getItemIds(xml).forEach(id => ids.push(id))
    }
    return [...new Set(ids)]
  }

  // ── ROW BUILDERS ────────────────────────────────────────────────────────────

  const buildPartRow = (xml: string, sku: string) => {
    const listingStatus = getTag(xml, 'ListingStatus')
    const sellingState  = getTag(xml, 'SellingState')
    const priceStr      = getTag(xml, 'ConvertedCurrentPrice') || getTag(xml, 'BuyItNowPrice') || getTag(xml, 'CurrentPrice')
    const descRaw       = getTag(xml, 'Description')
    const weight        = parseEbayWeight(xml)

    let status    = 'in_stock'
    let soldPrice = null
    let soldDate  = null
    if (sellingState === 'EndedWithSales' || sellingState === 'Sold') {
      status    = 'sold'
      soldPrice = parseFloat(getTag(xml, 'ConvertedCurrentPrice') || getTag(xml, 'CurrentPrice')) || null
      soldDate  = getTag(xml, 'PaidTime') || null
    } else if (listingStatus === 'Active') {
      status = 'listed'
    }

    return {
      store_id:      storeId,
      sku,
      title:         getTag(xml, 'Title'),
      status,
      condition:     getTag(xml, 'ConditionDisplayName') || 'Used',
      description:   descRaw.replace(/<[^>]*>/g, '').trim().substring(0, 2000),
      list_price:    parseFloat(priceStr) || 0,
      sold_price:    soldPrice,
      sold_date:     soldDate,
      weight,
      weight_source: weight !== null ? 'ebay' : null,
      part_number:   extractItemSpecifics(xml)['Manufacturer Part Number'] ?? null,
      source:        'ebay_import',
      acquired_date: parseEbayStartDate(xml),
      costs:         { acquisition:0, labour:0, storage:0, packaging:0, postage:0, holding:0 },
      ai_assessed:   false,
    }
  }

  const buildListingRow = (xml: string, partId: string) => {
    const itemId        = getTag(xml, 'ItemID')
    const ebaySkuRaw    = getTag(xml, 'SKU')
    const listingStatus = getTag(xml, 'ListingStatus')
    const sellingState  = getTag(xml, 'SellingState')
    const priceStr      = getTag(xml, 'ConvertedCurrentPrice') || getTag(xml, 'BuyItNowPrice') || getTag(xml, 'CurrentPrice')
    const startTime     = getTag(xml, 'StartTime')
    const endTime       = getTag(xml, 'EndTime')

    // Active listings use status 'live' here (matches the existing rows and the
    // listings_status_check constraint — 'active' is NOT an allowed value).
    let status    = 'live'
    let soldPrice = null
    let soldAt    = null
    if (sellingState === 'EndedWithSales' || sellingState === 'Sold') {
      status    = 'sold'
      soldPrice = parseFloat(getTag(xml, 'ConvertedCurrentPrice') || getTag(xml, 'CurrentPrice')) || null
      soldAt    = getTag(xml, 'PaidTime') || null
    } else if (listingStatus !== 'Active') {
      status = 'ended'
    }

    const photos = [...xml.matchAll(/<PictureURL>(.*?)<\/PictureURL>/g)]
      .map(m => m[1])
      .slice(0, 12)
      .map(url => ({ ebay_url: url }))

    const platform_data = {
      ItemID:                itemId,
      Title:                 getTag(xml, 'Title'),
      SKU:                   ebaySkuRaw,
      ListingStatus:         listingStatus,
      SellingState:          sellingState,
      ConditionDisplayName:  getTag(xml, 'ConditionDisplayName'),
      CategoryID:            getTag(xml, 'CategoryID'),
      ConvertedCurrentPrice: getTag(xml, 'ConvertedCurrentPrice'),
      BuyItNowPrice:         getTag(xml, 'BuyItNowPrice'),
      StartTime:             startTime,
      EndTime:               endTime,
      ItemSpecifics:         extractItemSpecifics(xml),
    }

    return {
      part_id:             partId,
      store_id:            storeId,
      platform:            'ebay',
      platform_listing_id: itemId,
      platform_sku:        ebaySkuRaw || null,
      status,
      list_price:          parseFloat(priceStr) || 0,
      sold_price:          soldPrice,
      listed_at:           startTime || null,
      ended_at:            endTime || null,
      sold_at:             soldAt,
      platform_data,
      photos,
      photos_archived:     false,
    }
  }

  // ── PHOTOS TABLE DUAL-WRITE ─────────────────────────────────────────────────
  // Mirrors eBay listing photos into the normalised `photos` table, keyed to the
  // part. Delete-then-insert keeps it idempotent: re-imports refresh, never duplicate.
  // Only touches source='ebay_import' rows, so manually uploaded photos are never removed.
  const syncPhotosForPart = async (xml: string, partId: string) => {
    const urls = [...xml.matchAll(/<PictureURL>(.*?)<\/PictureURL>/g)]
      .map(m => m[1])
      .slice(0, 12)
    await sb.from('photos').delete()
      .eq('parent_type', 'part')
      .eq('parent_id', partId)
      .eq('source', 'ebay_import')
    if (urls.length) {
      const { error } = await sb.from('photos').insert(
        urls.map((url, i) => ({
          parent_type: 'part', parent_id: partId, ebay_url: url,
          display_order: i, is_primary: i === 0, source: 'ebay_import',
        }))
      )
      if (error) console.warn('photos table sync failed', partId, error.message)
    }
  }

  // ── RESPONSE HELPER ─────────────────────────────────────────────────────────

  const json = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })

  // One summary row per eBay sync into the existing audit_log (table_name 'sync',
  // action 'SYNC'). Shows in the Activity view as a single readable line instead
  // of the hundreds of per-row part/listing changes the triggers already record.
  // Best-effort: a logging failure must never fail the sync itself.
  const logSyncEvent = async (sid: string, summary: string, data: Record<string, unknown> = {}) => {
    try {
      await sb.from('audit_log').insert({
        id:         crypto.randomUUID(),
        store_id:   sid,
        table_name: 'sync',
        record_id:  crypto.randomUUID(),
        action:     'SYNC',
        old_data:   null,
        new_data:   { summary, ...data },
        changed_by: null, // unattended → shows as 'system' in the Activity view
        changed_at: new Date().toISOString(),
      })
    } catch (_) { /* logging is best-effort */ }
  }

  // ── ACTIONS ─────────────────────────────────────────────────────────────────

  try {

    if (action === 'status') {
      const { data: job } = await sb.from('jobs').select('*').eq('id', jobId).single()
      return json(job ?? { error: 'Job not found' })
    }

    if (action === 'cancel') {
      await sb.from('jobs')
        .update({ status: 'cancelled', completed_at: new Date().toISOString() })
        .eq('id', jobId)
      return json({ ok: true })
    }

    if (action === 'exchange_oauth_code') {
      const { code } = body
      if (!code) throw new Error('Missing authorisation code')

      // Keyset comes from edge-function secrets (platform-level), not per-store data.
      if (!CERT_ID) return json({ error: 'Server eBay credentials not configured (EBAY_CERT_ID secret is missing).' }, 500)

      const credentials = btoa(`${APP_ID}:${CERT_ID}`)
      const tokenRes = await fetch(EBAY_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${credentials}`,
        },
        body: new URLSearchParams({
          grant_type:   'authorization_code',
          code,
          redirect_uri: RUNAME,
        }),
      })

      const tokens = await tokenRes.json()
      if (!tokens.access_token) {
        throw new Error(tokens.error_description || tokens.error || 'eBay token exchange failed')
      }

      const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      // Create-or-update the store's ebay_tokens row and persist BOTH tokens.
      // (The row no longer pre-exists from a cert-save step, and the refresh
      //  token must be stored so future silent refreshes work.)
      const { error: updateErr } = await sb.rpc('store_ebay_oauth_tokens', {
        p_store_id:      storeId,
        p_access_token:  tokens.access_token,
        p_refresh_token: tokens.refresh_token,
        p_expires_at:    expiresAt,
        p_expires_in:    tokens.expires_in,
      })
      if (updateErr) throw new Error(`Failed to store token: ${updateErr.message}`)

      console.log(`[exchange_oauth_code] Token stored, expires ${expiresAt}`)
      return json({ success: true, expires_at: expiresAt })
    }

    if (action === 'start') {
      const { token, certId } = await getToken()

      const activeIds = await fetchAllIds(token, certId, 'ActiveList')
      const soldIds   = await fetchAllIds(token, certId, 'SoldList')
      const allIds    = [...new Set([...activeIds, ...soldIds])]

      const { data: job, error: jobErr } = await sb.from('jobs').insert({
        store_id:     storeId,
        type:         'ebay_import',
        status:       'running',
        total_items:  allIds.length,
        current_item: 'Ready to process...',
        started_at:   new Date().toISOString(),
        meta: { all_item_ids: allIds, batch_offset: 0, failed_reasons: {} },
      }).select().single()

      if (jobErr) throw new Error(`Failed to create job: ${jobErr.message}`)
      return json({ jobId: job.id, totalIds: allIds.length, needsProcessing: true })
    }

    if (action === 'process_chunk') {
      const processChunk = async (): Promise<Response> => {
        const { data: job, error: jobErr } = await sb.from('jobs').select('*').eq('id', jobId).single()
        if (jobErr || !job) throw new Error('Job not found')
        if (job.status === 'cancelled') return json({ status: 'cancelled' })

        const { token, certId } = await getToken()

        const allIds: string[]                      = job.meta?.all_item_ids  ?? []
        const offset: number                        = job.meta?.batch_offset  ?? 0
        const failedReasons: Record<string, string> = job.meta?.failed_reasons ?? {}
        // Time-box the work instead of a fixed count: process items until ~18s
        // have elapsed (or a hard cap), then persist progress and return. This
        // guarantees forward progress and removes the timeout/retry deadlock that
        // froze the bar on chunks full of slow new-item + photo imports.
        const SOFT_LIMIT_MS = 18 * 1000
        const HARD_CAP      = 60 // never look further ahead than this per call
        const chunk = allIds.slice(offset, offset + HARD_CAP)

        if (chunk.length === 0) {
          const summary = job.result_summary ?? {}
          await sb.from('jobs').update({
            status:       'completed',
            completed_at: new Date().toISOString(),
            current_item: `✓ Complete — ${summary.imported ?? 0} imported, ${summary.skipped ?? 0} skipped, ${job.failed_items ?? 0} failed`,
          }).eq('id', jobId)
          return json({ status: 'completed', job })
        }

        let imported  = job.result_summary?.imported ?? 0
        let skipped   = job.result_summary?.skipped  ?? 0
        let failed    = job.failed_items    ?? 0
        let processed = job.processed_items ?? 0

        const { data: existingInChunk } = await sb.from('listings')
          .select('platform_listing_id')
          .eq('store_id', storeId)
          .eq('platform', 'ebay')
          .in('platform_listing_id', chunk)
        const existingSet = new Set((existingInChunk ?? []).map((l: any) => l.platform_listing_id))

        const startedAt = Date.now()
        let doneThisCall = 0 // how many ids we actually advanced past this call
        for (const itemId of chunk) {
          // Stop once the time budget is spent — but always do at least one item
          // so we can't stall (a single slow item still advances the offset).
          if (doneThisCall > 0 && Date.now() - startedAt > SOFT_LIMIT_MS) break
          doneThisCall++
          if (existingSet.has(itemId)) { skipped++; processed++; continue }
          try {
            const xml = await trading(token, certId, 'GetItem', `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${itemId}</ItemID><DetailLevel>ReturnAll</DetailLevel>
</GetItemRequest>`)

            if (!xml.includes('<Ack>Success</Ack>') && !xml.includes('<Ack>Warning</Ack>')) {
              throw new Error(getTag(xml, 'LongMessage') || 'eBay API error')
            }

            const ebaySkuRaw = getTag(xml, 'SKU')
            let partId: string

            // Each live eBay listing is its own inventory part. Reuse a part when
            // its SKU matches AND it has no *other* live listing (a relist — old
            // listing ended, new item id) — but if the matched part already has a
            // different live listing, this is a concurrent duplicate, so it gets
            // its own part under a fresh internal SKU (eBay's SKU stays on the
            // listing's platform_sku). Keeps inventory count = eBay live count.
            const makePart = async (sku: string) => {
              const { data: np, error: pErr } = await sb.from('parts').insert(buildPartRow(xml, sku)).select('id').single()
              if (pErr) throw pErr
              return np.id as string
            }
            const freshSku = async () => {
              const { data: g, error: e } = await sb.rpc('generate_next_sku', { p_store_id: storeId })
              if (e || !g) throw new Error(`SKU generation failed: ${e?.message}`)
              return g as string
            }

            if (ebaySkuRaw) {
              const { data: existingPart } = await sb.from('parts')
                .select('id').eq('store_id', storeId).eq('sku', ebaySkuRaw).maybeSingle()
              if (existingPart) {
                const { data: liveOther } = await sb.from('listings')
                  .select('id').eq('store_id', storeId).eq('platform', 'ebay').eq('part_id', existingPart.id)
                  .in('status', ['active', 'live']).neq('platform_listing_id', itemId).is('deleted_at', null)
                  .limit(1).maybeSingle()
                // Concurrent duplicate → new part (fresh SKU); else reuse (relist).
                partId = liveOther ? await makePart(await freshSku()) : existingPart.id
              } else {
                partId = await makePart(ebaySkuRaw)
              }
            } else {
              partId = await makePart(await freshSku())
            }

            const { error: listingErr } = await sb.from('listings').insert(buildListingRow(xml, partId))
            if (listingErr) throw listingErr
            await syncPhotosForPart(xml, partId)

            imported++; processed++

          } catch (e: any) {
            failed++; processed++
            failedReasons[itemId] = e.message
          }
        }

        const newOffset  = offset + doneThisCall
        const isComplete = newOffset >= allIds.length

        await sb.from('jobs').update({
          processed_items: processed,
          failed_items:    failed,
          current_item: isComplete
            ? `✓ Complete — ${imported} imported, ${skipped} skipped`
            : `Processing ${Math.min(newOffset, allIds.length)} of ${allIds.length}...`,
          status:         isComplete ? 'completed' : 'running',
          completed_at:   isComplete ? new Date().toISOString() : null,
          result_summary: { imported, skipped },
          meta:           { all_item_ids: allIds, batch_offset: newOffset, failed_reasons: failedReasons },
        }).eq('id', jobId)

        return json({
          status: isComplete ? 'completed' : 'running',
          imported, skipped, failed,
          offset: newOffset, total: allIds.length, isComplete,
        })
      }

      let timeoutId: ReturnType<typeof setTimeout> | undefined
      const timeoutPromise = new Promise<Response>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve(json({ error: 'timeout', retry: true }, 408))
        }, FUNCTION_TIMEOUT_MS)
      })
      try {
        const response = await Promise.race([processChunk(), timeoutPromise])
        if (timeoutId) clearTimeout(timeoutId)
        return response
      } catch (e) {
        if (timeoutId) clearTimeout(timeoutId)
        throw e
      }
    }

    // Record a single summary line for a manual (client-driven) sync into the
    // audit log. The client passes the composed summary + totals on completion.
    if (action === 'log_sync') {
      await logSyncEvent(storeId, body.summary || 'eBay sync', { kind: 'manual', ...(body.data || {}) })
      return json({ ok: true })
    }

    // Server-side nightly orchestrator (driven by pg_cron). Advances one store's
    // daily run: import → sold orders (backfill) → reconcile. Resumable: state
    // lives in sync_runs, so a later tick picks up exactly where this left off.
    // Reuses the existing actions via internal self-calls (no logic duplicated).
    if (action === 'cron_sync') {
      const runDate = new Date().toISOString().slice(0, 10)
      let { data: run } = await sb.from('sync_runs').select('*').eq('store_id', storeId).eq('run_date', runDate).maybeSingle()
      if (!run) {
        const { data: ins } = await sb.from('sync_runs').insert({ store_id: storeId, run_date: runDate, phase: 'import' }).select().single()
        run = ins
      }
      if (!run) throw new Error('Could not create sync_runs row')
      if (run.done) return json({ done: true, phase: 'done', detail: run.detail })

      const SELF_URL = `${Deno.env.get('SUPABASE_URL')}/functions/v1/ebay-import`
      const selfCall = async (payload: Record<string, unknown>) => {
        const r = await fetch(SELF_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: Deno.env.get('SUPABASE_ANON_KEY')! },
          body: JSON.stringify(payload),
        })
        return await r.json()
      }
      const save = (patch: Record<string, unknown>) =>
        sb.from('sync_runs').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', run.id)

      const started = Date.now()
      const BUDGET_MS = 110 * 1000
      let phase: string = run.phase
      let jobIdLocal: string | null = run.job_id
      // Capture each phase's result so the 'done' summary can report real totals.
      let bRes: any = null, fRes: any = null, recRes: any = null

      try {
        while (Date.now() - started < BUDGET_MS && phase !== 'done') {
          if (phase === 'import') {
            if (!jobIdLocal) {
              const s = await selfCall({ action: 'start', storeId })
              if (s.error) throw new Error(s.error)
              jobIdLocal = s.jobId
              await save({ job_id: jobIdLocal, detail: `import: 0/${s.totalIds}` })
            } else {
              const c = await selfCall({ action: 'process_chunk', jobId: jobIdLocal, storeId })
              if (c.error && c.retry) continue
              if (c.error) throw new Error(c.error)
              await save({ detail: `import ${c.offset}/${c.total} · ${c.imported} new, ${c.skipped} existing, ${c.failed} failed` })
              if (c.isComplete || c.status === 'completed') { phase = 'backfill'; await save({ phase }) }
            }
          } else if (phase === 'backfill') {
            bRes = await selfCall({ action: 'import_sold_orders', storeId, days: 120 })
            phase = 'fees'
            await save({ phase, detail: `sold orders: ${bRes.created ?? 0} new, ${bRes.updated ?? 0} updated` })
          } else if (phase === 'fees') {
            fRes = await selfCall({ action: 'import_fees', storeId, days: 120 })
            phase = 'reconcile'
            await save({ phase, detail: `eBay fees: $${fRes.feeTotal ?? 0} across ${fRes.ordersMatched ?? 0} orders` })
          } else if (phase === 'reconcile') {
            recRes = await selfCall({ action: 'reconcile', storeId })
            phase = 'done'
            await save({ phase, done: true, detail: `done · ${recRes.missingCount ?? 0} missing, ${recRes.staleCount ?? 0} stale on eBay` })
          }
        }
      } catch (e) {
        const msg = (e as Error).message
        // eBay/proxy throttling is transient: don't fail the run or log a scary
        // summary — just record a soft pause and leave done=false so the next
        // 2-minute cron tick resumes from exactly where this left off.
        const isRateLimit = /rate limit|retry after|429|call limit|throttl/i.test(msg)
        if (isRateLimit) {
          await save({ detail: `paused in ${phase} (rate-limited) — resumes next tick` })
          return json({ phase, paused: true, reason: msg }, 200)
        }
        await save({ detail: `error in ${phase}: ${msg}` })
        await logSyncEvent(storeId, `Nightly sync failed in ${phase}: ${msg}`, { kind: 'nightly', ok: false, phase })
        return json({ phase, error: msg }, 200)
      }
      // Record one summary line per completed nightly run.
      if (phase === 'done') {
        const { data: jobRow } = jobIdLocal
          ? await sb.from('jobs').select('result_summary, failed_items').eq('id', jobIdLocal).maybeSingle()
          : { data: null as any }
        const imp = jobRow?.result_summary?.imported ?? 0
        const summary = `Nightly sync ✓ · ${imp} listings imported · `
          + `${bRes?.created ?? 0} sold new/${bRes?.updated ?? 0} updated · `
          + `$${fRes?.feeTotal ?? 0} fees · `
          + `${recRes?.missingCount ?? 0} missing, ${recRes?.staleCount ?? 0} stale`
        await logSyncEvent(storeId, summary, {
          kind: 'nightly', ok: true,
          listingsImported: imp, soldNew: bRes?.created ?? 0, soldUpdated: bRes?.updated ?? 0,
          feeTotal: fRes?.feeTotal ?? 0, missing: recRes?.missingCount ?? 0, stale: recRes?.staleCount ?? 0,
        })
      }
      return json({ phase, done: phase === 'done' })
    }

    if (action === 'backfill_orders') {
      const { token, certId } = await getToken()

      const fromDate = body.fromDate
      const toDate   = body.toDate || new Date().toISOString()
      if (!fromDate) throw new Error('fromDate is required')

      let page      = 1
      let hasMore   = true
      let updated    = 0
      let alreadySold = 0
      let notFound   = 0
      const errors: string[] = []

      while (hasMore && page <= 10) {
        const xml = await trading(token, certId, 'GetSellerTransactions', `<?xml version="1.0" encoding="utf-8"?>
<GetSellerTransactionsRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ModifiedTimeFilter>
    <TimeFrom>${fromDate}</TimeFrom>
    <TimeTo>${toDate}</TimeTo>
  </ModifiedTimeFilter>
  <Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>
</GetSellerTransactionsRequest>`)

        if (getTag(xml, 'Ack') === 'Failure') {
          throw new Error(getTag(xml, 'LongMessage') || 'GetSellerTransactions API error')
        }

        const transactions = parseTransactions(xml)
        console.log(`[backfill_orders] ${fromDate.slice(0,10)} page ${page}: ${transactions.length} transactions`)

        for (const tx of transactions) {
          try {
            const { data: listing } = await sb.from('listings')
              .select('id, part_id, status')
              .eq('store_id', storeId)
              .eq('platform', 'ebay')
              .eq('platform_listing_id', tx.itemId)
              .maybeSingle()

            if (!listing) { notFound++; continue }
            if (!tx.salePrice || tx.salePrice <= 0) { notFound++; continue }
            if (listing.status === 'sold') { alreadySold++; continue }

            await sb.from('listings').update({
              status:               'sold',
              sold_price:           tx.salePrice || null,
              sold_at:              tx.soldAt || null,
              reconcile_flagged:    false,
              reconcile_flagged_at: null,
            }).eq('id', listing.id)

            await sb.from('parts').update({
              status: 'sold',
              ...(tx.salePrice ? { sold_price: tx.salePrice } : {}),
              ...(tx.soldAt    ? { sold_date:  tx.soldAt }    : {}),
              ...(tx.shipping  ? { shipping_charged: tx.shipping } : {}),
            }).eq('id', listing.part_id)

            updated++
          } catch (e: any) {
            errors.push(`${tx.itemId}: ${e.message}`)
          }
        }

        hasMore = xml.includes('<HasMoreTransactions>true</HasMoreTransactions>')
        page++
      }

      return json({ updated, alreadySold, notFound, errors: errors.slice(0, 20) })
    }

    if (action === 'import_sold_history') {
      const startTime = Date.now()
      const { token, certId } = await getToken()

      const fromDate = body.fromDate
      const toDate   = body.toDate || new Date().toISOString()
      if (!fromDate) throw new Error('fromDate is required')

      // Collect all transactions for this window
      const allTransactions: Array<{ itemId: string; title: string; salePrice: number; shipping: number; soldAt: string | null }> = []
      let page    = 1
      let hasMoreTx = true

      while (hasMoreTx && page <= 10) {
        const xml = await trading(token, certId, 'GetSellerTransactions', `<?xml version="1.0" encoding="utf-8"?>
<GetSellerTransactionsRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ModifiedTimeFilter>
    <TimeFrom>${fromDate}</TimeFrom>
    <TimeTo>${toDate}</TimeTo>
  </ModifiedTimeFilter>
  <Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>
</GetSellerTransactionsRequest>`)

        if (getTag(xml, 'Ack') === 'Failure') {
          throw new Error(getTag(xml, 'LongMessage') || 'GetSellerTransactions API error')
        }

        allTransactions.push(...parseTransactions(xml))
        hasMoreTx = xml.includes('<HasMoreTransactions>true</HasMoreTransactions>')
        page++
      }

      // Genuine sales only, deduplicated by itemId
      const seen = new Set<string>()
      const genuine = allTransactions.filter(tx => {
        if (tx.salePrice <= 0 || seen.has(tx.itemId)) return false
        seen.add(tx.itemId)
        return true
      })

      if (!genuine.length) return json({ created: 0, skipped: 0, noData: 0, hasMore: false })

      // Check which are already in PartVault
      const itemIds = genuine.map(tx => tx.itemId)
      const { data: existing } = await sb.from('listings')
        .select('platform_listing_id')
        .eq('store_id', storeId)
        .eq('platform', 'ebay')
        .in('platform_listing_id', itemIds)
      const existingIds = new Set((existing || []).map((r: any) => r.platform_listing_id))

      const toCreate = genuine.filter(tx => !existingIds.has(tx.itemId))
      if (!toCreate.length) return json({ created: 0, skipped: existingIds.size, noData: 0, hasMore: false })

      // Fetch item details from Shopping API in batches of 20, with timeout guard
      let created = 0
      let noData  = 0
      const errors: any[] = []

      for (let i = 0; i < toCreate.length; i += 20) {
        // Timeout guard — return hasMore:true so frontend re-calls this same window
        if (Date.now() - startTime > 20000) {
          return json({ created, skipped: existingIds.size, noData, errors: errors.slice(0, 20), hasMore: true })
        }

        const batch   = toCreate.slice(i, i + 20)
        const details = await fetchItemDetails(batch.map(tx => tx.itemId))

        for (const tx of batch) {
          try {
            const detail   = details[tx.itemId]
            const catId    = detail?.PrimaryCategoryID?.toString()
            const category = (catId && CATEGORY_ID_MAP[catId]) || 'Legacy Items'
            if (!detail) noData++

            const { data: part, error: partErr } = await sb.from('parts').insert({
              store_id:   storeId,
              sku:        `EBH-${tx.itemId}`,
              title:      detail?.Title || tx.title || `eBay Item ${tx.itemId}`,
              category,
              status:     'sold',
              sold_price: tx.salePrice,
              sold_date:  tx.soldAt || null,
              shipping_charged: tx.shipping || null,
              list_price: tx.salePrice,
              condition:  detail?.ConditionDisplayName || 'Used – Good',
              source:     'ebay_history',
              costs:      { acquisition:0, labour:0, storage:0, packaging:0, postage:0, holding:0 },
              ai_assessed: false,
            }).select('id').single()

            if (partErr) { errors.push({ itemId: tx.itemId, error: partErr.message }); continue }

            await sb.from('listings').insert({
              store_id:            storeId,
              part_id:             part.id,
              platform:            'ebay',
              platform_listing_id: tx.itemId,
              status:              'sold',
              list_price:          tx.salePrice,
              sold_price:          tx.salePrice,
              sold_at:             tx.soldAt || null,
              platform_data:       {},
              photos:              [],
              photos_archived:     false,
            })
            created++
          } catch (e: any) {
            errors.push({ itemId: tx.itemId, error: e.message })
          }
        }
      }

      return json({ created, skipped: existingIds.size, noData, errors: errors.slice(0, 20), hasMore: false })
    }

    if (action === 'sales_match') {
      // Reconcile against eBay's order-complete source (Fulfillment getOrders),
      // which matches Seller Hub. Orders counted by creation date in-window; pricing
      // broken into item / shipping / tax / total so any gap is fully explained.
      const authHeader = req.headers.get('Authorization') || ''
      const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
      const { data: member } = await userClient.rpc('is_store_member', { p_store_id: storeId })
      if (!member) return json({ error: 'Not authorised' }, 403)

      // Window: either an explicit range (fromDate/toDate, already UTC ISO from the
      // browser so it matches eBay Seller Hub's local calendar dates) or rolling Nd.
      const days = Math.min(+body.days || 90, 365)
      const startDate = body.fromDate ? new Date(body.fromDate) : new Date(Date.now() - days * 86400000)
      const endDate   = body.toDate   ? new Date(body.toDate)   : new Date()
      const { token } = await getToken()
      const headers = { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_AU', 'Accept': 'application/json' }

      const filter = `creationdate:[${startDate.toISOString()}..${endDate.toISOString()}]`
      let offset = 0, total = 0
      let ebayOrders = 0, ebayItems = 0, cancelled = 0
      let itemTotal = 0, shipTotal = 0, taxTotal = 0, grandTotal = 0
      const ebayItemIds = new Set<string>()
      // Per-order line items, so we can pinpoint which exact sales we're missing
      // (an order with N line items needs N of our sold parts tagged with its id).
      const ebayByOrder: Record<string, { legacyItemId?: string, sku?: string, title?: string, price: number }[]> = {}
      do {
        const url = `https://api.ebay.com/sell/fulfillment/v1/order?filter=${encodeURIComponent(filter)}&limit=200&offset=${offset}`
        const r = await fetch(url, { headers })
        if (!r.ok) { const t = await r.text(); throw new Error(`getOrders ${r.status}: ${t.slice(0, 300)}`) }
        const d = await r.json()
        total = +d.total || 0
        for (const o of (d.orders ?? [])) {
          const cs = o.cancelStatus?.cancelState
          if (cs && cs !== 'NONE_REQUESTED') { cancelled++; continue }
          const ps = o.pricingSummary ?? {}
          ebayOrders++
          itemTotal  += +ps.priceSubtotal?.value || 0
          shipTotal  += +ps.deliveryCost?.value  || 0
          taxTotal   += +ps.tax?.value           || 0
          grandTotal += +ps.total?.value         || 0
          const oid = o.orderId as string
          for (const li of (o.lineItems ?? [])) {
            ebayItems += +li.quantity || 1
            if (li.legacyItemId) ebayItemIds.add(li.legacyItemId)
            ;(ebayByOrder[oid] ??= []).push({
              legacyItemId: li.legacyItemId, sku: li.sku, title: li.title,
              price: +li.lineItemCost?.value || +li.total?.value || 0,
            })
          }
        }
        offset += 200
      } while (offset < total && offset < 5000)

      // "Our" side now reads the ebay_sales mirror (the source of truth), so it
      // equals eBay's getOrders by construction once an import has run.
      const { data: ourSold } = await sb.from('ebay_sales').select('sold_price, shipping, order_id')
        .eq('store_id', storeId).eq('cancelled', false)
        .gte('sold_at', startDate.toISOString()).lte('sold_at', endDate.toISOString())
      const ourCount = (ourSold ?? []).length
      const ourItem  = (ourSold ?? []).reduce((a: number, s: any) => a + (+s.sold_price || 0), 0)
      const ourShip  = (ourSold ?? []).reduce((a: number, s: any) => a + (+s.shipping || 0), 0)

      // How many sale rows we hold per eBay order, to find under-covered orders.
      const ourByOrder: Record<string, number> = {}
      for (const s of (ourSold ?? [])) if (s.order_id) ourByOrder[s.order_id] = (ourByOrder[s.order_id] || 0) + 1
      const missingItems: any[] = []
      let missingValue = 0, missingCount = 0
      for (const [oid, items] of Object.entries(ebayByOrder)) {
        const have = ourByOrder[oid] || 0
        if (have < items.length) {
          for (const m of items.slice(have)) {
            missingCount++; missingValue += m.price
            if (missingItems.length < 50) missingItems.push({ orderId: oid, ...m })
          }
        }
      }
      const r2 = (n: number) => Math.round(n * 100) / 100

      return json({
        ok: true, version: EDGE_FN_VERSION, days, source: 'getOrders',
        windowFrom: startDate.toISOString(), windowTo: endDate.toISOString(),
        ebayOrders, ebayItems, ebayCancelled: cancelled,
        ebayItemTotal: r2(itemTotal), ebayShipping: r2(shipTotal), ebayTax: r2(taxTotal), ebayPaidTotal: r2(grandTotal),
        ourCount, ourItemTotal: r2(ourItem), ourShipping: r2(ourShip),
        missingSales: Math.max(0, ebayItems - ourCount),
        missingCount, missingValue: r2(missingValue), missingItems,
      })
    }

    // Order-complete sold import. Walks eBay getOrders and upserts EVERY line item
    // into the ebay_sales mirror, keyed on (store_id, order_id, line_item_id) —
    // eBay's own unique key. This is idempotent and collision-proof: a relist or
    // repeat sale of the same SKU/item produces a SEPARATE row instead of
    // overwriting. ebay_sales is the source of truth for sales revenue + fees, so
    // the Dashboard P&L and Sales-match equal eBay's getOrders exactly. We also
    // best-effort link each sale to an inventory part (for COGS) and mark a matched
    // part sold — but the sale is recorded whether or not a part match exists.
    if (action === 'import_sold_orders') {
      const days = Math.min(+body.days || 120, 365)
      const startDate = new Date(Date.now() - days * 86400000)
      const startOffset = Math.max(0, +body.startOffset || 0)
      const { token } = await getToken()
      const headers = { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_AU', 'Accept': 'application/json' }
      const filter = `creationdate:[${startDate.toISOString()}..${new Date().toISOString()}]`

      const startedAt = Date.now()
      let offset = startOffset, total = 0, upserted = 0, linked = 0, lineItems = 0, failed = 0
      const failedReasons: string[] = []
      do {
        const url = `https://api.ebay.com/sell/fulfillment/v1/order?filter=${encodeURIComponent(filter)}&limit=200&offset=${offset}`
        const r = await fetch(url, { headers })
        if (!r.ok) { const t = await r.text(); throw new Error(`getOrders ${r.status}: ${t.slice(0, 300)}`) }
        const d = await r.json()
        total = +d.total || 0
        for (const o of (d.orders ?? [])) {
          const cs = o.cancelStatus?.cancelState
          const isCancelled = !!(cs && cs !== 'NONE_REQUESTED')
          const soldDate: string = o.creationDate
          const lis = o.lineItems ?? []
          const ship = +o.pricingSummary?.deliveryCost?.value || 0
          const shipPer = lis.length ? Math.round((ship / lis.length) * 100) / 100 : 0
          const orderId: string = o.orderId
          for (const li of lis) {
            lineItems++
            try {
              const legacyId: string | undefined = li.legacyItemId
              const sku: string | undefined = li.sku
              const lineItemId: string = li.lineItemId || legacyId || `${orderId}-${lineItems}`
              const qty = +li.quantity || 1
              const price = +li.lineItemCost?.value || +li.total?.value || 0

              // Best-effort link to an inventory part (by listing item id, then SKU).
              let partId: string | null = null
              if (legacyId) {
                const { data: lst } = await sb.from('listings').select('part_id').eq('store_id', storeId).eq('platform', 'ebay').eq('platform_listing_id', legacyId).limit(1).maybeSingle()
                if (lst) partId = lst.part_id
              }
              if (!partId && sku) {
                const { data: pr } = await sb.from('parts').select('id').eq('store_id', storeId).eq('sku', sku).maybeSingle()
                if (pr) partId = pr.id
              }

              // Upsert the authoritative sale row (collision-proof on the unique key).
              const { error: upErr } = await sb.from('ebay_sales').upsert({
                store_id: storeId, order_id: orderId, line_item_id: lineItemId,
                legacy_item_id: legacyId || null, sku: sku || null, title: li.title || 'eBay sale',
                quantity: qty, sold_price: price, shipping: shipPer,
                sold_at: soldDate, cancelled: isCancelled, part_id: partId,
                updated_at: new Date().toISOString(),
              }, { onConflict: 'store_id,order_id,line_item_id' })
              if (upErr) throw upErr
              upserted++

              // Keep inventory honest: mark a matched part sold (revenue still comes
              // from ebay_sales, so a collision here only affects inventory display).
              if (partId && !isCancelled) {
                await sb.from('parts').update({ status: 'sold', sold_price: price, sold_date: soldDate, shipping_charged: shipPer, ebay_order_id: orderId }).eq('id', partId)
                linked++
              }
            } catch (e: any) {
              failed++
              if (failedReasons.length < 5) failedReasons.push(String(e?.message || e))
            }
          }
        }
        offset += 200
      } while (offset < total && offset < 5000 && Date.now() - startedAt < 45000)

      const hasMore = offset < total
      // `created`/`updated` kept for backwards-compatible client display.
      return json({ ok: true, version: EDGE_FN_VERSION, days, ebayOrders: total, lineItems, upserted, linked, created: upserted, updated: linked, skipped: 0, failed, failedReasons, hasMore, nextOffset: offset })
    }

    // eBay selling fees from the Finances API (the ledger eBay's reports are built
    // from). Sums each SALE transaction's total fee per order, then attributes it to
    // that order's part(s) (split by sale price) into costs->>'ebay_fees'. This is
    // what makes net sales / margins match eBay's report — fees are ~24% of sales.
    if (action === 'import_fees') {
      const days = Math.min(+body.days || 120, 365)
      const startDate = new Date(Date.now() - days * 86400000)
      const { token } = await getToken()
      const headers = { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_AU', 'Accept': 'application/json' }
      const dateRange = `transactionDate:[${startDate.toISOString()}..${new Date().toISOString()}]`

      const startedAt = Date.now()
      const feeByOrder: Record<string, number> = {}
      let saleFees = 0, otherFees = 0, unattributed = 0

      // Resolve an order id from a transaction: direct field, else its references.
      const orderIdOf = (tx: any): string | undefined =>
        tx.orderId || (tx.references ?? []).find((r: any) => r.referenceType === 'ORDER_ID')?.referenceId

      // eBay splits selling costs across two transaction types: SALE (final value
      // fee, fixed fee, international/regulatory) and NON_SALE_CHARGE (promoted
      // listing fees, etc.). Both must be summed to match Seller Hub's total.
      for (const txType of ['SALE', 'NON_SALE_CHARGE']) {
        const filter = `${dateRange},transactionType:{${txType}}`
        let offset = 0, total = 0
        do {
          const url = `https://apiz.ebay.com/sell/finances/v1/transaction?filter=${encodeURIComponent(filter)}&limit=200&offset=${offset}`
          const r = await fetch(url, { headers })
          if (!r.ok) { const t = await r.text(); throw new Error(`getTransactions ${r.status}: ${t.slice(0, 300)}`) }
          const d = await r.json()
          total = +d.total || 0
          for (const tx of (d.transactions ?? [])) {
            const oid = orderIdOf(tx)
            // SALE fee is in totalFeeAmount; a NON_SALE_CHARGE's fee is its amount.
            const fee = txType === 'SALE' ? (+tx.totalFeeAmount?.value || 0) : (+tx.amount?.value || 0)
            if (!fee) continue
            if (txType === 'SALE') saleFees += fee; else otherFees += fee
            if (oid) feeByOrder[oid] = (feeByOrder[oid] || 0) + fee
            else unattributed += fee
          }
          offset += 200
        } while (offset < total && offset < 5000 && Date.now() - startedAt < 60000)
      }

      // Attribute each order's fee onto its ebay_sales line(s), split by sale price.
      // ebay_sales is the source of truth for fees (Dashboard sums fees from here).
      let updated = 0, ordersMatched = 0, feeTotal = 0
      for (const [oid, fee] of Object.entries(feeByOrder)) {
        feeTotal += fee
        const { data: sales } = await sb.from('ebay_sales').select('id, sold_price')
          .eq('store_id', storeId).eq('order_id', oid).eq('cancelled', false)
        if (!sales?.length) continue
        ordersMatched++
        const totalVal = sales.reduce((a: number, s: any) => a + (+s.sold_price || 0), 0)
        for (const s of sales) {
          const share = totalVal > 0 ? fee * ((+s.sold_price || 0) / totalVal) : fee / sales.length
          await sb.from('ebay_sales').update({ fees: Math.round(share * 100) / 100, updated_at: new Date().toISOString() }).eq('id', s.id)
          updated++
        }
        if (Date.now() - startedAt > 110000) break
      }

      const r2 = (n: number) => Math.round(n * 100) / 100
      return json({ ok: true, version: EDGE_FN_VERSION, days, feeTotal: r2(feeTotal), saleFees: r2(saleFees), otherFees: r2(otherFees), unattributed: r2(unattributed), ordersWithFees: Object.keys(feeByOrder).length, ordersMatched, updated })
    }

    if (action === 'sync_status') {
      // Lightweight sync-health check: how many parts are out of step with eBay.
      const authHeader = req.headers.get('Authorization') || ''
      const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
      const { data: member } = await userClient.rpc('is_store_member', { p_store_id: storeId })
      if (!member) return json({ error: 'Not authorised' }, 403)

      const { token, certId } = await getToken()
      const ebayIds = await fetchAllIds(token, certId, 'ActiveList')
      const ebaySet = new Set(ebayIds)
      const { data: activeListings } = await sb.from('listings').select('platform_listing_id')
        .eq('store_id', storeId).eq('platform', 'ebay').in('status', ['active', 'live']).not('deferred_review', 'is', true).is('deleted_at', null)
      const { data: allListings } = await sb.from('listings').select('platform_listing_id')
        .eq('store_id', storeId).eq('platform', 'ebay').is('deleted_at', null)
      const ourIds = new Set((allListings ?? []).map((l: any) => l.platform_listing_id))
      const ourActive = (activeListings ?? []).map((l: any) => l.platform_listing_id)
      const stale = ourActive.filter((id: string) => !ebaySet.has(id)).length   // listed here, gone from eBay
      const missing = ebayIds.filter((id: string) => !ourIds.has(id)).length     // on eBay, not here
      // Diagnostic: how our eBay listings break down by status (why pvActive may be 0).
      const { data: allRows } = await sb.from('listings').select('status').eq('store_id', storeId).eq('platform', 'ebay').is('deleted_at', null)
      const statusBreakdown: Record<string, number> = {}
      for (const l of (allRows ?? [])) statusBreakdown[l.status || 'null'] = (statusBreakdown[l.status || 'null'] || 0) + 1
      return json({ ok: true, version: EDGE_FN_VERSION, ebayActive: ebayIds.length, pvActive: ourActive.length, stale, missing, outOfSync: stale + missing, statusBreakdown, checkedAt: new Date().toISOString() })
    }

    if (action === 'reconcile') {
      const { token, certId } = await getToken()
      const ebayIds = await fetchAllIds(token, certId, 'ActiveList')
      const ebaySet = new Set(ebayIds)

      const { data: activeListings } = await sb.from('listings')
        .select('id, part_id, platform_listing_id, platform_sku')
        .eq('store_id', storeId)
        .eq('platform', 'ebay')
        .in('status', ['active', 'live'])
        .not('deferred_review', 'is', true)
        .is('deleted_at', null)

      const { data: allListings } = await sb.from('listings')
        .select('platform_listing_id')
        .eq('store_id', storeId)
        .eq('platform', 'ebay')
        .is('deleted_at', null)

      const ourIds     = new Set((allListings ?? []).map((l: any) => l.platform_listing_id))
      const missingIds = ebayIds.filter(id => !ourIds.has(id))
      const stale      = (activeListings ?? []).filter((l: any) => !ebaySet.has(l.platform_listing_id))

      if (stale.length > 0) {
        await sb.from('listings')
          .update({ reconcile_flagged: true, reconcile_flagged_at: new Date().toISOString() })
          .in('id', stale.map((l: any) => l.id))
      }

      const { data: lastJob } = await sb.from('jobs')
        .select('id, meta, failed_items')
        .eq('store_id', storeId)
        .eq('type', 'ebay_import')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      const failedReasons: Record<string, string> = lastJob?.meta?.failed_reasons ?? {}

      return json({
        ebayActiveCount: ebayIds.length,
        pvActiveCount:   (activeListings ?? []).length,
        missingCount:    missingIds.length,
        missingIds:      missingIds.slice(0, 50),
        staleCount:      stale.length,
        staleListings:   stale.map((l: any) => ({
          id:                l.id,
          partId:            l.part_id,
          platformListingId: l.platform_listing_id,
          platformSku:       l.platform_sku,
        })),
        failedCount:  Object.keys(failedReasons).length,
        failedItems:  Object.entries(failedReasons).map(([itemId, reason]) => ({ itemId, reason })),
        lastJobId:    lastJob?.id ?? null,
        reconciledAt: new Date().toISOString(),
      })
    }

    if (action === 'enrich_stale') {
      const { token, certId } = await getToken()
      const ids: string[] = body.itemIds ?? []
      if (!ids.length) throw new Error('No item IDs provided')

      const enriched: any[] = []

      for (const itemId of ids) {
        try {
          const xml = await trading(token, certId, 'GetItem', `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${itemId}</ItemID><DetailLevel>ReturnAll</DetailLevel><IncludeItemSpecifics>false</IncludeItemSpecifics>
</GetItemRequest>`)

          const ack     = getTag(xml, 'Ack')
          const errCode = getTag(xml, 'ErrorCode')
          const longMsg = getTag(xml, 'LongMessage')

          if (errCode === '17' || errCode === '291' || (ack === 'Failure' && longMsg.toLowerCase().includes('not found'))) {
            enriched.push({ itemId, ebayStatus: 'NotFound' }); continue
          }
          if (ack === 'Failure') {
            enriched.push({ itemId, ebayStatus: 'Error', error: longMsg }); continue
          }

          const sellingState  = getTag(xml, 'SellingState')
          const listingStatus = getTag(xml, 'ListingStatus')
          const endTime       = getTag(xml, 'EndTime')

          let ebayStatus = 'Ended'
          let salePrice: number | undefined
          let soldDate: string | undefined

          if (sellingState === 'EndedWithSales' || sellingState === 'Sold') {
            ebayStatus = 'Sold'
            salePrice  = parseFloat(getTag(xml, 'ConvertedCurrentPrice') || getTag(xml, 'CurrentPrice')) || undefined
            soldDate   = getTag(xml, 'PaidTime') || endTime
          } else if (listingStatus === 'Active' || sellingState === 'Active') {
            ebayStatus = 'Active'
          }

          enriched.push({
            itemId, ebayStatus,
            endDate:        endTime || undefined,
            salePrice,      soldDate,
            relistedItemId: getTag(xml, 'RelistedItemID') || undefined,
          })
        } catch (e: any) {
          enriched.push({ itemId, ebayStatus: 'Error', error: e.message })
        }
      }

      return json({ enriched })
    }

    if (action === 'apply_stale_resolution') {
      const resolutions: Array<{
        listingId:  string
        partId:     string
        resolution: 'sold' | 'ended' | 'defer' | 'keep_active'
        salePrice?: number
        soldDate?:  string
      }> = body.resolutions ?? []

      if (!resolutions.length) throw new Error('No resolutions provided')

      let updated = 0
      const errors: Record<string, string> = {}

      for (const r of resolutions) {
        try {
          if (r.resolution === 'defer') {
            await sb.from('listings').update({ deferred_review: true, reconcile_flagged: false }).eq('id', r.listingId)
            updated++; continue
          }
          if (r.resolution === 'keep_active') {
            await sb.from('listings').update({ reconcile_flagged: false, reconcile_flagged_at: null }).eq('id', r.listingId)
            updated++; continue
          }

          const listingUpdate: any = { reconcile_flagged: false, reconcile_flagged_at: null }
          const partUpdate: any    = {}

          if (r.resolution === 'sold') {
            listingUpdate.status     = 'sold'
            listingUpdate.sold_price = r.salePrice ?? null
            listingUpdate.sold_at    = r.soldDate ?? null
            partUpdate.status        = 'sold'
            if (r.salePrice !== undefined) partUpdate.sold_price = r.salePrice
            if (r.soldDate)               partUpdate.sold_date  = r.soldDate
          } else if (r.resolution === 'ended') {
            listingUpdate.status = 'ended'
          }

          await sb.from('listings').update(listingUpdate).eq('id', r.listingId)
          if (Object.keys(partUpdate).length) {
            await sb.from('parts').update(partUpdate).eq('id', r.partId)
          }
          updated++
        } catch (e: any) {
          errors[r.listingId] = e.message
        }
      }

      return json({ updated, errors })
    }

    if (action === 'retry') {
      const { token, certId } = await getToken()
      const ids: string[] = body.retryIds ?? []
      if (!ids.length) throw new Error('No retry IDs provided')

      let imported = 0
      let failed   = 0
      const failedReasons: Record<string, string> = {}

      for (const itemId of ids) {
        try {
          const xml = await trading(token, certId, 'GetItem', `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${itemId}</ItemID><DetailLevel>ReturnAll</DetailLevel>
</GetItemRequest>`)

          if (!xml.includes('<Ack>Success</Ack>') && !xml.includes('<Ack>Warning</Ack>')) {
            throw new Error(getTag(xml, 'LongMessage') || 'eBay API error')
          }

          const { data: existingListing } = await sb.from('listings')
            .select('id').eq('store_id', storeId).eq('platform', 'ebay').eq('platform_listing_id', itemId).maybeSingle()
          if (existingListing) { imported++; continue }

          const ebaySkuRaw = getTag(xml, 'SKU')
          let partId: string

          // Each live eBay listing is its own part: reuse on relist (SKU match,
          // no other live listing), else split concurrent same-SKU dupes into a
          // new part under a fresh internal SKU. (Mirrors the chunk-import rule.)
          const mkPart = async (sku: string) => {
            const { data: np, error: pErr } = await sb.from('parts').insert(buildPartRow(xml, sku)).select('id').single()
            if (pErr) throw pErr
            return np.id as string
          }
          const newSku = async () => {
            const { data: g, error: e } = await sb.rpc('generate_next_sku', { p_store_id: storeId })
            if (e || !g) throw new Error(`SKU generation failed: ${e?.message}`)
            return g as string
          }

          if (ebaySkuRaw) {
            const { data: existingPart } = await sb.from('parts')
              .select('id').eq('store_id', storeId).eq('sku', ebaySkuRaw).maybeSingle()
            if (existingPart) {
              const { data: liveOther } = await sb.from('listings')
                .select('id').eq('store_id', storeId).eq('platform', 'ebay').eq('part_id', existingPart.id)
                .in('status', ['active', 'live']).neq('platform_listing_id', itemId).is('deleted_at', null)
                .limit(1).maybeSingle()
              partId = liveOther ? await mkPart(await newSku()) : existingPart.id
            } else {
              partId = await mkPart(ebaySkuRaw)
            }
          } else {
            partId = await mkPart(await newSku())
          }

          const { error: listingErr } = await sb.from('listings').insert(buildListingRow(xml, partId))
          if (listingErr) throw listingErr
          await syncPhotosForPart(xml, partId)
          imported++
        } catch (e: any) {
          failed++
          failedReasons[itemId] = e.message
        }
      }

      const { data: lastJob } = await sb.from('jobs')
        .select('id, meta, failed_items')
        .eq('store_id', storeId)
        .eq('type', 'ebay_import')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (lastJob) {
        const updatedReasons = { ...(lastJob.meta?.failed_reasons ?? {}) }
        for (const id of ids) {
          if (failedReasons[id]) updatedReasons[id] = failedReasons[id]
          else delete updatedReasons[id]
        }
        await sb.from('jobs').update({
          failed_items: Object.keys(updatedReasons).length,
          meta:         { ...lastJob.meta, failed_reasons: updatedReasons },
        }).eq('id', lastJob.id)
      }

      return json({ imported, failed, failedReasons })
    }

    if (action === 'backfill_categories') {
      const startTime = Date.now()

      const { data: uncategorised } = await sb
        .from('parts')
        .select('id')
        .eq('store_id', storeId)
        .or('category.is.null,category.eq.')
        .is('deleted_at', null)

      if (!uncategorised?.length) return json({ updated: 0, noData: 0, hasMore: false })

      const uncategorisedIds = uncategorised.map((p: any) => p.id)

      // Pull CategoryID from platform_data already stored in listings table
      const partToCategoryId: Record<string, string> = {}
      for (let i = 0; i < uncategorisedIds.length; i += 200) {
        const chunk = uncategorisedIds.slice(i, i + 200)
        const { data: listings } = await sb
          .from('listings')
          .select('part_id, platform_data')
          .eq('store_id', storeId)
          .eq('platform', 'ebay')
          .in('part_id', chunk)
        for (const l of (listings || [])) {
          const catId = l.platform_data?.CategoryID?.toString()
          if (catId && !partToCategoryId[l.part_id]) partToCategoryId[l.part_id] = catId
        }
      }

      // Group by mapped category and batch update
      const categoryGroups: Record<string, string[]> = {}
      let noData = 0
      for (const partId of uncategorisedIds) {
        const catId   = partToCategoryId[partId]
        const category = catId && CATEGORY_ID_MAP[catId]
        if (!category) { noData++; continue }
        if (!categoryGroups[category]) categoryGroups[category] = []
        categoryGroups[category].push(partId)
      }

      let updated = 0
      for (const [category, partIds] of Object.entries(categoryGroups)) {
        if (Date.now() - startTime > 20000) {
          return json({ updated, noData, hasMore: true })
        }
        for (let j = 0; j < partIds.length; j += 500) {
          await sb.from('parts').update({ category }).in('id', partIds.slice(j, j + 500))
          updated += Math.min(500, partIds.length - j)
        }
      }

      return json({ updated, noData, hasMore: false })
    }

    if (action === 'create_draft_listings') {
      const { token } = await getToken()
      const partIds: string[] = body.partIds ?? []
      if (!partIds.length) throw new Error('No part IDs provided')

      const { data: parts, error: partsErr } = await sb
        .from('parts')
        .select('*')
        .in('id', partIds)
        .eq('store_id', storeId)
      if (partsErr) throw partsErr
      if (!parts?.length) throw new Error('No parts found')

      const ebayHeaders = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Language': 'en-AU',
        'Content-Language': 'en-AU',
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_AU',
      }

      // Fetch account policies and location (use first of each)
      const [fpRes, ppRes, rpRes, locRes] = await Promise.all([
        fetch('https://api.ebay.com/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_AU', { headers: ebayHeaders }),
        fetch('https://api.ebay.com/sell/account/v1/payment_policy?marketplace_id=EBAY_AU', { headers: ebayHeaders }),
        fetch('https://api.ebay.com/sell/account/v1/return_policy?marketplace_id=EBAY_AU', { headers: ebayHeaders }),
        fetch('https://api.ebay.com/sell/inventory/v1/location', { headers: ebayHeaders }),
      ])
      const [fpData, ppData, rpData, locData] = await Promise.all([fpRes.json(), ppRes.json(), rpRes.json(), locRes.json()])

      const fulfillmentPolicyId  = fpData.fulfillmentPolicies?.[0]?.fulfillmentPolicyId
      const paymentPolicyId      = ppData.paymentPolicies?.[0]?.paymentPolicyId
      const returnPolicyId       = rpData.returnPolicies?.[0]?.returnPolicyId
      const merchantLocationKey  = locData.locations?.[0]?.merchantLocationKey

      if (!fulfillmentPolicyId) throw new Error('No fulfillment policy on eBay account — set one up in eBay Seller Hub first')
      if (!paymentPolicyId)     throw new Error('No payment policy on eBay account — set one up in eBay Seller Hub first')
      if (!returnPolicyId)      throw new Error('No return policy on eBay account — set one up in eBay Seller Hub first')
      if (!merchantLocationKey) throw new Error('No inventory location — go to Settings → eBay Inventory Location and set up your address first')

      const CONDITION_MAP: Record<string, string> = {
        'Used – Excellent': 'USED_EXCELLENT',
        'Used – Good':      'USED_EXCELLENT',
        'Used – Fair':      'USED_EXCELLENT',
        'For Parts Only':   'FOR_PARTS_OR_NOT_WORKING',
        'Refurbished':      'SELLER_REFURBISHED',
      }

      const CATEGORY_ID: Record<string, string> = {
        'Air & Fuel Delivery':'33549','Air Conditioning & Heating':'33542','Brakes & Brake Parts':'33559',
        'Engines & Engine Parts':'33612','Engine Cooling':'33599','Exhaust & Emission':'33605',
        'Exterior Parts':'33637','Ignition Systems':'33687','Interior Parts':'33694',
        'Lighting & Bulbs':'33707','Starters, Alternators & Wiring':'33572','Steering & Suspension':'33579',
        'Transmission & Drivetrain':'33726','Wheels, Tyres & Parts':'33743','Towing Parts':'180143',
        'Other Car & Truck Parts':'9886','Legacy Items':'9886',
      }

      let drafted = 0
      let failed  = 0
      const errors: any[] = []

      for (const part of parts) {
        try {
          // Blocking SKU gate: nothing reaches eBay without a valid SKU. If the
          // part has none, mint one from the store's format and persist it.
          let sku = part.sku
          if (!sku || !String(sku).trim()) {
            const { data: gen, error: genErr } = await sb.rpc('generate_next_sku', { p_store_id: storeId, p_car_make: part.make || null })
            if (genErr || !gen) throw new Error(`Cannot create eBay draft without a SKU (auto-generation failed: ${genErr?.message || 'no SKU returned'})`)
            sku = gen as string
            await sb.from('parts').update({ sku }).eq('id', part.id)
          }
          const condition   = CONDITION_MAP[part.condition] || 'USED_GOOD'
          const categoryId  = CATEGORY_ID[part.category]   || '9886'
          const imageUrls   = (part.photos || []).map((p: any) => p.url || p.ebay_url).filter(Boolean).slice(0, 12)

          const aspects: Record<string, string[]> = {}
          if (part.make)  aspects['Make']  = [part.make]
          if (part.model) aspects['Model'] = [part.model]
          if (part.year)  aspects['Year']  = [String(part.year)]

          // 1. Create inventory item
          const invRes = await fetch(
            `https://api.ebay.com/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
            {
              method: 'PUT',
              headers: ebayHeaders,
              body: JSON.stringify({
                product: {
                  title: part.title,
                  description: part.notes || part.title,
                  aspects,
                  ...(imageUrls.length ? { imageUrls } : {}),
                },
                condition,
                availability: { shipToLocationAvailability: { quantity: 1 } },
              }),
            }
          )
          if (!invRes.ok && invRes.status !== 204) {
            const errText = await invRes.text()
            console.error(`Inventory item ${invRes.status} for ${sku}:`, errText)
            throw new Error(`Inventory item ${invRes.status}: ${errText.slice(0, 300)}`)
          }

          // 2. Create offer (UNPUBLISHED by default — publishOffer never called)
          const offerRes = await fetch('https://api.ebay.com/sell/inventory/v1/offer', {
            method: 'POST',
            headers: ebayHeaders,
            body: JSON.stringify({
              sku,
              marketplaceId: 'EBAY_AU',
              format: 'FIXED_PRICE',
              listingDescription: part.notes || part.title,
              pricingSummary: { price: { value: String(part.list_price), currency: 'AUD' } },
              categoryId,
              merchantLocationKey,
              listingPolicies: { fulfillmentPolicyId, paymentPolicyId, returnPolicyId },
              quantityLimitPerBuyer: 1,
            }),
          })
          const offerData = await offerRes.json()
          if (!offerRes.ok) throw new Error(offerData.errors?.[0]?.message || `Offer error ${offerRes.status}`)

          const offerId = offerData.offerId

          // 3. Update part + create listing record
          await sb.from('parts').update({ status: 'listed' }).eq('id', part.id)
          const { error: listingErr } = await sb.from('listings').insert({
            store_id:            storeId,
            part_id:             part.id,
            platform:            'ebay',
            platform_listing_id: offerId,
            platform_sku:        sku,
            status:              'draft',
            list_price:          part.list_price,
            platform_data:       { offerId, sku },
            photos:              part.photos || [],
            photos_archived:     false,
          })
          if (listingErr) throw new Error(`DB insert failed: ${listingErr.message}`)

          drafted++
        } catch (e: any) {
          failed++
          errors.push({ partId: part.id, sku: part.sku, error: e.message })
          console.error(`Draft failed for ${part.sku}:`, e.message)
        }
      }

      return json({ drafted, failed, errors })
    }

    if (action === 'market_lookup') {
      // Real eBay market data for a part: Browse (active comps + price range) and
      // Catalog (product/ePID match). App token — no user consent needed.
      const authHeader = req.headers.get('Authorization') || ''
      const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
      const { data: member } = await userClient.rpc('is_store_member', { p_store_id: storeId })
      if (!member) return json({ error: 'Not authorised' }, 403)

      let part = body.part
      if (!part && body.partId) {
        const { data } = await sb.from('parts').select('title, make, model, year, part_number, list_price, category').eq('id', body.partId).eq('store_id', storeId).single()
        part = data
      }
      if (!part) throw new Error('part or partId required')

      const pn = String(part.part_number || '').trim()
      const usePn = pn.length >= 4 && !/does not apply|n\/a|unknown|unbranded/i.test(pn)
      const q = (usePn ? pn : [part.make, part.model, part.year, part.title].filter(Boolean).join(' ')).slice(0, 100)
      const token = await getAppToken()
      const headers = { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_AU', 'Content-Type': 'application/json' }

      let browse: any = null
      try {
        const r = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&limit=50&filter=${encodeURIComponent('conditions:{USED}')}`, { headers })
        if (r.ok) {
          const d = await r.json()
          const items = d.itemSummaries || []
          const prices = items.map((i: any) => +i.price?.value || 0).filter((p: number) => p > 0).sort((a: number, b: number) => a - b)
          const myPrice = +part.list_price || 0
          browse = {
            total: d.total ?? items.length,
            sampled: prices.length,
            min: prices[0] || 0,
            median: prices.length ? prices[Math.floor(prices.length / 2)] : 0,
            max: prices[prices.length - 1] || 0,
            myPrice,
            cheaperThanPct: (myPrice > 0 && prices.length) ? Math.round(prices.filter((p: number) => p > myPrice).length / prices.length * 100) : null,
            samples: items.slice(0, 5).map((i: any) => ({ title: i.title, price: +i.price?.value || 0, url: i.itemWebUrl })),
          }
        } else { browse = { error: `Browse ${r.status}` } }
      } catch (e) { browse = { error: (e as Error).message } }

      let catalog: any = null
      try {
        const r = await fetch(`https://api.ebay.com/commerce/catalog/v1_beta/product_summary/search?q=${encodeURIComponent(q)}&limit=3`, { headers })
        if (r.ok) {
          const d = await r.json()
          const p0 = (d.productSummaries || [])[0]
          if (p0) catalog = { epid: p0.epid, title: p0.title, image: p0.image?.imageUrl || null, brand: (p0.brands || [])[0] || null }
        }
      } catch (_) { /* best effort */ }

      // Cache the market median on the part so Insights can compute over/under
      // pricing without calling Browse for every row.
      if (body.partId && browse && !browse.error && browse.median > 0) {
        try { await sb.from('parts').update({ market_price: browse.median, market_count: browse.total, market_checked_at: new Date().toISOString() }).eq('id', body.partId).eq('store_id', storeId) } catch (_) { /* ignore */ }
      }
      return json({ ok: true, query: q, matchedBy: usePn ? 'part number' : 'make/model/title', browse, catalog })
    }

    if (action === 'refresh_market') {
      // Bulk-refresh cached market prices for in-stock parts (throttled, capped).
      const authHeader = req.headers.get('Authorization') || ''
      const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
      const { data: member } = await userClient.rpc('is_store_member', { p_store_id: storeId })
      if (!member) return json({ error: 'Not authorised' }, 403)

      // Prefer never-checked / stalest first; cap so we stay within limits.
      const { data: parts } = await sb.from('parts')
        .select('id, title, make, model, year, part_number, list_price')
        .eq('store_id', storeId).eq('status', 'in_stock').is('deleted_at', null)
        .order('market_checked_at', { ascending: true, nullsFirst: true })
        .limit(Math.min(+body.limit || 60, 80))
      if (!parts?.length) return json({ ok: true, updated: 0, message: 'No in-stock parts to check' })

      const token = await getAppToken()
      const headers = { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_AU', 'Content-Type': 'application/json' }
      let updated = 0
      for (const p of parts) {
        const pn = String(p.part_number || '').trim()
        const usePn = pn.length >= 4 && !/does not apply|n\/a|unknown|unbranded/i.test(pn)
        const q = (usePn ? pn : [p.make, p.model, p.year, p.title].filter(Boolean).join(' ')).slice(0, 100)
        try {
          const r = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&limit=50&filter=${encodeURIComponent('conditions:{USED}')}`, { headers })
          if (r.ok) {
            const d = await r.json()
            const prices = (d.itemSummaries || []).map((i: any) => +i.price?.value || 0).filter((x: number) => x > 0).sort((a: number, b: number) => a - b)
            const median = prices.length ? prices[Math.floor(prices.length / 2)] : 0
            await sb.from('parts').update({ market_price: median || null, market_count: d.total ?? prices.length, market_checked_at: new Date().toISOString() }).eq('id', p.id)
            if (median > 0) updated++
          }
        } catch (_) { /* skip this one */ }
        await new Promise((res) => setTimeout(res, 150))
      }
      return json({ ok: true, updated, checked: parts.length })
    }

    if (action === 'preview_listing') {
      // Read-only preview of the eBay category + item specifics + fitment that a
      // publish would send for one part. Lets the user see everything we fill in.
      const authHeader = req.headers.get('Authorization') || ''
      const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
      const { data: member } = await userClient.rpc('is_store_member', { p_store_id: storeId })
      if (!member) return json({ error: 'Not authorised' }, 403)

      const partId = body.partId
      if (!partId) throw new Error('partId required')
      const { data: part, error: pErr } = await sb.from('parts').select('*').eq('id', partId).eq('store_id', storeId).single()
      if (pErr || !part) throw new Error('Part not found')
      // Reflect the editor's current (possibly unsaved) values so the preview
      // matches what's on screen — no need to save first.
      if (typeof body.title === 'string' && body.title) part.title = body.title
      if (body.price != null && body.price !== '') part.list_price = +body.price || 0
      if (typeof body.condition === 'string' && body.condition) part.condition = body.condition
      if (typeof body.description === 'string') part.description = body.description

      const { token } = await getToken()
      const ebayHeaders = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Language': 'en-AU',
        'Content-Language': 'en-AU',
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_AU',
      }
      const PREVIEW_CATEGORY_ID: Record<string, string> = {
        'Air & Fuel Delivery':'33549','Air Conditioning & Heating':'33542','Brakes & Brake Parts':'33559',
        'Engines & Engine Parts':'33612','Engine Cooling':'33599','Exhaust & Emission':'33605',
        'Exterior Parts':'33637','Ignition Systems':'33687','Interior Parts':'33694',
        'Lighting & Bulbs':'33707','Starters, Alternators & Wiring':'33572','Steering & Suspension':'33579',
        'Transmission & Drivetrain':'33726','Wheels, Tyres & Parts':'33743','Towing Parts':'180143',
        'Other Car & Truck Parts':'9886','Legacy Items':'9886',
      }
      let categoryTreeId = '15'
      try {
        const tRes = await fetch('https://api.ebay.com/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=EBAY_AU', { headers: ebayHeaders })
        if (tRes.ok) categoryTreeId = (await tRes.json()).categoryTreeId || '15'
      } catch (_) { /* keep default */ }
      const catQuery = [part.make, part.model, part.year, part.category, part.title].filter(Boolean).join(' ')
      let categoryId = PREVIEW_CATEGORY_ID[part.category] || '9886'
      let categoryName = ''
      try {
        const r = await fetch(`https://api.ebay.com/commerce/taxonomy/v1/category_tree/${categoryTreeId}/get_category_suggestions?q=${encodeURIComponent(catQuery || 'car part')}`, { headers: ebayHeaders })
        if (r.ok) {
          const d = await r.json()
          const sug = d.categorySuggestions?.[0]
          if (sug?.category?.categoryId) {
            categoryId = sug.category.categoryId
            const anc = (sug.categoryTreeNodeAncestors || []).map((a: any) => a.categoryName).reverse()
            categoryName = [...anc, sug.category.categoryName].filter(Boolean).join(' › ')
          }
        }
      } catch (_) { /* fallback id */ }

      const { data: phRows } = await sb.from('photos').select('url, ebay_url, is_primary, display_order').eq('parent_type', 'part').eq('parent_id', partId).order('is_primary', { ascending: false }).order('display_order', { ascending: true })
      let partUrls = (phRows || []).map((r: any) => r.url || r.ebay_url).filter(Boolean)
      if (!partUrls.length) partUrls = (part.photos || []).map((p: any) => { if (p && typeof p === 'object') return p.url || p.ebay_url; try { const o = JSON.parse(p); return o.url || o.ebay_url || p } catch { return p } }).filter(Boolean)

      // Store config (same as publish): footer, shipping, best offer, image mix.
      const { data: storeRow } = await sb.from('stores').select('settings').eq('id', storeId).single()
      const settings = storeRow?.settings || {}
      const comp = settings.imageComposition || {}
      const carMax = comp.carMax ?? 5
      const marketingMax = comp.marketingMax ?? 5
      const marketingImages: string[] = settings.marketingImages || []
      let carUrls: string[] = []
      if (part.car_id) {
        const { data: cph } = await sb.from('photos').select('url, ebay_url, is_primary, display_order').eq('parent_type', 'car').eq('parent_id', part.car_id).order('is_primary', { ascending: false }).order('display_order', { ascending: true })
        carUrls = (cph || []).map((r: any) => r.url || r.ebay_url).filter(Boolean).slice(0, carMax)
      }
      const photos = [...new Set([...partUrls, ...carUrls, ...marketingImages.slice(0, marketingMax)])].slice(0, 24)

      const { aspects, fitmentList, specs } = await fillAspects(part, categoryId, categoryTreeId, ebayHeaders, partUrls.slice(0, 6))
      // Show EVERY aspect eBay offers for this category, with our filled value
      // (or empty), so the user sees the full set and what's still blank.
      const ovSpec = (part.ebay_overrides && part.ebay_overrides.specifics) || {}
      const seen = new Set<string>()
      const specifics = (specs || []).map((s: any) => {
        seen.add(s.name)
        return { name: s.name, value: (aspects[s.name] || []).join(', '), required: !!s.required, options: (s.allowed || []).slice(0, 60), overridden: Object.prototype.hasOwnProperty.call(ovSpec, s.name) }
      })
      // Any filled aspect not in the spec list (shouldn't happen, but be safe).
      for (const [name, values] of Object.entries(aspects)) {
        if (!seen.has(name)) specifics.push({ name, value: (values as string[]).join(', '), required: false, options: [], overridden: Object.prototype.hasOwnProperty.call(ovSpec, name) })
      }

      // The exact description (body + compatible-with block + footer) and shipping
      // eBay will receive — so the preview has no surprises.
      const description = buildDescription(part, fitmentList, settings.footer || '')
      const shipping = settings.shipping || {}
      const shipCats = shipping.categories || {}
      const shipDefW = +shipping.defaultWeightG > 0 ? +shipping.defaultWeightG : 1000
      const shipDefDims = shipping.defaultDimsCm || {}
      const { weightG, dimL, dimW, dimH } = resolveShipping(part, shipCats, shipDefW, shipDefDims)

      return json({
        ok: true, categoryId, categoryName, specifics, fitment: fitmentList,
        title: part.title, description, photos,
        price: +part.list_price || 0, condition: part.condition || 'Used – Good',
        hasFooter: !!(settings.footer && settings.footer.trim()),
        allowOffers: !!settings.allowOffers,
        weightG, dims: { l: dimL, w: dimW, h: dimH },
      })
    }

    if (action === 'publish_listings') {
      // ── Authorize: caller must hold the 'publish' capability for this store ──
      const authHeader = req.headers.get('Authorization') || ''
      const userClient = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_ANON_KEY')!,
        { global: { headers: { Authorization: authHeader } } }
      )
      const { data: allowed, error: permErr } = await userClient.rpc('has_permission', { p_store_id: storeId, p_capability: 'publish' })
      if (permErr) throw permErr
      if (!allowed) return json({ error: 'You do not have permission to publish listings for this store' }, 403)

      const { token } = await getToken()
      const partIds: string[] = body.partIds ?? []
      if (!partIds.length) throw new Error('No part IDs provided')

      const { data: parts, error: partsErr } = await sb
        .from('parts').select('*').in('id', partIds).eq('store_id', storeId)
      if (partsErr) throw partsErr
      if (!parts?.length) throw new Error('No parts found')

      const ebayHeaders = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Language': 'en-AU',
        'Content-Language': 'en-AU',
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_AU',
      }

      const [fpRes, ppRes, rpRes, locRes] = await Promise.all([
        fetch('https://api.ebay.com/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_AU', { headers: ebayHeaders }),
        fetch('https://api.ebay.com/sell/account/v1/payment_policy?marketplace_id=EBAY_AU', { headers: ebayHeaders }),
        fetch('https://api.ebay.com/sell/account/v1/return_policy?marketplace_id=EBAY_AU', { headers: ebayHeaders }),
        fetch('https://api.ebay.com/sell/inventory/v1/location', { headers: ebayHeaders }),
      ])
      const [fpData, ppData, rpData, locData] = await Promise.all([fpRes.json(), ppRes.json(), rpRes.json(), locRes.json()])
      const fulfillmentPolicyId  = fpData.fulfillmentPolicies?.[0]?.fulfillmentPolicyId
      const paymentPolicyId      = ppData.paymentPolicies?.[0]?.paymentPolicyId
      const returnPolicyId       = rpData.returnPolicies?.[0]?.returnPolicyId
      const merchantLocationKey  = locData.locations?.[0]?.merchantLocationKey
      if (!fulfillmentPolicyId) throw new Error('No fulfillment policy on eBay account — set one up in eBay Seller Hub first')
      if (!paymentPolicyId)     throw new Error('No payment policy on eBay account — set one up in eBay Seller Hub first')
      if (!returnPolicyId)      throw new Error('No return policy on eBay account — set one up in eBay Seller Hub first')
      if (!merchantLocationKey) throw new Error('No inventory location — set it up in Settings → eBay first')

      // Auto-parts categories only accept "Used" (id 3000 = USED_EXCELLENT enum),
      // "For parts" (7000), "New" (1000), or Refurbished — NOT the graded
      // USED_GOOD/USED_ACCEPTABLE conditions (those are media-only).
      const CONDITION_MAP: Record<string, string> = {
        'Used – Excellent': 'USED_EXCELLENT', 'Used – Good': 'USED_EXCELLENT', 'Used – Fair': 'USED_EXCELLENT',
        'For Parts Only': 'FOR_PARTS_OR_NOT_WORKING', 'Refurbished': 'SELLER_REFURBISHED',
      }
      const CATEGORY_ID: Record<string, string> = {
        'Air & Fuel Delivery':'33549','Air Conditioning & Heating':'33542','Brakes & Brake Parts':'33559',
        'Engines & Engine Parts':'33612','Engine Cooling':'33599','Exhaust & Emission':'33605',
        'Exterior Parts':'33637','Ignition Systems':'33687','Interior Parts':'33694',
        'Lighting & Bulbs':'33707','Starters, Alternators & Wiring':'33572','Steering & Suspension':'33579',
        'Transmission & Drivetrain':'33726','Wheels, Tyres & Parts':'33743','Towing Parts':'180143',
        'Other Car & Truck Parts':'9886','Legacy Items':'9886',
      }

      // Store-wide image composition config: shared car/marketing images added
      // to every listing, with per-source budgets (eBay allows up to 24 images).
      const { data: storeRow } = await sb.from('stores').select('settings').eq('id', storeId).single()
      const comp = storeRow?.settings?.imageComposition || {}
      const carMax = comp.carMax ?? 5
      const marketingMax = comp.marketingMax ?? 5
      const marketingImages: string[] = storeRow?.settings?.marketingImages || []
      const EBAY_MAX_IMAGES = 24

      // Shipping: per-category preset > store default > hardcoded. Weight in grams,
      // dims in cm. Per-part weight (part.weight) overrides everything.
      const shipping = storeRow?.settings?.shipping || {}
      const shipCats = shipping.categories || {}
      const shipDefW = +shipping.defaultWeightG > 0 ? +shipping.defaultWeightG : 1000
      const shipDefDims = shipping.defaultDimsCm || {}

      const photoUrls = async (parentType: string, parentId: string) => {
        const { data } = await sb.from('photos')
          .select('url, ebay_url, is_primary, display_order')
          .eq('parent_type', parentType).eq('parent_id', parentId)
          .order('is_primary', { ascending: false }).order('display_order', { ascending: true })
        return (data || []).map((r: any) => r.url || r.ebay_url).filter(Boolean)
      }

      // eBay requires a LEAF category. Ask the Taxonomy API for the best leaf from
      // the part's title; the static map (often parent categories) is only a fallback.
      let categoryTreeId = '15' // EBAY_AU default
      try {
        const tRes = await fetch('https://api.ebay.com/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=EBAY_AU', { headers: ebayHeaders })
        if (tRes.ok) categoryTreeId = (await tRes.json()).categoryTreeId || '15'
      } catch (_) { /* keep default */ }
      const leafCategoryFor = async (query: string): Promise<string | null> => {
        try {
          const r = await fetch(`https://api.ebay.com/commerce/taxonomy/v1/category_tree/${categoryTreeId}/get_category_suggestions?q=${encodeURIComponent(query || 'car part')}`, { headers: ebayHeaders })
          if (!r.ok) return null
          const d = await r.json()
          return d.categorySuggestions?.[0]?.category?.categoryId || null
        } catch (_) { return null }
      }

      let published = 0
      let failed = 0
      const errors: any[] = []
      const results: any[] = []

      for (const part of parts) {
        try {
          // Blocking SKU gate
          let sku = part.sku
          if (!sku || !String(sku).trim()) {
            const { data: gen, error: genErr } = await sb.rpc('generate_next_sku', { p_store_id: storeId, p_car_make: part.make || null })
            if (genErr || !gen) throw new Error(`Cannot list without a SKU (auto-generation failed: ${genErr?.message || 'no SKU'})`)
            sku = gen as string
            await sb.from('parts').update({ sku }).eq('id', part.id)
          }

          const condition  = CONDITION_MAP[part.condition] || 'USED_GOOD'
          // Bias the category lookup toward auto parts (make/model/category, not
          // just the title) so a vague title doesn't match a media category.
          const catQuery = [part.make, part.model, part.year, part.category, part.title].filter(Boolean).join(' ')
          const categoryId = (await leafCategoryFor(catQuery)) || CATEGORY_ID[part.category] || '9886'
          // Compose images: the part's own photos first (eBay's gallery image),
          // then up to carMax donor-car photos, then up to marketingMax store
          // marketing images. Deduped and capped at eBay's 24.
          let partUrls = await photoUrls('part', part.id)
          if (!partUrls.length) {
            // Legacy parts.photos: text[] of plain URLs or stringified {"url":...}
            partUrls = (part.photos || []).map((p: any) => {
              if (p && typeof p === 'object') return p.url || p.ebay_url
              try { const o = JSON.parse(p); return o.url || o.ebay_url || p } catch { return p }
            }).filter(Boolean)
          }
          const carUrls = part.car_id ? (await photoUrls('car', part.car_id)).slice(0, carMax) : []
          const marketingUrls = marketingImages.slice(0, marketingMax)
          let imageUrls = [...new Set([...partUrls, ...carUrls, ...marketingUrls])].slice(0, EBAY_MAX_IMAGES)
          // Item specifics + confident fitment (shared with the preview action).
          const aiPhotos = (partUrls.length ? partUrls : imageUrls).slice(0, 6)
          const { aspects, fitmentList } = await fillAspects(part, categoryId, categoryTreeId, ebayHeaders, aiPhotos)

          // Full listing description: the part's description (or notes) + the
          // store's standard footer from settings.
          const footer = storeRow?.settings?.footer || ''
          const fullDescription = buildDescription(part, fitmentList, footer)
          const allowOffers = !!storeRow?.settings?.allowOffers
          // Package weight (grams) + dimensions (cm) — shared with the preview.
          const { weightG, dimL, dimW, dimH } = resolveShipping(part, shipCats, shipDefW, shipDefDims)

          // 1. Create/replace the inventory item (PUT is idempotent)
          const invRes = await fetch(`https://api.ebay.com/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
            method: 'PUT', headers: ebayHeaders,
            body: JSON.stringify({
              product: { title: part.title, description: fullDescription, aspects, ...(imageUrls.length ? { imageUrls } : {}) },
              condition,
              availability: { shipToLocationAvailability: { quantity: 1 } },
              packageWeightAndSize: {
                weight: { value: weightG, unit: 'GRAM' },
                dimensions: { length: dimL, width: dimW, height: dimH, unit: 'CENTIMETER' },
              },
            }),
          })
          if (!invRes.ok && invRes.status !== 204) {
            throw new Error(`Inventory item ${invRes.status}: ${(await invRes.text()).slice(0, 300)}`)
          }

          // 1b. eBay Parts Compatibility (the real "fits my vehicle" system).
          // Best-effort: many non-motors categories don't support it and invalid
          // catalogue entries are rejected — so we never let it block a publish.
          if (fitmentList.length) {
            try {
              const compatibleProducts: any[] = []
              for (const f of fitmentList) {
                if (!f.make || !f.model) continue
                const yf = +f.yearFrom, yt = +f.yearTo || yf
                const years: string[] = []
                if (yf) for (let y = yf; y <= yt && y - yf < 40; y++) years.push(String(y))
                else years.push('')
                for (const y of years) {
                  const props: any[] = [{ name: 'Make', value: String(f.make) }, { name: 'Model', value: String(f.model) }]
                  if (y) props.push({ name: 'Year', value: y })
                  if (f.trim) props.push({ name: 'Trim', value: String(f.trim) })
                  if (f.engine) props.push({ name: 'Engine', value: String(f.engine) })
                  compatibleProducts.push({ compatibilityProperties: props, ...(part.part_number ? { notes: `Part #: ${part.part_number}` } : {}) })
                  if (compatibleProducts.length >= 200) break
                }
                if (compatibleProducts.length >= 200) break
              }
              if (compatibleProducts.length) {
                const compatRes = await fetch(`https://api.ebay.com/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}/product_compatibility`, {
                  method: 'PUT', headers: ebayHeaders, body: JSON.stringify({ compatibleProducts }),
                })
                if (!compatRes.ok && compatRes.status !== 204) {
                  console.warn(`Parts compatibility skipped (${compatRes.status}) for ${sku}: ${(await compatRes.text()).slice(0, 200)}`)
                }
              }
            } catch (e) { console.warn('Parts compatibility error', e) }
          }

          // 2. Create the offer — or reuse an existing one for this SKU
          const offerBody = {
            sku, marketplaceId: 'EBAY_AU', format: 'FIXED_PRICE',
            listingDescription: fullDescription,
            pricingSummary: { price: { value: String(part.list_price), currency: 'AUD' } },
            categoryId, merchantLocationKey,
            listingPolicies: { fulfillmentPolicyId, paymentPolicyId, returnPolicyId, ...(allowOffers ? { bestOfferTerms: { bestOfferEnabled: true } } : {}) },
            quantityLimitPerBuyer: 1,
          }
          let offerId: string | undefined
          const offerRes = await fetch('https://api.ebay.com/sell/inventory/v1/offer', { method: 'POST', headers: ebayHeaders, body: JSON.stringify(offerBody) })
          if (offerRes.ok) {
            offerId = (await offerRes.json()).offerId
          } else {
            const offerData = await offerRes.json()
            const msg = offerData.errors?.[0]?.message || ''
            if (offerRes.status === 409 || /already exists/i.test(msg)) {
              const getRes = await fetch(`https://api.ebay.com/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=EBAY_AU`, { headers: ebayHeaders })
              offerId = (await getRes.json()).offers?.[0]?.offerId
              if (!offerId) throw new Error('Offer already exists but could not be retrieved')
              // keep price/policies current on the existing offer
              await fetch(`https://api.ebay.com/sell/inventory/v1/offer/${offerId}`, { method: 'PUT', headers: ebayHeaders, body: JSON.stringify(offerBody) })
            } else {
              throw new Error(msg || `Offer error ${offerRes.status}`)
            }
          }

          // 3. PUBLISH — this makes the listing LIVE on eBay
          const pubRes = await fetch(`https://api.ebay.com/sell/inventory/v1/offer/${offerId}/publish`, { method: 'POST', headers: ebayHeaders })
          const pubData = await pubRes.json()
          if (!pubRes.ok) throw new Error(pubData.errors?.[0]?.message || `Publish error ${pubRes.status}`)
          const listingId = pubData.listingId

          // 4. Record it — part now listed; listing 'active' (matches reconcile/import)
          await sb.from('parts').update({ status: 'listed' }).eq('id', part.id)
          await sb.from('listings').delete().eq('part_id', part.id).eq('platform', 'ebay').neq('status', 'sold')
          await sb.from('listings').insert({
            store_id: storeId, part_id: part.id, platform: 'ebay',
            platform_listing_id: listingId, platform_sku: sku, status: 'active',
            list_price: part.list_price, listed_at: new Date().toISOString(),
            platform_data: { offerId, listingId, sku }, photos: part.photos || [], photos_archived: false,
          })

          published++
          results.push({ partId: part.id, sku, listingId })
        } catch (e: any) {
          failed++
          errors.push({ partId: part.id, sku: part.sku, error: e.message })
          console.error(`Publish failed for ${part.sku}:`, e.message)
        }
      }

      return json({ published, failed, errors, results })
    }

    if (action === 'delist_listings') {
      // End live eBay listings for the selected parts, optionally binning the parts.
      const authHeader = req.headers.get('Authorization') || ''
      const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
      const { data: canPub } = await userClient.rpc('has_permission', { p_store_id: storeId, p_capability: 'publish' })
      if (!canPub) return json({ error: 'You do not have permission to manage eBay listings for this store' }, 403)
      const bin = !!body.bin
      if (bin) {
        const { data: canDel } = await userClient.rpc('has_permission', { p_store_id: storeId, p_capability: 'delete' })
        if (!canDel) return json({ error: 'You need Delete permission to bin parts' }, 403)
      }

      const { token, certId } = await getToken()
      const partIds: string[] = body.partIds ?? []
      if (!partIds.length) throw new Error('No part IDs provided')

      const ebayHeaders = {
        'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json',
        'Accept-Language': 'en-AU', 'Content-Language': 'en-AU', 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_AU',
      }
      const now = new Date().toISOString()
      let delisted = 0
      let failed = 0
      const errors: any[] = []

      for (const partId of partIds) {
        try {
          const { data: listings } = await sb.from('listings').select('*')
            .eq('part_id', partId).eq('platform', 'ebay').in('status', ['active', 'live']).is('deleted_at', null)
          for (const listing of (listings || [])) {
            const offerId = listing.platform_data?.offerId
            if (offerId) {
              // Listings we published — withdraw the offer
              const r = await fetch(`https://api.ebay.com/sell/inventory/v1/offer/${offerId}/withdraw`, { method: 'POST', headers: ebayHeaders })
              if (!r.ok && r.status !== 404) throw new Error(`Withdraw ${r.status}: ${(await r.text()).slice(0, 200)}`)
            } else if (listing.platform_listing_id) {
              // Imported listings — end via the Trading API
              const xml = await trading(token, certId, 'EndFixedPriceItem',
                `<?xml version="1.0" encoding="utf-8"?><EndFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${listing.platform_listing_id}</ItemID><EndingReason>NotAvailable</EndingReason></EndFixedPriceItemRequest>`)
              const ack = getTag(xml, 'Ack')
              if (ack && ack !== 'Success' && ack !== 'Warning') {
                const msg = getTag(xml, 'LongMessage') || getTag(xml, 'ShortMessage')
                // Treat "already ended/unavailable" as success
                if (!/ended|no longer|not available|auction.*closed/i.test(msg)) throw new Error(msg || 'End listing failed')
              }
            }
            await sb.from('listings').update({ status: 'ended', ended_at: now }).eq('id', listing.id)
          }
          if (bin) await sb.from('parts').update({ deleted_at: now }).eq('id', partId)
          else await sb.from('parts').update({ status: 'in_stock' }).eq('id', partId)
          delisted++
        } catch (e: any) {
          failed++
          errors.push({ partId, error: e.message })
        }
      }
      return json({ delisted, failed, errors })
    }

    if (action === 'get_ebay_username') {
      const { token, certId } = await getToken()
      const xml = await trading(token, certId, 'GetUser', `<?xml version="1.0" encoding="utf-8"?>
<GetUserRequest xmlns="urn:ebay:apis:eBLBaseComponents">
</GetUserRequest>`)
      const username = getTag(xml, 'UserID')
      if (!username) throw new Error('Could not fetch eBay username')
      return json({ username })
    }

    if (action === 'setup_ebay_location') {
      const { token } = await getToken()
      const address = body.address
      if (!address?.addressLine1 || !address?.city || !address?.postalCode || !address?.country) {
        throw new Error('Address line, city, postcode, and country are required')
      }

      const ebayHeaders = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Language': 'en-AU',
        'Content-Language': 'en-AU',
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_AU',
      }

      const merchantLocationKey = 'PARTVAULT_MAIN'

      // Check if it already exists
      const existingRes = await fetch(`https://api.ebay.com/sell/inventory/v1/location/${merchantLocationKey}`, { headers: ebayHeaders })

      const payload = {
        location: {
          address: {
            addressLine1:    address.addressLine1,
            city:            address.city,
            stateOrProvince: address.stateOrProvince || '',
            postalCode:      address.postalCode,
            country:         address.country.toUpperCase(),
          },
        },
        name: 'PartVault Main',
        merchantLocationStatus: 'ENABLED',
        locationTypes: ['WAREHOUSE'],
      }

      if (existingRes.ok) {
        // Update existing
        const updateRes = await fetch(`https://api.ebay.com/sell/inventory/v1/location/${merchantLocationKey}/update_location_details`, {
          method: 'POST',
          headers: ebayHeaders,
          body: JSON.stringify({ address: payload.location.address }),
        })
        if (!updateRes.ok && updateRes.status !== 204) {
          const e = await updateRes.json().catch(() => ({}))
          throw new Error(`Failed to update location: ${e.errors?.[0]?.message || updateRes.status}`)
        }
      } else {
        // Create new
        const createRes = await fetch(`https://api.ebay.com/sell/inventory/v1/location/${merchantLocationKey}`, {
          method: 'POST',
          headers: ebayHeaders,
          body: JSON.stringify(payload),
        })
        if (!createRes.ok && createRes.status !== 204) {
          const e = await createRes.json().catch(() => ({}))
          throw new Error(`Failed to create location: ${e.errors?.[0]?.message || createRes.status}`)
        }
      }

      return json({ merchantLocationKey })
    }

    throw new Error(`Unknown action: ${action}`)

  } catch (e: any) {
    console.error('Edge function error:', e.message)
    return json({ error: e.message }, 400)
  }
}
