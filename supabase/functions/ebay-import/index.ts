import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'
import { flattenSubtree, SUB_LISTS } from './taxonomy.js'
import { CATEGORY_ID_MAP } from './ebay/categories.ts'
import { parseVehicle } from './ebay/vehicles.ts'
import { buildDescription, hydrateVehicleFromCar, partTypeToken, categoryKeyFor, learnedCategoryFor, resolveShipping } from './ebay/listing-helpers.ts'
import {
  type AspectSpec, parseAspectSpecs, applyDerived, aspectsToAsk, aspectPromptList,
  applyAiAspects, ensureDonorFitment, compatibilityAspects, fillRequiredNeutral,
  applyWarranty, applyOverrides, expandYears, SPECIFICS_SYSTEM_PROMPT,
} from './ebay/aspects.ts'
import {
  AU_CATEGORY_FALLBACK, storeMarketplace, requireMarketplace, categoryMapFor, categoryLookupFor,
} from './ebay/marketplace.ts'
import { resolveGeminiModel, toGeminiParts, callGemini } from './ai/gemini.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ── RESPONSE HELPER ─────────────────────────────────────────────────────────
// MODULE scope on purpose. This used to be declared ~430 lines INSIDE
// handleRequest while purge_scan and purge_deleted_stores call it near the top
// of that same function — a temporal dead zone, so both actions threw
// "Cannot access 'json' before initialization" every time. purge_scan runs
// nightly from pg_cron ('partvault-purge-deleted', 03:30), so the store
// retention alert has never once been sent. It closes over nothing but CORS,
// so module scope is both the fix and where it belonged.
const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

const PROXY                   = 'https://partvault-proxy.leap00.workers.dev'
// eBay developer keyset — a single application identity shared by every store.
// These are platform-level config, NOT per-store data. Set them as edge-function
// secrets (Supabase dashboard → Edge Functions → Secrets). Fallbacks keep the
// existing app working if the secrets are not yet set; CERT_ID has no fallback
// because it is a client secret and must never be hard-coded.
const APP_ID                  = Deno.env.get('EBAY_APP_ID')  || 'Discount-PartVaul-PRD-36c135696-64f7f7bf'
const CERT_ID                 = Deno.env.get('EBAY_CERT_ID') || ''
const RUNAME                  = Deno.env.get('EBAY_RUNAME')  || 'Discount_Tradin-Discount-PartVa-jhtznvhgx'
const EDGE_FN_VERSION         = '3.36.93'

// ═══════════════════════════════════════════════════════════════════════════
//  HARD BLOCK — EDITING LIVE eBay LISTINGS IS DISABLED AT THE CODE LEVEL.
//
//  Requested by the store owner (2026-07-14). Rationale: a wrong write to a live
//  listing — above all a SKU/custom label — makes parts unfindable in the
//  warehouse. That is unrecoverable in practice, so the capability is removed
//  rather than guarded by a confirmation dialog.
//
//  While false:
//    • apply_specifics NEVER pushes to eBay (local overrides only).
//    • publish_listings REFUSES any part that already has a live listing —
//      no inventory-item replace, no offer update, no compatibility write.
//    • Creating a listing for a part that is NOT live is still allowed.
//
//  DO NOT flip this to true without explicit written sign-off from the owner.
//  Any future live-edit feature must be per-item, explicitly confirmed, never
//  bulk, and must never send a SKU.
// ═══════════════════════════════════════════════════════════════════════════
const ALLOW_LIVE_EBAY_EDITS = false
const CHUNK_SIZE              = 20
// eBay's getOrders can't return orders older than this, so the live sync only ever
// manages sales within this window. The CSV history import must stay strictly OLDER
// than this so it can never collide with (or be clobbered by) a future sync.
const API_WINDOW_DAYS        = 90
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000
const FUNCTION_TIMEOUT_MS     = 45 * 1000 // safety net; the chunk soft-limits at ~18s
const EBAY_TOKEN_URL          = 'https://api.ebay.com/identity/v1/oauth2/token'
const EBAY_SCOPES = 'https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.inventory.readonly https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly https://api.ebay.com/oauth/api_scope/sell.finances https://api.ebay.com/oauth/api_scope/sell.account.readonly'

// ── Vehicle title parser (server copy of src/lib/vehicles.js) ─────────────────
// Recovers make/model/year from an eBay title so the sync can fill them in itself.
// Keep in sync with the client copy if the lists change.
// Superset across marketplaces (AU + US/CA + UK makes) — safe for parsing any
// region's titles; the regional nuance lives in the alias sets below.
// Vehicle title parsing moved to ./ebay/vehicles.ts

// CATEGORY_ID_MAP moved to ./ebay/categories.ts


// ── Gemini provider (shared with ai-assess) ─────────────────────────────────
// The item-specifics photo call is token-heavy vision work, so it defaults to
// Google Gemini (~10× cheaper than Claude) with a Claude fallback on any error.
// Model names churn (Google retires old IDs for new keys), so we ask the API
// which Flash model THIS key can use rather than hardcoding one. Cached per
// cold-start. Mirrors the helpers in supabase/functions/ai-assess/index.ts.
// Gemini transport moved to ./ai/gemini.ts

const AI_FULL_LIMITS: Record<string, number> = { trial: 100, basic: 50, pro: 1000, business: 3000 }
const CLAUDE_MODEL_IDS: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001', sonnet: 'claude-sonnet-5', opus: 'claude-opus-4-8',
}
async function meterAIOp(sb: any, storeId: string | undefined, w: number): Promise<{ allowed: boolean; commit: () => void }> {
  const open = { allowed: true, commit: () => {} }
  if (!sb || !storeId) return open
  try {
    const { data: st } = await sb.from('stores').select('plan').eq('id', storeId).single()
    const plan = st?.plan || {}
    const inc = () => sb.rpc('increment_ai_usage', { p_store_id: storeId, p_kind: 'full', p_amount: w }).then(() => {}, () => {})
    if (plan.founder) return { allowed: true, commit: inc }
    const limit = AI_FULL_LIMITS[plan.tier || 'business'] ?? AI_FULL_LIMITS.business
    const month = new Date().toISOString().slice(0, 7)
    const { data: usage } = await sb.from('ai_usage').select('full_count').eq('store_id', storeId).eq('month', month).maybeSingle()
    if ((Number(usage?.full_count) || 0) < limit) return { allowed: true, commit: inc }
    const { data: cr } = await sb.from('ai_credits').select('balance').eq('store_id', storeId).maybeSingle()
    if ((Number(cr?.balance) || 0) >= w) {
      return { allowed: true, commit: () => { sb.rpc('consume_ai_credit', { p_store_id: storeId, p_amount: w }).then(() => {}, () => {}); inc() } }
    }
    return { allowed: false, commit: () => {} }
  } catch { return open }
}

// Build the eBay item specifics + confident fitment for a part, using the
// Taxonomy aspect list for its leaf category. Three passes: derive from our
// structured data, AI-fill the rest from the part photos, neutral fallback for
// required leftovers. Shared by publish_listings and preview_listing so the
// preview shows exactly what will be sent.
//
// The decisions each pass makes now live in ./ebay/aspects.ts and are tested
// directly; what remains here is the part that cannot be: the taxonomy fetch and
// the vision call.
async function fillAspects(
  part: any,
  categoryId: string,
  categoryTreeId: string,
  ebayHeaders: Record<string, string>,
  aiPhotos: string[],
  listingDefaults: any = {},
  opts: { provider?: string; model?: string; sb?: any; storeId?: string; partId?: string } = {},
): Promise<{ aspects: Record<string, string[]>; fitmentList: any[]; specs: any[] }> {
  const aspects: Record<string, string[]> = {}
  let fitmentList: any[] = []
  let specsOut: AspectSpec[] = [] // full list of every aspect eBay offers for this category
  try {
    const aRes = await fetch(`https://api.ebay.com/commerce/taxonomy/v1/category_tree/${categoryTreeId}/get_item_aspects_for_category?category_id=${categoryId}`, { headers: ebayHeaders })
    if (aRes.ok) {
      const specs = parseAspectSpecs(await aRes.json())
      specsOut = specs

      // Pass 1 — fill from our own structured part/car data.
      applyDerived(specs, part, aspects)

      // Pass 2 — AI fills the remaining specifics + confident fitment from the photos.
      const todo = aspectsToAsk(specs, aspects)
      const ANTHROPIC = Deno.env.get('ANTHROPIC_API_KEY')
      const geminiReady = !!Deno.env.get('GEMINI_API_KEY')
      // Provider routing: this token-heavy vision call defaults to Gemini (~10×
      // cheaper); per-store override via settings.aiModels.specifics (legacy
      // specificsProvider). On ANY Gemini error we fall back to Claude so a
      // listing never loses its specifics. Metered 0.2 credits (0.4 Opus),
      // charged only when the AI call succeeds.
      const wantGemini = (opts.provider ?? 'gemini') === 'gemini' && geminiReady
      const claudeModel = CLAUDE_MODEL_IDS[opts.model || ''] || CLAUDE_MODEL_IDS.haiku
      const specW = opts.model === 'opus' ? 0.4 : 0.2
      const gate = await meterAIOp(opts.sb, opts.storeId, specW)
      if (gate.allowed && (ANTHROPIC || geminiReady) && aiPhotos.length && todo.length) {
        try {
          const aspList = aspectPromptList(todo)
          const sys = SPECIFICS_SYSTEM_PROMPT
          const usr = `Part: ${part.title || ''}\nVehicle: ${part.make || ''} ${part.model || ''} ${part.year || ''}\nCategory: ${part.category || ''}\nPart number: ${part.part_number || 'unknown'}\n${aiPhotos.length > 1 ? `\nThe ${aiPhotos.length} photos are all of the SAME part from different angles/close-ups — use them together.` : ''}\nAspects to fill:\n${aspList}`
          const content = [
            ...aiPhotos.map((u: string) => ({ type: 'image', source: { type: 'url', url: u } })),
            { type: 'text', text: usr },
          ]
          // Log a Gemini miss (so we can watch reliability) then fall through to
          // Claude. Best-effort: never let logging break the specifics fill.
          const logGeminiMiss = async (e: unknown) => {
            if (!opts.sb || !opts.storeId) return
            try {
              await opts.sb.from('ai_usage_log').insert({
                store_id: opts.storeId, part_id: opts.partId || null, operation: 'specifics', model: 'gemini',
                input_tokens: 0, output_tokens: 0, cost_usd: 0, success: false,
                error_message: `gemini fallback: ${String(e).slice(0, 300)}`,
              })
            } catch (_) { /* ignore */ }
          }

          let raw = ''
          let usedModel = ''
          let usedTok = { inTok: 0, outTok: 0 }
          if (wantGemini) {
            try {
              const gModel = await resolveGeminiModel(opts.model === 'flash-lite')
              const g = await callGemini(gModel, sys, content, 1400)
              raw = g.text; usedModel = gModel; usedTok = { inTok: g.inTok, outTok: g.outTok }
            } catch (e) { await logGeminiMiss(e) }
          }
          if (!raw && ANTHROPIC) {
            const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: { 'x-api-key': ANTHROPIC, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
              body: JSON.stringify({
                model: wantGemini ? CLAUDE_MODEL_IDS.haiku : claudeModel, max_tokens: 1400, system: sys,
                messages: [{ role: 'user', content }],
              }),
            })
            if (aiRes.ok) {
              const aiData = await aiRes.json()
              raw = (aiData.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim()
              usedModel = wantGemini ? CLAUDE_MODEL_IDS.haiku : claudeModel
              usedTok = { inTok: aiData.usage?.input_tokens || 0, outTok: aiData.usage?.output_tokens || 0 }
            }
          }
          if (raw) {
            // Success → debit the credits and log the op (both best-effort).
            gate.commit()
            if (opts.sb && opts.storeId) {
              try {
                opts.sb.from('ai_usage_log').insert({
                  store_id: opts.storeId, part_id: opts.partId || null, operation: 'specifics', model: usedModel,
                  input_tokens: usedTok.inTok, output_tokens: usedTok.outTok, cost_usd: 0, credits: specW, success: true,
                }).then(() => {}, () => {})
              } catch (_) { /* ignore */ }
            }
          }
          if (raw) {
            let map: any = null
            try { map = JSON.parse(raw) } catch { const mm = raw.match(/\{[\s\S]*\}/); if (mm) map = JSON.parse(mm[0]) }
            applyAiAspects(todo, map?.aspects || map || {}, aspects)
            if (Array.isArray(map?.fitment)) fitmentList = map.fitment.slice(0, 50)
          }
        } catch (_) { /* AI is best-effort */ }
      }

      // Always include the donor vehicle in the fitment (the AI adds extra models
      // on top). Never let the donor car be dropped.
      fitmentList = ensureDonorFitment(fitmentList, part)

      // Compatible-vehicle item specifics (multi-value) from the fitment.
      compatibilityAspects(specs, fitmentList, aspects)

      // Pass 3 — required-but-empty → sensible/neutral value.
      fillRequiredNeutral(specs, part, aspects)

      // Warranty is a PERIOD, never the brand — set last so it is authoritative.
      applyWarranty(specs, aspects, listingDefaults)
    }
  } catch (_) { /* best effort */ }
  // Manual overrides win over the AI — the user's corrections in the listing
  // preview (and, later, the mapping page) are authoritative.
  const ovd = applyOverrides(part, aspects, fitmentList)
  return { aspects: ovd.aspects, fitmentList: ovd.fitmentList, specs: specsOut }
}

// Build the full listing description (body + "Compatible with" block + footer)
// exactly as it will be sent to eBay. Shared by publish + preview so the preview
// is a faithful image of the real listing.
// Listing helpers moved to ./ebay/listing-helpers.ts

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

// Marketplace config, category-id maps and the eBay-id -> our-category lookup
// moved to ./ebay/marketplace.ts, together with the reason they now report a
// failed read instead of silently answering "EBAY_AU".

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

  // Is the caller a member of the store they named? Declared HERE, at the top of
  // handleRequest, rather than beside the first action that happened to need it.
  // It used to live ~1,800 lines down, which put 22 earlier actions in its
  // temporal dead zone: adding a guard to any of them would have thrown
  // "Cannot access 'requireStoreMember' before initialization" at runtime — the
  // identical failure that left purge_scan returning HTTP 500 every night for
  // months. tsc cannot see that (a TDZ violation is legal to type-check), so
  // position is the only defence.
  const requireStoreMember = async () => {
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
    if (!jwt) throw new Error('Sign-in required')
    const { data: u, error: uErr } = await sb.auth.getUser(jwt)
    if (uErr || !u?.user) throw new Error('Sign-in required')
    const { data: m } = await sb.from('store_members').select('user_id')
      .eq('store_id', storeId).eq('user_id', u.user.id).limit(1)
    if (!m?.length) throw new Error('Not a member of this store')
  }

  // Which build is actually live? Nothing else could answer that cheaply:
  // sync_status requires membership and then makes up to 50 eBay API calls just
  // to return a string. A failed deploy keeps serving the OLD function with a
  // 200, so every deploy from here on is verified against this.
  // No auth, no database, no eBay — it reads one constant.
  if (action === 'version') return json({ ok: true, version: EDGE_FN_VERSION })

  // ── Purge SAFETY: report-only scan (this is what the daily cron calls) ───────
  // Finds stores past their retention window and EMAILS an alert — it NEVER
  // deletes. Nothing is erased without an explicit, confirmed manual purge below.
  if (action === 'purge_scan') {
    const { data: due } = await sb.from('stores')
      .select('id, name, deleted_at, purge_after').not('deleted_at', 'is', null)
      .lte('purge_after', new Date().toISOString())
    const list = due || []
    let emailed = false
    const RESEND = Deno.env.get('RESEND_API_KEY')
    // Alert recipient comes from the System admin panel (system_settings), then env, then default.
    const { data: sysRow } = await sb.from('system_settings').select('settings').eq('id', 1).maybeSingle()
    const to = sysRow?.settings?.purgeAlertEmail || Deno.env.get('PURGE_ALERT_EMAIL') || 'leap00@gmail.com'
    if (list.length && RESEND) {
      const rows = list.map((s: any) => `• ${s.name} (deleted ${String(s.deleted_at).slice(0, 10)}, retention ended ${String(s.purge_after).slice(0, 10)})`).join('\n')
      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST', headers: { Authorization: `Bearer ${RESEND}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'PartVault <noreply@partvault.app>', to: [to],
            subject: `[PartVault] ${list.length} store(s) awaiting permanent deletion — action required`,
            text: `These stores have passed their retention window and are awaiting PERMANENT deletion.\n\nNOTHING has been deleted. No data is erased until you confirm.\n\n${rows}\n\nReview and confirm in the admin before anything is removed.`,
          }),
        })
        emailed = r.ok
      } catch (_) { /* email best-effort */ }
    }
    return json({ ok: true, version: EDGE_FN_VERSION, due: list.length, emailed, needsResendKey: !RESEND && list.length > 0, stores: list.map((s: any) => ({ id: s.id, name: s.name })) })
  }

  // ── CONFIRMED manual purge — the only path that actually deletes ─────────────
  // Requires an explicit confirm flag + the exact store IDs the human reviewed,
  // so it can never run unattended or mass-delete. (Phone/SMS second factor to be
  // added once Twilio is set up.)
  if (action === 'purge_deleted_stores') {
    // This hard-deletes store rows and removes their photos from storage. Until
    // now the only thing standing in front of it was confirm:'PERMANENTLY-DELETE'
    // — a constant that lives in this repo, not a secret — on a function deployed
    // --no-verify-jwt with the service-role key. Anyone who could read a store id
    // could destroy that store. Requires a platform admin now.
    const adminJwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
    if (!adminJwt) return json({ error: 'Sign-in required' }, 401)
    const { data: adminUser, error: adminErr } = await sb.auth.getUser(adminJwt)
    if (adminErr || !adminUser?.user) return json({ error: 'Sign-in required' }, 401)
    // platform_admins read directly rather than via is_platform_admin(), which
    // resolves auth.uid() — null here, because this function holds the service
    // role, not the caller's session.
    const { data: padmin } = await sb.from('platform_admins')
      .select('user_id').eq('user_id', adminUser.user.id).limit(1)
    if (!padmin?.length) return json({ error: 'Not authorised' }, 403)

    if (body.confirm !== 'PERMANENTLY-DELETE' || !Array.isArray(body.storeIds) || !body.storeIds.length) {
      return json({ error: 'Confirmed purge requires confirm:"PERMANENTLY-DELETE" and an explicit storeIds list.' }, 400)
    }
    // Only delete stores that are genuinely deleted AND past their window.
    const { data: eligible } = await sb.from('stores')
      .select('id').in('id', body.storeIds).not('deleted_at', 'is', null).lte('purge_after', new Date().toISOString())
    const ids = (eligible || []).map((s: any) => s.id)
    let purged = 0
    for (const id of ids) {
      try {
        try {
          const { data: files } = await sb.storage.from('part-photos').list(id, { limit: 1000 })
          if (files?.length) await sb.storage.from('part-photos').remove(files.map((f: any) => `${id}/${f.name}`))
        } catch (_) { /* storage best-effort */ }
        const { error } = await sb.from('stores').delete().eq('id', id)
        if (!error) purged++
      } catch (_) { /* continue */ }
    }
    return json({ ok: true, version: EDGE_FN_VERSION, requested: body.storeIds.length, eligible: ids.length, purged })
  }

  // ── XML HELPERS ─────────────────────────────────────────────────────────────

  const getTag = (xml: string, tag: string): string =>
    xml.match(new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 's'))?.[1]?.trim() ?? ''

  // eBay category id → our category/subcategory, loaded once per request. Empty
  // until ensureCatLookup() runs, and an empty lookup simply means a part imports
  // with no category — exactly the old behaviour, never an error.
  let CAT_LOOKUP = new Map<string, { category: string; subcategory: string | null }>()
  let catLookupLoaded = false
  const ensureCatLookup = async () => {
    if (catLookupLoaded) return
    catLookupLoaded = true
    try {
      const mkt = await storeMarketplace(sb, storeId)
      CAT_LOOKUP = (await categoryLookupFor(sb, mkt.mp)).lookup
    } catch (_) { /* legacy map still applies below */ }
  }
  // The listing's own category, as eBay files it. PrimaryCategory comes first in
  // the item XML, so the first CategoryID is the primary one.
  const categoryFromXml = (xml: string) => {
    const catId = getTag(xml, 'CategoryID')
    if (!catId) return {}
    const hit = CAT_LOOKUP.get(String(catId))
    if (hit) return { category: hit.category, subcategory: hit.subcategory || null }
    const legacy = CATEGORY_ID_MAP[String(catId)]     // the old 45-entry map, still a floor
    return legacy ? { category: legacy } : {}
  }

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

  // List item IDs for everything STARTED in the last `days` days via GetSellerList.
  // Unlike GetMyeBaySelling (eBay's cached "My eBay" view) this hits the live
  // listing store, so it reliably includes listings created minutes ago. Returns
  // active + recently-ended alike — that's fine: the caller dedupes, import fetches
  // each item's real status, and for reconcile a few extra ids can only REDUCE
  // false "stale" flags (never add false "missing" beyond a harmless re-import).
  const fetchRecentlyListedIds = async (token: string, certId: string, days: number): Promise<string[]> => {
    const to   = new Date()
    const from = new Date(Date.now() - days * 86400000)
    const ids: string[] = []
    let page = 1, totalPages = 1
    do {
      const xml = await trading(token, certId, 'GetSellerList', `<?xml version="1.0" encoding="utf-8"?>
<GetSellerListRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <StartTimeFrom>${from.toISOString()}</StartTimeFrom>
  <StartTimeTo>${to.toISOString()}</StartTimeTo>
  <GranularityLevel>Coarse</GranularityLevel>
  <Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>
</GetSellerListRequest>`)
      if (getTag(xml, 'Ack') === 'Failure') throw new Error(getTag(xml, 'LongMessage') || 'GetSellerList error')
      if (page === 1) totalPages = getTotalPages(xml)
      getItemIds(xml).forEach(id => ids.push(id))
      page++
    } while (page <= Math.min(totalPages, 25))
    return ids
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

    // GetMyeBaySelling's view lags hours-to-a-day on brand-new listings, so
    // freshly-listed items were silently skipped by both import and reconcile (the
    // total looked right while the newest items were absent). Supplement the active
    // list with a recent-start-time GetSellerList pass and merge. Best-effort —
    // never let this extra pass fail the whole enumeration.
    if (listType === 'ActiveList') {
      try {
        const recent = await fetchRecentlyListedIds(token, certId, 30)
        recent.forEach(id => ids.push(id))
      } catch (e) {
        console.error('GetSellerList supplement failed:', (e as Error).message)
      }
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
      // Where eBay itself files this listing. Without this every imported part
      // arrived with a blank category and waited on a manual backfill.
      ...categoryFromXml(xml),
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

  // Stamp "last sync" from the lightweight 5-min live checks too, so the Sync
  // panel reflects them — throttled to ~20 min so audit_log doesn't bloat.
  const touchLiveSync = async (sid: string, summary: string) => {
    try {
      const { data } = await sb.from('audit_log').select('changed_at')
        .eq('store_id', sid).eq('table_name', 'sync').order('changed_at', { ascending: false }).limit(1)
      const last = data?.[0]?.changed_at ? new Date(data[0].changed_at).getTime() : 0
      if (Date.now() - last > 20 * 60 * 1000) await logSyncEvent(sid, summary, { kind: 'live', ok: true })
    } catch (_) { /* best-effort */ }
  }

  // ── ACTIONS ─────────────────────────────────────────────────────────────────

  try {



    if (action === 'exchange_oauth_code') {
      await requireStoreMember()
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

      // Marketplace match guard: the connected eBay account's registration site
      // must match the store's marketplace (a US account can't list AUD/AU
      // categories and vice-versa). Definite mismatch → reject BEFORE storing
      // tokens; unknown/unreadable site → allow (fail-open, eBay is the backstop).
      try {
        const mkt = await storeMarketplace(sb, storeId)
        const SITE_TO_MP: Record<string, string> = {
          'Australia': 'EBAY_AU', 'US': 'EBAY_US', 'eBayMotors': 'EBAY_US',
          'UK': 'EBAY_GB', 'Canada': 'EBAY_CA', 'CanadaFrench': 'EBAY_CA',
        }
        const xml = `<?xml version="1.0" encoding="utf-8"?><GetUserRequest xmlns="urn:ebay:apis:eBLBaseComponents"></GetUserRequest>`
        const resp = await trading(tokens.access_token, CERT_ID, 'GetUser', xml)
        const site = (resp.match(/<Site>([^<]+)<\/Site>/) || [])[1] || ''
        const acctMp = SITE_TO_MP[site] || ''
        if (acctMp && acctMp !== mkt.mp) {
          const label: Record<string, string> = { EBAY_AU: 'Australia', EBAY_US: 'the United States', EBAY_GB: 'the United Kingdom', EBAY_CA: 'Canada' }
          return json({ error: `This store is set to ${label[mkt.mp] || mkt.mp}, but the eBay account you connected is registered in ${label[acctMp] || site}. Connect a matching eBay account, or create a new store for ${label[acctMp] || 'that country'}.` }, 400)
        }
      } catch (_) { /* site unreadable — allow; eBay rejects mismatches at publish */ }

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
      await ensureCatLookup()
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
            const freshSku = async () => {
              const { data: g, error: e } = await sb.rpc('generate_next_sku', { p_store_id: storeId })
              if (e || !g) throw new Error(`SKU generation failed: ${e?.message}`)
              return g as string
            }
            // Create a part with a guaranteed-unique store SKU. eBay SKUs are NOT
            // unique — sellers reuse one custom label (e.g. "NEW LIBERTY") across
            // many listings — so inserting the eBay SKU verbatim can violate
            // parts_sku_store_unique and silently drop the listing. On any unique
            // collision, fall back to a freshly generated internal SKU and retry.
            const makePart = async (sku: string): Promise<string> => {
              // Guarantee a unique store SKU. eBay SKUs aren't unique (sellers reuse
              // one label across many parts) AND generate_next_sku can itself return
              // an already-used value, so the final fallbacks use the eBay item id —
              // globally unique, cannot collide. Otherwise the listing is dropped.
              for (let attempt = 0; attempt < 5; attempt++) {
                const candidate =
                  attempt === 0 ? sku :
                  attempt === 1 ? await freshSku() :
                  attempt === 2 ? `EB-${itemId}` :
                                  `EB-${itemId}-${attempt}`
                const { data: np, error: pErr } = await sb.from('parts')
                  .insert(buildPartRow(xml, candidate)).select('id').single()
                if (!pErr) return np.id as string
                if (!(pErr.code === '23505' || /parts_sku_store_unique|duplicate key/i.test(pErr.message || ''))) throw pErr
              }
              throw new Error('Could not allocate a unique SKU for part')
            }

            if (ebaySkuRaw) {
              // limit(1), NOT maybeSingle: duplicate eBay SKUs can already have
              // produced multiple parts, and maybeSingle THROWS on >1 row — which
              // would fail the import. Take the first match instead.
              const { data: existingParts } = await sb.from('parts')
                .select('id').eq('store_id', storeId).eq('sku', ebaySkuRaw).limit(1)
              const existingPart = existingParts?.[0]
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
      await requireStoreMember()
      await logSyncEvent(storeId, body.summary || 'eBay sync', { kind: 'manual', ...(body.data || {}) })
      return json({ ok: true })
    }

    // Server-side nightly orchestrator (driven by pg_cron). Advances one store's
    // daily run: import → sold orders (backfill) → reconcile. Resumable: state
    // lives in sync_runs, so a later tick picks up exactly where this left off.
    // Reuses the existing actions via internal self-calls (no logic duplicated).
    if (action === 'cron_sync') {
      // The in-app "Sync now" button routes through this SAME resumable pipeline
      // (manual:true) so a manual run behaves exactly like the nightly: it survives
      // tab-close, and a later cron tick resumes the same run. The only differences
      // are the audit-log label and that a manual run forces a fresh pass even if
      // today's nightly already finished. This pipeline is 100% read-only against
      // eBay (start/process_chunk/import_sold_orders/import_fees/reconcile only read).
      const manual = body.manual === true
      // Prefer the store's LOCAL date (passed by the tz-aware cron) so a run is
      // one-per-local-day; fall back to UTC date for manual/legacy calls.
      const runDate = (typeof body.runDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.runDate))
        ? body.runDate : new Date().toISOString().slice(0, 10)
      // Configurable interval means >1 run per local day, keyed by run_slot (the
      // local hour the window started). Manual runs use slot 0. Column-error
      // fallback keeps this working if the run_slot migration hasn't run yet.
      const runSlot = Number.isInteger(body.runSlot) ? body.runSlot : 0
      let useSlot = true
      let run: any = null
      {
        const sel = await sb.from('sync_runs').select('*').eq('store_id', storeId).eq('run_date', runDate).eq('run_slot', runSlot).maybeSingle()
        if (sel.error && /run_slot|column|schema/i.test(sel.error.message || '')) {
          useSlot = false
          run = (await sb.from('sync_runs').select('*').eq('store_id', storeId).eq('run_date', runDate).maybeSingle()).data
        } else run = sel.data
      }
      if (!run) {
        const row: Record<string, unknown> = { store_id: storeId, run_date: runDate, phase: 'import', ...(useSlot ? { run_slot: runSlot } : {}) }
        const { data: ins } = await sb.from('sync_runs').insert(row).select().single()
        run = ins
      } else if (manual && run.done) {
        // Explicit manual re-run: reset today's finished run to the top. Subsequent
        // driver calls see done=false and resume this same run (no repeat reset),
        // and the driver stops polling once it gets done:true — so no loop.
        const { data: rst } = await sb.from('sync_runs')
          .update({ phase: 'import', done: false, job_id: null, detail: 'manual sync starting…', updated_at: new Date().toISOString() })
          .eq('id', run.id).select().single()
        run = rst || run
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
              if (c.isComplete || c.status === 'completed') { phase = 'parse'; await save({ phase }) }
            }
          } else if (phase === 'parse') {
            const pr = await selfCall({ action: 'parse_titles', storeId })
            phase = 'backfill'
            await save({ phase, detail: `parse: ${pr.updated ?? 0} make/model filled` })
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
        await logSyncEvent(storeId, `${manual ? 'Manual' : 'Nightly'} sync failed in ${phase}: ${msg}`, { kind: manual ? 'manual' : 'nightly', ok: false, phase })
        return json({ phase, error: msg }, 200)
      }
      // Record one summary line per completed nightly run.
      if (phase === 'done') {
        const { data: jobRow } = jobIdLocal
          ? await sb.from('jobs').select('result_summary, failed_items').eq('id', jobIdLocal).maybeSingle()
          : { data: null as any }
        const imp = jobRow?.result_summary?.imported ?? 0
        const summary = `${manual ? 'Manual' : 'Nightly'} sync ✓ · ${imp} listings imported · `
          + `${bRes?.created ?? 0} sold new/${bRes?.updated ?? 0} updated · `
          + `$${fRes?.feeTotal ?? 0} fees · `
          + `${recRes?.missingCount ?? 0} missing, ${recRes?.staleCount ?? 0} stale`
        await logSyncEvent(storeId, summary, {
          kind: manual ? 'manual' : 'nightly', ok: true,
          listingsImported: imp, soldNew: bRes?.created ?? 0, soldUpdated: bRes?.updated ?? 0,
          feeTotal: fRes?.feeTotal ?? 0, missing: recRes?.missingCount ?? 0, stale: recRes?.staleCount ?? 0,
        })
      }
      return json({ phase, done: phase === 'done' })
    }

    if (action === 'backfill_orders') {
      await requireStoreMember()
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
      await requireStoreMember()
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
            // Original eBay listing date (StartTime) from the GetMultipleItems
            // detail — so the part/listing carry the real eBay listing date, not
            // our import date. Falls back to null when eBay doesn't return it.
            const startIso  = detail?.StartTime ? String(detail.StartTime) : null
            const startDate = startIso?.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null

            const { data: part, error: partErr } = await sb.from('parts').insert({
              store_id:   storeId,
              sku:        `EBH-${tx.itemId}`,
              title:      detail?.Title || tx.title || `eBay Item ${tx.itemId}`,
              category,
              status:     'sold',
              sold_price: tx.salePrice,
              sold_date:  tx.soldAt || null,
              acquired_date: startDate,
              listed_date:   startDate,
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
              listed_at:           startIso,
              sold_at:             tx.soldAt || null,
              platform_data:       startIso ? { StartTime: startIso } : {},
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

    if (action === 'backfill_listing_dates') {
      await requireStoreMember()
      // Repair parts that have no acquired_date by re-fetching their eBay listing
      // StartTime (the original listing date) from the Shopping API. Forward-only
      // keyset pagination by part id, so parts we can't resolve (eBay no longer
      // returns them) aren't retried forever — the client loops until hasMore.
      const started = Date.now()
      const LIMIT = 400
      const afterId = typeof body.afterId === 'string' ? body.afterId : '00000000-0000-0000-0000-000000000000'

      const { data: targetParts } = await sb.from('parts')
        .select('id')
        .eq('store_id', storeId)
        .is('deleted_at', null)
        .is('acquired_date', null)
        .gt('id', afterId)
        .order('id', { ascending: true })
        .limit(LIMIT)

      if (!targetParts?.length) return json({ ok: true, version: EDGE_FN_VERSION, updated: 0, noData: 0, hasMore: false, nextAfterId: null })

      const partIds = targetParts.map((p: any) => p.id)
      const nextAfterId = partIds[partIds.length - 1]

      // Map each part to its eBay listing item id(s).
      const partItems: Record<string, string[]> = {}
      const allItemIds = new Set<string>()
      for (let i = 0; i < partIds.length; i += 300) {
        const { data: ls } = await sb.from('listings')
          .select('part_id, platform_listing_id')
          .eq('store_id', storeId).eq('platform', 'ebay')
          .in('part_id', partIds.slice(i, i + 300))
        for (const l of (ls || [])) {
          if (!l.platform_listing_id) continue
          ;(partItems[l.part_id] ||= []).push(l.platform_listing_id)
          allItemIds.add(l.platform_listing_id)
        }
      }

      // Fetch StartTime for every item id (GetMultipleItems: 20 per call).
      const startById: Record<string, string> = {}
      const ids = [...allItemIds]
      for (let i = 0; i < ids.length && Date.now() - started < 90000; i += 20) {
        const details = await fetchItemDetails(ids.slice(i, i + 20))
        for (const [itemId, d] of Object.entries(details)) {
          if ((d as any)?.StartTime) startById[itemId] = String((d as any).StartTime)
        }
      }

      // Set each part's date to its EARLIEST listing StartTime; backfill the
      // listing.listed_at too. Parts with no recoverable date stay null (→ "—").
      let updated = 0, noData = 0
      for (const pid of partIds) {
        const items = partItems[pid] || []
        const starts = items.map(it => startById[it]).filter(Boolean).sort()
        if (!starts.length) { noData++; continue }
        const iso = starts[0]
        const date = iso.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null
        if (!date) { noData++; continue }
        await sb.from('parts').update({ acquired_date: date, listed_date: date }).eq('id', pid)
        for (const it of items) {
          if (startById[it]) {
            await sb.from('listings').update({ listed_at: startById[it] })
              .eq('store_id', storeId).eq('platform', 'ebay').eq('platform_listing_id', it).is('listed_at', null)
          }
        }
        updated++
      }

      return json({ ok: true, version: EDGE_FN_VERSION, updated, noData, hasMore: targetParts.length === LIMIT, nextAfterId })
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
      // eBay rejects future dates — cap the end at "now" (a To=today picker becomes
      // a future UTC instant once the local end-of-day is converted).
      const endDate   = new Date(Math.min((body.toDate ? new Date(body.toDate) : new Date()).getTime(), Date.now()))
      const { token } = await getToken()
      const headers = { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': (await storeMarketplace(sb, storeId)).mp, 'Accept': 'application/json' }

      const filter = `creationdate:[${startDate.toISOString()}..${endDate.toISOString()}]`
      let offset = 0, total = 0
      let ebayOrders = 0, ebayItems = 0, cancelled = 0
      let itemTotal = 0, shipTotal = 0, taxTotal = 0, grandTotal = 0, discTotal = 0, adjTotal = 0
      const ebayItemIds = new Set<string>()
      // Per-order line items, so we can pinpoint which exact sales we're missing
      // (an order with N line items needs N of our sold parts tagged with its id).
      const ebayByOrder: Record<string, { legacyItemId?: string, sku?: string, title?: string, price: number }[]> = {}
      // Orders whose own pricing breakdown doesn't reconcile (the unexplained $).
      const residualOrders: any[] = []
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
          const oSub  = +ps.priceSubtotal?.value || 0
          const oShip = +ps.deliveryCost?.value  || 0
          const oTax  = +ps.tax?.value           || 0
          const oTot  = +ps.total?.value         || 0
          const oDisc = (+ps.priceDiscount?.value || 0) + (+ps.deliveryDiscount?.value || 0)
          const oAdj  = +ps.adjustment?.value || 0
          itemTotal  += oSub
          shipTotal  += oShip
          taxTotal   += oTax
          grandTotal += oTot
          discTotal  += oDisc
          adjTotal   += oAdj
          // Per-order reconciliation: sub + ship + tax − discount + adj should equal
          // total. Anything left over is this order's contribution to "unexplained".
          const oResid = Math.round((oSub + oShip + oTax - oDisc + oAdj - oTot) * 100) / 100
          if (Math.abs(oResid) >= 0.01) {
            residualOrders.push({
              orderId: o.orderId, residual: oResid,
              subtotal: oSub, shipping: oShip, tax: oTax, discount: oDisc, adjustment: oAdj, total: oTot,
              paymentStatus: o.orderPaymentStatus, fulfillmentStatus: o.orderFulfillmentStatus,
            })
          }
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
        // Only genuine eBay-reported values. `ebayDiscount`/`ebayAdjustment` come
        // straight from the API. `ebayUnexplained` is whatever is still left over
        // after accounting for them — surfaced honestly, never folded into discount.
        ebayDiscount: r2(discTotal), ebayAdjustment: r2(adjTotal),
        ebayUnexplained: r2(itemTotal + shipTotal + taxTotal - discTotal + adjTotal - grandTotal),
        residualCount: residualOrders.length,
        residualOrders: residualOrders.sort((a, b) => Math.abs(b.residual) - Math.abs(a.residual)).slice(0, 40),
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
      const headers = { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': (await storeMarketplace(sb, storeId)).mp, 'Accept': 'application/json' }
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
          // Dispatch info: shipping state + buyer + ship-to (drives the To-send queue).
          const fulfillment: string | null = o.orderFulfillmentStatus || null
          const buyer: string | null = o.buyer?.username || null
          const shipToRaw = o.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo
          const shipTo = shipToRaw ? {
            name: shipToRaw.fullName || '',
            addressLine1: shipToRaw.contactAddress?.addressLine1 || '',
            addressLine2: shipToRaw.contactAddress?.addressLine2 || '',
            city: shipToRaw.contactAddress?.city || '',
            state: shipToRaw.contactAddress?.stateOrProvince || '',
            postcode: shipToRaw.contactAddress?.postalCode || '',
            country: shipToRaw.contactAddress?.countryCode || '',
            phone: shipToRaw.primaryPhone?.phoneNumber || '',
          } : null
          for (const li of lis) {
            lineItems++
            try {
              const legacyId: string | undefined = li.legacyItemId
              const sku: string | undefined = li.sku
              const lineItemId: string = li.lineItemId || legacyId || `${orderId}-${lineItems}`
              const qty = +li.quantity || 1
              const price = +li.lineItemCost?.value || +li.total?.value || 0
              // Line-level promotions/discounts. lineItemCost (= sold_price) is the
              // PRE-discount price; appliedPromotions are the reductions off it, so
              // the buyer actually paid (price − discount) for the item.
              const promos = Array.isArray(li.appliedPromotions) ? li.appliedPromotions : []
              const promoRows = promos
                .map((pr: any) => ({ desc: String(pr.description || pr.promotionId || 'Promotion'), amount: Math.round((+pr.discountAmount?.value || 0) * 100) / 100 }))
                .filter((x: any) => x.amount > 0)
              const discount = Math.round(promoRows.reduce((a: number, x: any) => a + x.amount, 0) * 100) / 100

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
              const baseRow: Record<string, unknown> = {
                store_id: storeId, order_id: orderId, line_item_id: lineItemId,
                legacy_item_id: legacyId || null, sku: sku || null, title: li.title || 'eBay sale',
                quantity: qty, sold_price: price, shipping: shipPer,
                sold_at: soldDate, cancelled: isCancelled, part_id: partId,
                updated_at: new Date().toISOString(),
              }
              let { error: upErr } = await sb.from('ebay_sales').upsert(
                { ...baseRow, fulfillment_status: fulfillment, buyer, ship_to: shipTo, discount: discount || null, applied_promotions: promoRows.length ? promoRows : null },
                { onConflict: 'store_id,order_id,line_item_id' })
              // Dispatch columns are additive — if their migration hasn't run yet,
              // fall back so the live sales sync never breaks.
              if (upErr && /column|schema/i.test(upErr.message || '')) {
                ({ error: upErr } = await sb.from('ebay_sales').upsert(baseRow, { onConflict: 'store_id,order_id,line_item_id' }))
              }
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
      await touchLiveSync(storeId, `Live sales check · ${upserted} new`)
      // `created`/`updated` kept for backwards-compatible client display.
      return json({ ok: true, version: EDGE_FN_VERSION, days, ebayOrders: total, lineItems, upserted, linked, created: upserted, updated: linked, skipped: 0, failed, failedReasons, hasMore, nextOffset: offset })
    }

    // ── Historical sales import from an uploaded eBay Orders report (CSV) ─────────
    // The eBay APIs only reach ~90 days; the Seller Hub Orders report exports years.
    // The CLIENT parses the CSV (handles the report's quoting / summary rows / AU$
    // money / DD-Mon-YY dates) and posts batches of normalised sale rows here.
    //
    // DEDUP (per the store's "our records win" policy): the stable cross-source
    // identity of a sale line is (Order Number + Item Number). eBay represents a
    // qty>1 purchase as ONE line (a Quantity field), and the same item number selling
    // to multiple buyers shows as SEPARATE orders — so (order, item) is unique per
    // sale and works for multi-quantity / multi-category listings, not just one-off
    // parts. If we already hold a sale for that (order, item) — from the API sync OR a
    // prior CSV — the row is SKIPPED. The table's unique (store_id, order_id,
    // line_item_id) (line_item_id = the CSV Transaction ID) is the structural backstop.
    //
    // Rows are tagged source='csv_orders_report'. The Orders report has no fee
    // column, so fees = 0 (revenue-accurate, net/margin will read high on old sales).
    // We best-effort link a part by item number but NEVER change a part's status —
    // current inventory stays authoritative.
    if (action === 'import_orders_csv') {
      await requireStoreMember()
      const rows: any[] = Array.isArray(body.rows) ? body.rows : []
      if (!rows.length) return json({ ok: true, version: EDGE_FN_VERSION, inserted: 0, linked: 0, skippedExisting: 0, skippedNoItem: 0 })

      // Normalise; drop rows without an item number (order-summary lines have none).
      const clean = rows
        .map(r => ({
          orderId:    String(r.orderId || '').trim(),
          lineItemId: String(r.lineItemId || r.itemNumber || '').trim(),
          itemNumber: String(r.itemNumber || '').trim(),
          title:      String(r.title || 'eBay sale').trim() || 'eBay sale',
          sku:        r.sku ? String(r.sku).trim() : null,
          quantity:   Math.max(1, Math.floor(+r.quantity || 1)),
          soldPrice:  +r.soldPrice || 0,
          shipping:   +r.shipping || 0,
          soldAt:     r.soldAt || null,
        }))
        .filter(r => r.itemNumber)
      const skippedNoItem = rows.length - clean.length

      // CRITICAL: only import sales OLDER than eBay's getOrders reach (~90 days).
      // Anything newer is owned by the live sync, which re-imports it nightly WITH
      // fees/refunds — importing it from the CSV would create a fee-less record that
      // either blocks enrichment or (if the CSV transaction id ≠ the API line-item id)
      // becomes a duplicate the sync can't reconcile. eBay never returns orders older
      // than this window, so CSV rows below the cutoff can never collide with a future
      // sync — making this safe regardless of whether a sync has run. Rows with an
      // unparseable date are kept (they're almost always old history).
      const cutoffMs = Date.now() - API_WINDOW_DAYS * 86400000
      const eligible = clean.filter(r => !r.soldAt || new Date(r.soldAt).getTime() < cutoffMs)
      const skippedRecent = clean.length - eligible.length
      if (!eligible.length) return json({ ok: true, version: EDGE_FN_VERSION, inserted: 0, linked: 0, skippedExisting: 0, skippedRecent, skippedNoItem })

      const itemNumbers = [...new Set(eligible.map(r => r.itemNumber))]

      // Sales we already hold, keyed (order_id|item_number) — the stable cross-source
      // identity. Skip those (existing records win). Querying by item number uses the
      // (store_id, legacy_item_id) index; the composite match then allows the SAME
      // item number to legitimately sell across multiple orders (multi-qty / GTC).
      const existing = new Set<string>()
      for (let i = 0; i < itemNumbers.length; i += 300) {
        const slice = itemNumbers.slice(i, i + 300)
        const { data } = await sb.from('ebay_sales').select('order_id, legacy_item_id')
          .eq('store_id', storeId).in('legacy_item_id', slice)
        ;(data ?? []).forEach((d: any) => { if (d.legacy_item_id) existing.add(`${d.order_id}|${d.legacy_item_id}`) })
      }

      // Best-effort part link by item number (read-only; never flips part status).
      const partByItem = new Map<string, string>()
      for (let i = 0; i < itemNumbers.length; i += 300) {
        const slice = itemNumbers.slice(i, i + 300)
        const { data } = await sb.from('listings').select('platform_listing_id, part_id')
          .eq('store_id', storeId).eq('platform', 'ebay').in('platform_listing_id', slice)
        ;(data ?? []).forEach((l: any) => { if (l.platform_listing_id && l.part_id) partByItem.set(l.platform_listing_id, l.part_id) })
      }

      const toInsert = eligible
        .filter(r => !existing.has(`${r.orderId || r.itemNumber}|${r.itemNumber}`))
        .map(r => ({
          store_id:       storeId,
          order_id:       r.orderId || r.itemNumber,
          line_item_id:   r.lineItemId || r.itemNumber,
          legacy_item_id: r.itemNumber,
          sku:            r.sku,
          title:          r.title,
          quantity:       r.quantity,
          sold_price:     r.soldPrice,
          shipping:       r.shipping,
          fees:           0,
          sold_at:        r.soldAt,
          cancelled:      false,
          part_id:        partByItem.get(r.itemNumber) || null,
          source:         'csv_orders_report',
          updated_at:     new Date().toISOString(),
        }))

      let inserted = 0, linked = 0
      for (let i = 0; i < toInsert.length; i += 200) {
        const slice = toInsert.slice(i, i + 200)
        const { error } = await sb.from('ebay_sales')
          .upsert(slice, { onConflict: 'store_id,order_id,line_item_id', ignoreDuplicates: true })
        if (error) throw new Error(`csv import: ${error.message}`)
        inserted += slice.length
        linked += slice.filter(s => s.part_id).length
      }

      return json({
        ok: true, version: EDGE_FN_VERSION,
        inserted, linked, skippedExisting: eligible.length - toInsert.length, skippedRecent, skippedNoItem,
      })
    }

    // Apply the historical cost MODEL (value-scaling % + fixed flats, computed
    // client-side from the last 90 days of real sales) to every imported sale, then
    // LOCK so figures can't drift as the rolling average moves. Each row's cost is
    // price-dependent, so the bulk per-row write is done in one SQL statement via the
    // apply_historical_costs() function. Refuses if already locked unless force=true.
    if (action === 'apply_historical_costs') {
      await requireStoreMember()
      const m = body.model || {}
      const now = new Date().toISOString()
      const { data: store } = await sb.from('stores').select('settings').eq('id', storeId).single()
      const settings = store?.settings || {}
      if (settings.historicalCostLock?.locked && !body.force) {
        return json({ error: 'Historical costs are locked. Unlock first to recompute.' }, 409)
      }
      const { data: applied, error: rpcErr } = await sb.rpc('apply_historical_costs', {
        p_store: storeId,
        p_purchase_pct: +m.purchase_pct || 0,
        p_listing_pct:  +m.listing_pct || 0,
        p_promo_pct:    +m.promo_pct || 0,
        p_postage:      +m.postage || 0,
        p_storage:      +m.storage || 0,
        p_admin:        +m.admin || 0,
        p_labour:       +m.labour || 0,
      })
      if (rpcErr) throw new Error(`apply costs: ${rpcErr.message}`)
      const newSettings = { ...settings, historicalCostLock: { locked: true, computedAt: now, model: m } }
      await sb.from('stores').update({ settings: newSettings }).eq('id', storeId)
      return json({ ok: true, version: EDGE_FN_VERSION, applied: applied || 0, computedAt: now, model: m })
    }

    // Lift the lock so the costs can be recomputed. The client warns that this can
    // change historical figures that may already have been used in financials.
    if (action === 'unlock_historical_costs') {
      await requireStoreMember()
      const { data: store } = await sb.from('stores').select('settings').eq('id', storeId).single()
      const settings = store?.settings || {}
      const lock = settings.historicalCostLock || {}
      const newSettings = { ...settings, historicalCostLock: { ...lock, locked: false, unlockedAt: new Date().toISOString() } }
      await sb.from('stores').update({ settings: newSettings }).eq('id', storeId)
      return json({ ok: true, version: EDGE_FN_VERSION, locked: false })
    }

    // eBay selling fees from the Finances API (the ledger eBay's reports are built
    // from). Sums each SALE transaction's total fee per order, then attributes it to
    // that order's part(s) (split by sale price) into costs->>'ebay_fees'. This is
    // what makes net sales / margins match eBay's report — fees are ~24% of sales.
    if (action === 'import_fees') {
      const days = Math.min(+body.days || 120, 365)
      // Explicit fromDate/toDate (used by the full-history fee backfill, which loops
      // 90-day windows) overrides the rolling `days` window. eBay's getTransactions
      // accepts ~90-day ranges, so callers window accordingly.
      const startDate = body.fromDate ? new Date(body.fromDate) : new Date(Date.now() - days * 86400000)
      const endDate   = body.toDate   ? new Date(body.toDate)   : new Date()
      const { token } = await getToken()
      const headers = { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': (await storeMarketplace(sb, storeId)).mp, 'Accept': 'application/json' }
      const dateRange = `transactionDate:[${startDate.toISOString()}..${endDate.toISOString()}]`

      const startedAt = Date.now()
      const feeByOrder: Record<string, number> = {}
      const feeDetailByOrder: Record<string, Record<string, number>> = {} // oid → { FEE_TYPE: amount }
      const refundByOrder: Record<string, number> = {}
      const shipByOrder: Record<string, number> = {}
      let saleFees = 0, otherFees = 0, unattributed = 0, refundTotalAll = 0, shipCostAll = 0

      // Resolve an order id from a transaction: direct field, else its references.
      const orderIdOf = (tx: any): string | undefined =>
        tx.orderId || (tx.references ?? []).find((r: any) => r.referenceType === 'ORDER_ID')?.referenceId

      // eBay's money ledger across four transaction types:
      //   SALE            — final value fee + fixed/intl/regulatory (a cost)
      //   NON_SALE_CHARGE — promoted-listing & other charges (a cost)
      //   REFUND          — money returned to the buyer (reverses revenue)
      //   SHIPPING_LABEL  — label we bought through eBay (a real shipping cost)
      for (const txType of ['SALE', 'NON_SALE_CHARGE', 'REFUND', 'SHIPPING_LABEL']) {
        const filter = `${dateRange},transactionType:{${txType}}`
        let offset = 0, total = 0
        do {
          const url = `https://apiz.ebay.com/sell/finances/v1/transaction?filter=${encodeURIComponent(filter)}&limit=200&offset=${offset}`
          let r = await fetch(url, { headers })
          // The eBay Finances API throws intermittent 5xx (errorId 135000, "eBay
          // internal system problem") — retry a few times before giving up.
          for (let attempt = 0; !r.ok && (r.status >= 500 || r.status === 429) && attempt < 3; attempt++) {
            await new Promise(res => setTimeout(res, 800 * (attempt + 1)))
            r = await fetch(url, { headers })
          }
          if (!r.ok) { const t = await r.text(); throw new Error(`getTransactions ${r.status}: ${t.slice(0, 300)}`) }
          const d = await r.json()
          total = +d.total || 0
          for (const tx of (d.transactions ?? [])) {
            const oid = orderIdOf(tx)
            const amt = +tx.amount?.value || 0
            if (txType === 'SALE') {
              const fee = +tx.totalFeeAmount?.value || 0
              if (!fee) continue
              saleFees += fee
              if (oid) {
                feeByOrder[oid] = (feeByOrder[oid] || 0) + fee
                // Per-type detail from the line items (sums to totalFeeAmount).
                const det = feeDetailByOrder[oid] || (feeDetailByOrder[oid] = {})
                let lineSum = 0
                for (const li of (tx.orderLineItems ?? [])) {
                  for (const mf of (li.marketplaceFees ?? [])) {
                    const a = +mf.amount?.value || 0
                    if (!a) continue
                    const ft = mf.feeType || 'FINAL_VALUE_FEE'
                    det[ft] = (det[ft] || 0) + a; lineSum += a
                  }
                }
                const rem = Math.round((fee - lineSum) * 100) / 100   // any unbroken-down remainder
                if (Math.abs(rem) > 0.005) det.FINAL_VALUE_FEE = (det.FINAL_VALUE_FEE || 0) + rem
              } else unattributed += fee
              // A SALE that was refunded usually credits the final value fee back
              // here as a negative — that nets into feeByOrder automatically.
            } else if (txType === 'NON_SALE_CHARGE') {
              if (!amt) continue
              otherFees += amt
              if (oid) {
                feeByOrder[oid] = (feeByOrder[oid] || 0) + amt
                const det = feeDetailByOrder[oid] || (feeDetailByOrder[oid] = {})
                det.PROMOTION = (det.PROMOTION || 0) + amt
              } else unattributed += amt
            } else if (txType === 'REFUND') {
              if (!amt) continue
              refundTotalAll += amt
              if (oid) refundByOrder[oid] = (refundByOrder[oid] || 0) + amt
            } else if (txType === 'SHIPPING_LABEL') {
              if (!amt) continue
              shipCostAll += amt
              if (oid) shipByOrder[oid] = (shipByOrder[oid] || 0) + amt
            }
          }
          offset += 200
        } while (offset < total && offset < 5000 && Date.now() - startedAt < 60000)
      }

      // dryRun: callers that only need the FVF-vs-promotion split (the historical-cost
      // backfill) read the totals without writing anything back to ebay_sales.
      if (body.dryRun) {
        const r2d = (n: number) => Math.round(n * 100) / 100
        return json({ ok: true, version: EDGE_FN_VERSION, days, dryRun: true,
          saleFees: r2d(saleFees), otherFees: r2d(otherFees), feeTotal: r2d(saleFees + otherFees) })
      }

      // Attribute fee / refund / shipping-cost onto each order's ebay_sales line(s),
      // split by sale price. ebay_sales is the source of truth for the Dashboard P&L.
      const allOrderIds = new Set([...Object.keys(feeByOrder), ...Object.keys(refundByOrder), ...Object.keys(shipByOrder)])
      let updated = 0, ordersMatched = 0, feeTotal = 0
      for (const oid of allOrderIds) {
        const fee    = feeByOrder[oid]    || 0
        const refund = refundByOrder[oid] || 0
        const ship   = shipByOrder[oid]   || 0
        feeTotal += fee
        const { data: sales } = await sb.from('ebay_sales').select('id, sold_price')
          .eq('store_id', storeId).eq('order_id', oid)
        if (!sales?.length) continue
        ordersMatched++
        const totalVal = sales.reduce((a: number, s: any) => a + (+s.sold_price || 0), 0)
        const r2x = (n: number) => Math.round(n * 100) / 100
        const det = feeDetailByOrder[oid] || null
        for (const s of sales) {
          const frac = totalVal > 0 ? (+s.sold_price || 0) / totalVal : 1 / sales.length
          const feeDetailRow = det
            ? Object.fromEntries(Object.entries(det).map(([k, v]) => [k, r2x(v * frac)]).filter(([, v]) => Math.abs(+v) > 0.005))
            : null
          await sb.from('ebay_sales').update({
            fees: r2x(fee * frac),
            refund: r2x(refund * frac),
            ship_cost: r2x(ship * frac),
            refunded: refund > 0,
            fee_detail: feeDetailRow,
            updated_at: new Date().toISOString(),
          }).eq('id', s.id)
          updated++
        }
        if (Date.now() - startedAt > 110000) break
      }

      const r2 = (n: number) => Math.round(n * 100) / 100
      return json({ ok: true, version: EDGE_FN_VERSION, days,
        feeTotal: r2(feeTotal), saleFees: r2(saleFees), otherFees: r2(otherFees), unattributed: r2(unattributed),
        refundTotal: r2(refundTotalAll), shipCostTotal: r2(shipCostAll),
        ordersWithFees: Object.keys(feeByOrder).length, ordersMatched, updated })
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

    // TEMP DEBUG: for a list of item IDs, report whether GetSellerList (the recent
    // supplement) returns them, and what GetItem says. Read-only. Used to diagnose
    // why specific active listings aren't importing. Safe to remove later.

    // Lightweight, frequent "catch new listings" check (pg_cron calls this every
    // 5 min). One GetSellerList call over a short window; imports ONLY listings not
    // already in the DB, reusing the same collision-proof import path via a job +
    // process_chunk self-calls. Read-only on eBay, purely additive in our DB, and
    // a no-op (1 API call) when nothing new has been listed.
    if (action === 'import_recent') {
      const days = Math.min(+body.days || 3, 30)
      const { token, certId } = await getToken()
      const recent = await fetchRecentlyListedIds(token, certId, days)
      if (!recent.length) return json({ ok: true, version: EDGE_FN_VERSION, checked: 0, missing: 0, imported: 0 })

      const { data: have } = await sb.from('listings').select('platform_listing_id')
        .eq('store_id', storeId).eq('platform', 'ebay').in('platform_listing_id', recent)
      const haveSet = new Set((have ?? []).map((l: any) => l.platform_listing_id))
      const missing = recent.filter(id => !haveSet.has(id))
      if (!missing.length) return json({ ok: true, version: EDGE_FN_VERSION, checked: recent.length, missing: 0, imported: 0 })

      const { data: job, error: jobErr } = await sb.from('jobs').insert({
        store_id: storeId, type: 'ebay_import', status: 'running',
        total_items: missing.length, current_item: 'Importing new listings…',
        started_at: new Date().toISOString(),
        meta: { all_item_ids: missing, batch_offset: 0, failed_reasons: {} },
      }).select('id').single()
      if (jobErr) throw new Error(`Failed to create job: ${jobErr.message}`)

      // Drive the existing chunk processor to completion (few items, fast).
      const SELF_URL = `${Deno.env.get('SUPABASE_URL')}/functions/v1/ebay-import`
      let imported = 0, failed = 0, guard = 0
      while (guard++ < 50) {
        const r = await fetch(SELF_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: Deno.env.get('SUPABASE_ANON_KEY')! },
          body: JSON.stringify({ action: 'process_chunk', jobId: job.id, storeId }),
        })
        const c = await r.json()
        if (c.error && c.retry) continue
        if (c.error) throw new Error(c.error)
        imported = c.imported ?? imported
        failed   = c.failed ?? failed
        if (c.isComplete || c.status === 'completed') break
      }
      await touchLiveSync(storeId, `Live listings check · ${imported} new`)
      return json({ ok: true, version: EDGE_FN_VERSION, checked: recent.length, missing: missing.length, imported, failed })
    }

    // ── SIGN IN WITH YOUR PHONE ─────────────────────────────────────────────────
    // Desktop creates a request (gets the polling secret + a human code and shows
    // both in a QR); the signed-in phone approves it, which mints a ONE-TIME
    // magic-link token for the phone's own account; the desktop polls and trades
    // the token for a session. Requests die after 2 minutes, tokens after one read.
    const LOGIN_REQ_TTL_MS = 2 * 60 * 1000
    const loginReqFresh = (r: any) => Date.now() - new Date(r.created_at).getTime() < LOGIN_REQ_TTL_MS

    if (action === 'phone_login_create') {
      // Best-effort prune of stale requests (keeps the table tiny, no cron needed).
      await sb.from('login_requests').delete().lt('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      // Crockford-ish base32, no look-alikes; 8 chars ≈ 40 bits — plenty for a 2-min life.
      const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'
      const buf = new Uint8Array(8); crypto.getRandomValues(buf)
      const code = [...buf].map(b => alphabet[b % alphabet.length]).join('')
      const { data: reqRow, error } = await sb.from('login_requests').insert({ code }).select('id, code').single()
      if (error) throw new Error(`Could not start phone sign-in: ${error.message}`)
      return json({ ok: true, rid: reqRow.id, code: reqRow.code, ttlSeconds: LOGIN_REQ_TTL_MS / 1000 })
    }

    if (action === 'phone_login_approve') {
      // Caller must be a signed-in user (the phone). Approval grants access to the
      // CALLER'S OWN account on the machine showing this code — nothing else.
      const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
      if (!jwt) throw new Error('Sign-in required')
      const { data: u, error: uErr } = await sb.auth.getUser(jwt)
      if (uErr || !u?.user?.email) throw new Error('Sign-in required')

      const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
      if (code.length < 8) throw new Error('Enter the full code shown on the computer')
      const { data: reqRow } = await sb.from('login_requests').select('*').eq('code', code).maybeSingle()
      if (!reqRow || reqRow.status !== 'pending' || !loginReqFresh(reqRow)) {
        throw new Error('That code has expired — start the sign-in on the computer again')
      }

      const { data: link, error: linkErr } = await sb.auth.admin.generateLink({ type: 'magiclink', email: u.user.email })
      const tokenHash = link?.properties?.hashed_token
      if (linkErr || !tokenHash) throw new Error(`Could not approve: ${linkErr?.message || 'no token'}`)

      const { error: upErr } = await sb.from('login_requests')
        .update({ status: 'approved', user_id: u.user.id, token_hash: tokenHash, approved_at: new Date().toISOString() })
        .eq('id', reqRow.id).eq('status', 'pending')
      if (upErr) throw new Error(`Could not approve: ${upErr.message}`)
      return json({ ok: true, email: u.user.email })
    }

    if (action === 'phone_login_poll') {
      const rid = String(body.rid || '')
      if (!rid) throw new Error('Missing request')
      const { data: reqRow } = await sb.from('login_requests').select('*').eq('id', rid).maybeSingle()
      if (!reqRow || reqRow.status === 'cancelled' || (reqRow.status === 'pending' && !loginReqFresh(reqRow))) {
        return json({ ok: true, status: 'expired' })
      }
      if (reqRow.status !== 'approved' || !reqRow.token_hash) return json({ ok: true, status: reqRow.status })
      // Hand the token over exactly once.
      const { data: claimed } = await sb.from('login_requests')
        .update({ status: 'claimed', token_hash: null }).eq('id', rid).eq('status', 'approved')
        .select('id').maybeSingle()
      if (!claimed) return json({ ok: true, status: 'claimed' })
      return json({ ok: true, status: 'approved', tokenHash: reqRow.token_hash })
    }

    // ── SAMPLE (DEMO) DATA ──────────────────────────────────────────────────────
    // A brand-new store has nothing to look at until eBay is connected — so new
    // users can seed a clearly-flagged demo dataset (cars, parts, listings, sales;
    // every row is_sample=true) to explore the whole app with zero personal data,
    // then delete it all in one pass. ebay_sales has no client write policy, so
    // both actions run here under the service role — gated on the caller being a
    // signed-in member of the store.

    if (action === 'seed_sample_data') {
      await requireStoreMember()
      // One demo set per store — re-seeding after a partial explore would duplicate.
      const { data: existing } = await sb.from('parts').select('id')
        .eq('store_id', storeId).eq('is_sample', true).limit(1)
      if (existing?.length) return json({ ok: true, version: EDGE_FN_VERSION, already: true })

      // Buy-in stores don't dismantle cars — seed carless parts (still with
      // fitment) instead of donor vehicles, so the demo matches how they work.
      const carless = String(body.sourcing || '') === 'buyin'

      const day = 24 * 60 * 60 * 1000
      const iso  = (d: number) => new Date(Date.now() - d * day).toISOString()
      const date = (d: number) => iso(d).slice(0, 10)

      let commodore: string | null = null, falcon: string | null = null, hilux: string | null = null
      // Counted here rather than read off carRows below: carRows is block-scoped
      // to the branch, so the summary at the end of this action threw
      // "carRows is not defined" — AFTER every sample row had been inserted.
      // A buy-in store never enters the branch at all, so it failed there too.
      let carCount = 0
      if (!carless) {
        // Three demo donor cars — the Analytics "which car should I buy" story.
        const carRows = [
          { make: 'Holden', model: 'Commodore VE', year: '2012', purchase_price: 850,  purchase_date: date(75), notes: 'Demo donor car — SV6 sedan, hail damage, runs well' },
          { make: 'Ford',   model: 'Falcon FG',    year: '2010', purchase_price: 600,  purchase_date: date(60), notes: 'Demo donor car — XR6, rear-ended, engine strong' },
          { make: 'Toyota', model: 'Hilux',        year: '2015', purchase_price: 1600, purchase_date: date(35), notes: 'Demo donor car — SR dual cab, flood write-off' },
        ].map(c => ({ ...c, store_id: storeId, status: 'active', photos: [], is_sample: true }))
        const { data: cars, error: carErr } = await sb.from('cars').insert(carRows).select('id')
        if (carErr) throw new Error(`Sample cars failed: ${carErr.message}`)
        ;[commodore, falcon, hilux] = (cars ?? []).map((c: any) => c.id)
        carCount = carRows.length
      }

      // Part template: [car, category, subcategory, title, cost, list, status, soldDaysAgo, soldPrice, weightKg, row/bay/shelf]
      // Mix of listed / in-stock / sold so every screen has something to show.
      const P = (car: string | null, category: string, subcategory: string, title: string, make: string, model: string, year: string,
                 acq: number, list: number, status: string, soldD: number | null, soldP: number | null, weight: number | null, loc: string) => ({
        store_id: storeId, is_sample: true, source: 'manual', car_id: carless ? null : car,
        category, subcategory, title, make, model, year,
        // Buy-in demo: parts are bought stock, not pulled from a car. Their
        // acquisition cost is the per-part buy price (not spread from a car).
        condition: carless ? 'Used – Good' : 'Used – Good', status,
        costs: { acquisition: acq, labour: Math.round(acq * 0.3), storage: 0, packaging: 2, postage: 0, holding: 0 },
        list_price: list, sold_price: soldP, sold_date: soldD != null ? date(soldD) : null,
        acquired_date: date(status === 'sold' ? (soldD ?? 10) + 20 : 30), listed_date: status === 'in_stock' ? null : date(status === 'sold' ? (soldD ?? 10) + 18 : 25),
        weight, weight_source: weight != null ? 'manual' : null,
        description: carless
          ? `${title}. Sample data so you can explore PartVault before adding your own stock.`
          : `${title}. Removed from a demo donor vehicle — this is sample data so you can explore PartVault before adding your own parts.`,
        location: loc, photos: [], ai_assessed: false,
      })
      const partRows = [
        // Commodore VE (2012) — good margins, mostly sold: the "buy more of these" car.
        P(commodore, 'Lighting & Bulbs', 'Headlight Assemblies', 'Holden Commodore VE Series II Left Headlight', 'Holden', 'Commodore', '2012', 15, 145, 'sold', 8,  145, 2.1, 'Row 1 · Bay 2 · Shelf 1'),
        P(commodore, 'Lighting & Bulbs', 'Tail Lights',          'Holden Commodore VE Sedan Right Tail Light',   'Holden', 'Commodore', '2012', 10, 89,  'sold', 21, 95,  1.4, 'Row 1 · Bay 2 · Shelf 1'),
        P(commodore, 'Exterior Parts',   'Door Mirrors',         'Holden Commodore VE Right Door Mirror Black',  'Holden', 'Commodore', '2012', 8,  75,  'sold', 33, 70,  0.9, 'Row 1 · Bay 2 · Shelf 2'),
        P(commodore, 'Starters, Alternators & Wiring', 'Alternators', 'Holden Commodore VE 3.6L V6 Alternator',  'Holden', 'Commodore', '2012', 20, 129, 'sold', 45, 120, 5.5, 'Row 1 · Bay 3 · Shelf 1'),
        P(commodore, 'Interior Parts',   'Instrument Clusters',  'Holden Commodore VE SV6 Instrument Cluster',   'Holden', 'Commodore', '2012', 12, 110, 'listed', null, null, 1.2, 'Row 1 · Bay 3 · Shelf 2'),
        P(commodore, 'Engine Cooling',   'Radiators',            'Holden Commodore VE V6 Radiator Auto',         'Holden', 'Commodore', '2012', 18, 95,  'listed', null, null, 4.8, 'Row 1 · Bay 4 · Shelf 1'),
        P(commodore, 'Exterior Parts',   'Grilles',              'Holden Commodore VE SV6 Front Grille',         'Holden', 'Commodore', '2012', 6,  55,  'listed', null, null, 1.1, 'Row 1 · Bay 4 · Shelf 2'),
        P(commodore, 'Interior Parts',   'Seats',                'Holden Commodore VE SV6 Front Seats Pair',     'Holden', 'Commodore', '2012', 30, 280, 'in_stock', null, null, 32,  'Row 4 · Bay 1 · Floor'),
        // Falcon FG (2010) — middling: some sold, slow movers aging on the shelf.
        P(falcon, 'Lighting & Bulbs', 'Headlight Assemblies', 'Ford Falcon FG XR6 Right Headlight',        'Ford', 'Falcon', '2010', 14, 120, 'sold', 15, 110, 2.0, 'Row 2 · Bay 1 · Shelf 1'),
        P(falcon, 'Starters, Alternators & Wiring', 'ECUs',   'Ford Falcon FG 4.0L ECU Engine Computer',   'Ford', 'Falcon', '2010', 25, 165, 'sold', 50, 150, 0.8, 'Row 2 · Bay 1 · Shelf 2'),
        P(falcon, 'Transmission & Drivetrain', 'Driveshafts', 'Ford Falcon FG Rear Driveshaft Sedan',      'Ford', 'Falcon', '2010', 15, 85,  'listed', null, null, 12,  'Row 2 · Bay 2 · Floor'),
        P(falcon, 'Exterior Parts',   'Bumper Bars',          'Ford Falcon FG XR6 Front Bumper Bar Silver','Ford', 'Falcon', '2010', 22, 140, 'listed', null, null, 6.5, 'Row 2 · Bay 3 · Rack'),
        P(falcon, 'Engines & Engine Parts', 'Engine Mounts',  'Ford Falcon FG Engine Mount Pair',          'Ford', 'Falcon', '2010', 8,  49,  'listed', null, null, 2.4, 'Row 2 · Bay 2 · Shelf 3'),
        P(falcon, 'Interior Parts',   'Door Cards',           'Ford Falcon FG Front Door Cards Pair',      'Ford', 'Falcon', '2010', 10, 65,  'in_stock', null, null, 3.1, 'Row 2 · Bay 4 · Shelf 1'),
        P(falcon, 'Brakes & Brake Parts', 'Calipers & Brackets', 'Ford Falcon FG Front Brake Calipers Pair', 'Ford', 'Falcon', '2010', 12, 78, 'in_stock', null, null, 6.8, 'Row 2 · Bay 4 · Shelf 2'),
        // Hilux (2015) — recent buy, high-value parts, mostly still listed: recouping.
        P(hilux, 'Lighting & Bulbs', 'Headlight Assemblies', 'Toyota Hilux SR 2015 Left Headlight Halogen', 'Toyota', 'Hilux', '2015', 25, 195, 'sold', 5, 185, 2.2, 'Row 3 · Bay 1 · Shelf 1'),
        P(hilux, 'Exterior Parts',   'Door Mirrors',         'Toyota Hilux SR Left Door Mirror Chrome',     'Toyota', 'Hilux', '2015', 15, 135, 'sold', 12, 129, 1.0, 'Row 3 · Bay 1 · Shelf 2'),
        P(hilux, 'Exterior Parts',   'Grilles',              'Toyota Hilux 2015 Front Grille Chrome',       'Toyota', 'Hilux', '2015', 18, 149, 'listed', null, null, 2.3, 'Row 3 · Bay 2 · Shelf 1'),
        P(hilux, 'Engine Cooling',   'Radiators',            'Toyota Hilux GUN126 2.8L Radiator',           'Toyota', 'Hilux', '2015', 30, 189, 'listed', null, null, 5.2, 'Row 3 · Bay 2 · Shelf 2'),
        P(hilux, 'Wheels, Tyres & Parts', 'Wheels -- Alloy', 'Toyota Hilux SR5 17in Alloy Wheel Set of 4',  'Toyota', 'Hilux', '2015', 60, 520, 'listed', null, null, 48,  'Row 4 · Bay 2 · Floor'),
        P(hilux, 'Interior Parts',   'Steering Wheels',      'Toyota Hilux 2015 Leather Steering Wheel',    'Toyota', 'Hilux', '2015', 12, 99,  'in_stock', null, null, 1.6, 'Row 3 · Bay 3 · Shelf 1'),
        // Loose stock — no donor car (shows the no-car workflow too).
        P(null, 'Steering & Suspension', 'Shock Absorbers', 'Mazda BT-50 Rear Shock Absorbers Pair New', 'Mazda', 'BT-50', '2018', 35, 129, 'in_stock', null, null, 7.4, 'Row 5 · Bay 1 · Shelf 1'),
      ].map((p, i) => ({ ...p, sku: `DEMO-${String(i + 1).padStart(3, '0')}` }))
      const { data: parts, error: partErr } = await sb.from('parts').insert(partRows).select('id, sku, title, status, list_price, sold_price, sold_date, listed_date')
      if (partErr) throw new Error(`Sample parts failed: ${partErr.message}`)

      // Listings mirror (live for listed, sold for sold) + one sale per sold part.
      // Fake item ids are SAMPLE-… strings — they can never collide with real eBay
      // numeric ids, and no sync runs against them (the store has no eBay account).
      const listingRows: any[] = []
      const saleRows: any[] = []
      let n = 0
      for (const p of parts ?? []) {
        if (p.status !== 'listed' && p.status !== 'sold') continue
        n++
        const itemId = `SAMPLE-${String(n).padStart(3, '0')}`
        const soldAt = p.sold_date ? new Date(p.sold_date + 'T09:30:00Z').toISOString() : null
        listingRows.push({
          store_id: storeId, part_id: p.id, platform: 'ebay', platform_listing_id: itemId,
          platform_sku: p.sku, status: p.status === 'sold' ? 'sold' : 'live',
          list_price: p.list_price, sold_price: p.sold_price, sold_at: soldAt,
          listed_at: p.listed_date ? new Date(p.listed_date + 'T04:00:00Z').toISOString() : null,
          platform_data: { Title: p.title, sample: true }, photos: [], photos_archived: false, is_sample: true,
        })
        if (p.status === 'sold') {
          const ship = n % 3 === 0 ? 0 : 14.5
          saleRows.push({
            store_id: storeId, order_id: `SAMPLE-ORD-${String(n).padStart(3, '0')}`, line_item_id: '1',
            legacy_item_id: itemId, sku: p.sku, title: p.title, quantity: 1,
            sold_price: p.sold_price, shipping: ship,
            fees: Math.round((p.sold_price + ship) * 0.135 * 100) / 100,
            sold_at: soldAt, part_id: p.id, source: 'sample', is_sample: true,
            cancelled: false, refund: 0, ship_cost: ship ? Math.round(ship * 0.8 * 100) / 100 : 0, refunded: false,
          })
        }
      }
      const { error: lErr } = await sb.from('listings').insert(listingRows)
      if (lErr) throw new Error(`Sample listings failed: ${lErr.message}`)
      const { error: sErr } = await sb.from('ebay_sales').insert(saleRows)
      if (sErr) throw new Error(`Sample sales failed: ${sErr.message}`)

      return json({ ok: true, version: EDGE_FN_VERSION, cars: carCount, parts: partRows.length, listings: listingRows.length, sales: saleRows.length })
    }

    if (action === 'remove_sample_data') {
      await requireStoreMember()
      // Children first (photos of sample parts), then the flagged rows themselves.
      const { data: sampleParts } = await sb.from('parts').select('id')
        .eq('store_id', storeId).eq('is_sample', true)
      const ids = (sampleParts ?? []).map((p: any) => p.id)
      for (let i = 0; i < ids.length; i += 100) {
        await sb.from('photos').delete().eq('parent_type', 'part').in('parent_id', ids.slice(i, i + 100))
      }
      const del = async (tbl: string) => {
        const { count, error } = await sb.from(tbl).delete({ count: 'exact' })
          .eq('store_id', storeId).eq('is_sample', true)
        if (error) throw new Error(`Removing sample ${tbl} failed: ${error.message}`)
        return count ?? 0
      }
      const sales = await del('ebay_sales')
      const listings = await del('listings')
      const parts = await del('parts')
      const cars = await del('cars')
      return json({ ok: true, version: EDGE_FN_VERSION, removed: { parts, cars, listings, sales } })
    }

    // ── SHARED BOX-SKU SPLIT ────────────────────────────────────────────────────
    // Historical imports matched listings→parts BY SKU, so a reused custom label
    // (one box label like "SP23" across 30 listings) folded many live listings into
    // ONE part row — and one sale then marked the whole "box" sold while its other
    // listings stayed live on eBay. The import has since been fixed to give every
    // live listing its own part; this action repairs the data it left behind:
    //   • a part with >1 live listing keeps its oldest one, the rest each get a
    //     brand-new part;
    //   • a SOLD part with live listings keeps none of them (the part row IS the
    //     item that sold) — every live listing moves to a new part.
    // New parts get a unique EB-<itemId> store SKU; the shared box label is kept
    // as the part's free-text location (it's a warehouse locator) AND stays on the
    // listing's platform_sku. NOTHING is written to eBay — a listing is only split
    // once GetItem confirms it is still Active; if eBay says it actually ended or
    // sold, we just correct the listing row's status instead (sync drift).
    if (action === 'split_shared_skus') {
      await requireStoreMember()
      await ensureCatLookup()
      const dryRun = !!body.dryRun

      // Everything currently recorded as live, grouped per part. Paginated —
      // PostgREST caps a single select at 1000 rows and there are ~4k live.
      const liveRows: any[] = []
      for (let from = 0; ; from += 1000) {
        const { data: page, error: lErr } = await sb.from('listings')
          .select('id, part_id, platform_listing_id, platform_sku, listed_at')
          .eq('store_id', storeId).eq('platform', 'ebay')
          .in('status', ['live', 'active', 'listed']).is('deleted_at', null)
          .not('part_id', 'is', null).order('id').range(from, from + 999)
        if (lErr) throw new Error(`Live-listing lookup failed: ${lErr.message}`)
        liveRows.push(...(page ?? []))
        if (!page || page.length < 1000) break
      }
      const byPart = new Map<string, any[]>()
      for (const l of liveRows ?? []) {
        if (!byPart.has(l.part_id)) byPart.set(l.part_id, [])
        byPart.get(l.part_id)!.push(l)
      }
      // Which of those parts are sold? Query by STATUS, paginated — an .in() over
      // thousands of part ids overflows the URL and fails, silently reading every
      // part as unsold.
      const soldIds = new Set<string>()
      for (let from = 0; ; from += 1000) {
        const { data: ps, error: psErr } = await sb.from('parts').select('id')
          .eq('store_id', storeId).eq('status', 'sold').range(from, from + 999)
        if (psErr) throw new Error(`Sold-part lookup failed: ${psErr.message}`)
        for (const p of ps ?? []) soldIds.add(p.id)
        if (!ps || ps.length < 1000) break
      }

      // Work list: every live listing that shouldn't be sharing its part.
      const toSplit: any[] = []
      for (const [pid, ls] of byPart) {
        const sold = soldIds.has(pid)
        if (!sold && ls.length <= 1) continue
        ls.sort((a: any, b: any) => String(a.listed_at || '').localeCompare(String(b.listed_at || '')))
        toSplit.push(...(sold ? ls : ls.slice(1)))   // sold part keeps none, else keep the oldest
      }

      if (dryRun) {
        const boxes = [...new Set(toSplit.map(l => l.platform_sku).filter(Boolean))]
        return json({ ok: true, version: EDGE_FN_VERSION, toSplit: toSplit.length,
          parts: byPart.size, boxSkus: boxes.slice(0, 30), boxCount: boxes.length })
      }

      const { token, certId } = await getToken()
      const SOFT_LIMIT_MS = 18 * 1000
      const startedAt = Date.now()
      let split = 0, statusFixed = 0, failed = 0
      const failedReasons: Record<string, string> = {}

      for (const l of toSplit) {
        if (Date.now() - startedAt > SOFT_LIMIT_MS) break
        const itemId = l.platform_listing_id
        try {
          const xml = await trading(token, certId, 'GetItem', `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${itemId}</ItemID><DetailLevel>ReturnAll</DetailLevel>
</GetItemRequest>`)
          if (!xml.includes('<Ack>Success</Ack>') && !xml.includes('<Ack>Warning</Ack>')) {
            throw new Error(getTag(xml, 'LongMessage') || 'eBay API error')
          }

          if (getTag(xml, 'ListingStatus') !== 'Active') {
            // Not actually live any more — our mirror drifted. Correct the listing
            // row only; the sale/end belongs to the part it's already linked to.
            const sold = getTag(xml, 'SellingState') === 'EndedWithSales' || getTag(xml, 'SellingState') === 'Sold'
            await sb.from('listings').update({
              status: sold ? 'sold' : 'ended',
              ended_at: getTag(xml, 'EndTime') || null,
              ...(sold ? { sold_price: parseFloat(getTag(xml, 'ConvertedCurrentPrice') || getTag(xml, 'CurrentPrice')) || null, sold_at: getTag(xml, 'PaidTime') || null } : {}),
            }).eq('id', l.id)
            statusFixed++
            continue
          }

          // Confirmed live → its own part. Unique store SKU; box label → location.
          let newPartId: string | null = null
          for (let attempt = 0; attempt < 4 && !newPartId; attempt++) {
            const candidate = attempt === 0 ? `EB-${itemId}` : `EB-${itemId}-${attempt}`
            const row = { ...buildPartRow(xml, candidate), location: l.platform_sku || null }
            const { data: np, error: pErr } = await sb.from('parts').insert(row).select('id').single()
            if (!pErr) { newPartId = np.id as string; break }
            if (!(pErr.code === '23505' || /parts_sku_store_unique|duplicate key/i.test(pErr.message || ''))) throw pErr
          }
          if (!newPartId) throw new Error('Could not allocate a unique SKU')
          const { error: updErr } = await sb.from('listings').update({ part_id: newPartId }).eq('id', l.id)
          if (updErr) throw updErr
          await syncPhotosForPart(xml, newPartId)
          split++
        } catch (e: any) {
          failed++
          failedReasons[itemId] = (e as Error).message
        }
      }

      const done = split + statusFixed + failed
      return json({ ok: true, version: EDGE_FN_VERSION, split, statusFixed, failed,
        failedReasons, remaining: toSplit.length - done, hasMore: done < toSplit.length })
    }

    // Fill blank make/model (and a missing year) from the part title — one bounded,
    // local pass per call (no eBay calls). Runs as a sync phase so every sync keeps
    // the catalogue's vehicle fields current; newest parts first.
    if (action === 'parse_titles') {
      const mkt = await storeMarketplace(sb, storeId) // regional aliases (Chevy↔Holden)
      const { data: parts } = await sb.from('parts')
        .select('id, title, make, model, year')
        .eq('store_id', storeId).is('deleted_at', null)
        .or('make.is.null,make.eq.,model.is.null,model.eq.')
        .order('created_at', { ascending: false })
        .limit(500)
      const updates: Array<{ id: string; patch: any }> = []
      for (const p of (parts ?? [])) {
        const blankMake = !(p.make || '').trim(), blankModel = !(p.model || '').trim()
        if (!blankMake && !blankModel) continue
        const v = parseVehicle(p.title || '', mkt.mp)
        const patch: any = {}
        if (blankMake && v.make) patch.make = v.make
        if (blankModel && v.model) patch.model = v.model
        if (!(p.year || '').trim() && v.year) patch.year = v.year
        if (Object.keys(patch).length) updates.push({ id: p.id, patch })
      }
      let updated = 0
      for (let i = 0; i < updates.length; i += 25) {
        await Promise.all(updates.slice(i, i + 25).map(({ id, patch }) =>
          sb.from('parts').update(patch).eq('id', id).then(({ error }: any) => { if (!error) updated++ })))
      }
      return json({ ok: true, version: EDGE_FN_VERSION, scanned: (parts ?? []).length, updated })
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

      // Auto-resolve clear-cut stale items: GetItem-classify, then apply —
      //   sold → listing+part 'sold';
      //   ended-unsold / not-found → listing 'ended' + part back to 'in_stock';
      //   still active on eBay (false positive) → just clear the flag.
      // Ambiguous or errored items stay flagged for manual review. Bounded by time +
      // count so a big backlog clears over a few runs instead of timing out.
      let autoSold = 0, autoEnded = 0, autoKept = 0, autoErr = 0
      const resolvedIds = new Set<string>()
      const arStart = Date.now()
      for (const l of (stale as any[])) {
        if (Date.now() - arStart > 45000 || (autoSold + autoEnded + autoKept) >= 150) break
        try {
          const xml = await trading(token, certId, 'GetItem', `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${l.platform_listing_id}</ItemID><DetailLevel>ReturnAll</DetailLevel><IncludeItemSpecifics>false</IncludeItemSpecifics></GetItemRequest>`)
          const ack = getTag(xml, 'Ack'), errCode = getTag(xml, 'ErrorCode'), longMsg = (getTag(xml, 'LongMessage') || '').toLowerCase()
          const notFound = errCode === '17' || errCode === '291' || (ack === 'Failure' && longMsg.includes('not found'))
          if (ack === 'Failure' && !notFound) { autoErr++; continue }   // transient/error → leave flagged
          const sellingState = getTag(xml, 'SellingState'), listingStatus = getTag(xml, 'ListingStatus')
          if (sellingState === 'EndedWithSales' || sellingState === 'Sold') {
            const salePrice = parseFloat(getTag(xml, 'ConvertedCurrentPrice') || getTag(xml, 'CurrentPrice')) || null
            const soldDate  = getTag(xml, 'PaidTime') || getTag(xml, 'EndTime') || null
            await sb.from('listings').update({ status: 'sold', sold_price: salePrice, sold_at: soldDate, reconcile_flagged: false, reconcile_flagged_at: null }).eq('id', l.id)
            if (l.part_id) await sb.from('parts').update({ status: 'sold', ...(salePrice ? { sold_price: salePrice } : {}), ...(soldDate ? { sold_date: soldDate } : {}) }).eq('id', l.part_id)
            autoSold++; resolvedIds.add(l.id)
          } else if (!notFound && (listingStatus === 'Active' || sellingState === 'Active')) {
            await sb.from('listings').update({ reconcile_flagged: false, reconcile_flagged_at: null }).eq('id', l.id)
            autoKept++; resolvedIds.add(l.id)
          } else {  // Ended unsold (or not found on eBay) → part returns to stock
            await sb.from('listings').update({ status: 'ended', reconcile_flagged: false, reconcile_flagged_at: null }).eq('id', l.id)
            if (l.part_id) await sb.from('parts').update({ status: 'in_stock' }).eq('id', l.part_id)
            autoEnded++; resolvedIds.add(l.id)
          }
        } catch { autoErr++ }
      }
      const remainingStale = (stale as any[]).filter(l => !resolvedIds.has(l.id))

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
        autoResolved:    { sold: autoSold, ended: autoEnded, keptActive: autoKept, errors: autoErr },
        staleCount:      remainingStale.length,
        staleListings:   remainingStale.slice(0, 50).map((l: any) => ({
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
      await requireStoreMember()
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
      await requireStoreMember()
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
      await requireStoreMember()
      await ensureCatLookup()
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

    // Cache eBay's OWN category tree for this marketplace: walk the subtree of
    // each of our 16 top-level categories and record every descendant. One pass
    // replaces the hand-written id map, and it's how a category eBay adds next
    // month resolves without a code change. Re-runnable: rows are upserted.
    if (action === 'refresh_category_tree') {
      await requireStoreMember()
      const { token } = await getToken()
      const mkt = await storeMarketplace(sb, storeId)
      const ebayHeaders = {
        'Authorization': `Bearer ${token}`, 'Accept': 'application/json',
        'Content-Language': mkt.lang, 'X-EBAY-C-MARKETPLACE-ID': mkt.mp,
      }
      // Where to start each walk. The store's category_maps rows point at LEAF
      // categories (you can only list into a leaf), so starting there would cache
      // one node and nothing else — the branch above it is what we want. Start
      // from the known branch id where we have one, else from the leaf and climb.
      const listingIds = (await categoryMapFor(sb, mkt.mp)).map
      const starts: Record<string, string> = {}
      for (const friendly of Object.keys(SUB_LISTS)) {
        const id = AU_CATEGORY_FALLBACK[friendly] || listingIds[friendly]
        if (id) starts[friendly] = id
      }

      // Climb to a top-level parts branch (level 3), whose subtree is every
      // category eBay files under it. The response for a node conveniently
      // carries its parent's URL, so climbing is just following that.
      const branchNode = async (startId: string) => {
        let url = `https://api.ebay.com/commerce/taxonomy/v1/category_tree/${mkt.treeId}/get_category_subtree?category_id=${startId}`
        for (let hop = 0; hop < 6; hop++) {
          const r = await fetch(url, { headers: ebayHeaders })
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          const d = await r.json()
          const node = d.categorySubtreeNode
          if (!node) throw new Error('no subtree')
          const level = Number(node.categoryTreeNodeLevel ?? 0)
          if (level <= 3 || !node.parentCategoryTreeNodeHref) return node
          url = node.parentCategoryTreeNodeHref
        }
        throw new Error('could not find the branch')
      }

      const rows: any[] = []
      const failures: Record<string, string> = {}
      const seenRoot = new Set<string>()

      for (const [friendly, startId] of Object.entries(starts)) {
        try {
          const node = await branchNode(String(startId))
          const branchId = String(node.category?.categoryId || startId)
          // Two of our names can climb to the same branch; the first one owns it,
          // otherwise the second pass would overwrite its rows.
          if (seenRoot.has(branchId)) { failures[friendly] = `shares branch ${branchId}`; continue }
          seenRoot.add(branchId)
          if (body.debug) {
            return json({ ok: true, debug: true, friendly, startId, branchId, treeId: mkt.treeId,
              level: node.categoryTreeNodeLevel, name: node.category?.categoryName,
              childCount: (node.childCategoryTreeNodes || []).length })
          }
          flattenSubtree(node, friendly, branchId, rows, mkt.mp)
        } catch (e) { failures[friendly] = (e as Error).message }
      }

      // Second pass: categories this store actually uses that sit OUTSIDE our 16
      // branches — car audio, vehicle electronics, manuals. eBay files them
      // elsewhere in its tree, so no branch walk reaches them, and they'd stay
      // blank forever. Resolve each id on its own and file it under "Other Car &
      // Truck Parts" with eBay's own leaf name as the subcategory: less precise
      // than one of our categories, far better than nothing.
      const known = new Set(rows.map((r: any) => r.category_id))
      const used = new Set<string>()
      for (let from = 0; ; from += 1000) {
        const { data: page } = await sb.from('listings')
          .select('platform_data').eq('store_id', storeId).eq('platform', 'ebay').range(from, from + 999)
        if (!page?.length) break
        for (const l of page) {
          const cid = l.platform_data?.CategoryID?.toString()
          if (cid && !known.has(cid)) used.add(cid)
        }
        if (page.length < 1000) break
      }
      // Anything already cached from an earlier run is fine as it stands.
      if (used.size) {
        const { data: cached } = await sb.from('ebay_category_lookup')
          .select('category_id').eq('marketplace', mkt.mp).in('category_id', [...used])
        for (const c of (cached || [])) used.delete(String(c.category_id))
      }
      let strays = 0
      for (const cid of used) {
        if (strays >= 200) break                     // sanity bound on a one-off pass
        try {
          const r = await fetch(
            `https://api.ebay.com/commerce/taxonomy/v1/category_tree/${mkt.treeId}/get_category_subtree?category_id=${cid}`,
            { headers: ebayHeaders })
          if (!r.ok) continue
          const d = await r.json()
          const name = d?.categorySubtreeNode?.category?.categoryName
          if (!name) continue
          rows.push({
            marketplace: mkt.mp, category_id: String(cid),
            friendly_category: 'Other Car & Truck Parts',
            leaf_name: name, subcategory: name, root_id: null,
            updated_at: new Date().toISOString(),
          })
          strays++
        } catch (_) { /* skip this id, keep going */ }
      }

      let saved = 0
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await sb.from('ebay_category_lookup')
          .upsert(rows.slice(i, i + 500), { onConflict: 'marketplace,category_id' })
        if (error) throw new Error(`Could not save the category tree: ${error.message}`)
        saved += Math.min(500, rows.length - i)
      }
      return json({
        ok: true, version: EDGE_FN_VERSION, marketplace: mkt.mp,
        categories: Object.keys(starts).length, branches: seenRoot.size, strays, saved,
        failures: Object.keys(failures).length ? failures : undefined,
      })
    }

    // Fill in categories from what eBay says. Blanks only by default — a category
    // a person set (or corrected) is never overwritten unless `force` is passed,
    // because that would silently undo their work AND the eBay-category learning
    // that keys off it. Time-boxed: returns hasMore so the caller can continue.
    if (action === 'backfill_categories') {
      await requireStoreMember()
      const startTime = Date.now()
      const force = !!body.force          // re-read EVERY part from eBay, overwriting
      await ensureCatLookup()

      // Paged: PostgREST caps a select at 1000 rows and there are thousands.
      const targets: any[] = []
      for (let from = 0; ; from += 1000) {
        let q = sb.from('parts').select('id, category, subcategory')
          .eq('store_id', storeId).is('deleted_at', null).range(from, from + 999)
        if (!force) q = q.or('category.is.null,category.eq.,subcategory.is.null,subcategory.eq.')
        const { data: page } = await q
        if (!page?.length) break
        targets.push(...page)
        if (page.length < 1000) break
      }
      if (!targets.length) return json({ updated: 0, noData: 0, hasMore: false })

      const byId = new Map(targets.map((p: any) => [p.id, p]))
      const ids = targets.map((p: any) => p.id)

      // eBay's category id for each part, from the listing rows the sync stores.
      const partToCategoryId: Record<string, string> = {}
      for (let i = 0; i < ids.length; i += 200) {
        const { data: listings } = await sb.from('listings')
          .select('part_id, platform_data')
          .eq('store_id', storeId).eq('platform', 'ebay').in('part_id', ids.slice(i, i + 200))
        for (const l of (listings || [])) {
          const catId = l.platform_data?.CategoryID?.toString()
          if (catId && !partToCategoryId[l.part_id]) partToCategoryId[l.part_id] = catId
        }
      }

      // Group parts by the exact patch they need, so each group is one update.
      const groups: Record<string, { patch: any; ids: string[] }> = {}
      let noData = 0, unmapped = 0
      for (const partId of ids) {
        const catId = partToCategoryId[partId]
        if (!catId) { noData++; continue }
        const hit = CAT_LOOKUP.get(String(catId))
        const category = hit?.category || CATEGORY_ID_MAP[String(catId)]
        if (!category) { unmapped++; continue }
        const cur = byId.get(partId) || {}
        const patch: any = {}
        if (force || !String(cur.category || '').trim()) patch.category = category
        if (hit?.subcategory && (force || !String(cur.subcategory || '').trim())) patch.subcategory = hit.subcategory
        if (!Object.keys(patch).length) continue
        const key = JSON.stringify(patch)
        if (!groups[key]) groups[key] = { patch, ids: [] }
        groups[key].ids.push(partId)
      }

      let updated = 0
      for (const { patch, ids: partIds } of Object.values(groups)) {
        if (Date.now() - startTime > 20000) return json({ updated, noData, unmapped, hasMore: true })
        for (let j = 0; j < partIds.length; j += 500) {
          await sb.from('parts').update(patch).in('id', partIds.slice(j, j + 500))
          updated += Math.min(500, partIds.length - j)
        }
      }

      // Parts whose listing row never captured a CategoryID (older sold-order
      // imports built their listing rows without one) can't be resolved from
      // what we hold, so ask eBay for the item itself. Batched 20 at a time,
      // time-boxed like everything else here, and it fills the listing row too
      // so the next run needs no calls at all.
      let fetched = 0, legacy = 0
      if (body.fetchMissing !== false && Date.now() - startTime < 12000) {
        const missing = ids.filter(id => !partToCategoryId[id])
        if (missing.length) {
          const { data: rows } = await sb.from('listings')
            .select('id, part_id, platform_listing_id, platform_data')
            .eq('store_id', storeId).eq('platform', 'ebay').in('part_id', missing.slice(0, 400))
          const withItem = (rows || []).filter((l: any) => l.platform_listing_id)
          // Trading API GetItem, not the Shopping API: open.api.ebay.com's
          // GetMultipleItems returns nothing for these — eBay has wound the legacy
          // Shopping API down — which is part of why they were never filled in.
          const { token, certId } = await getToken()
          for (const l of withItem) {
            if (Date.now() - startTime > 18000) return json({ updated, noData, unmapped, fetched, legacy, hasMore: fetched + legacy > 0 })
            let catId = '', gone = false
            try {
              const xml = await trading(token, certId, 'GetItem', `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${l.platform_listing_id}</ItemID><DetailLevel>ReturnAll</DetailLevel>
</GetItemRequest>`)
              catId = getTag(xml, 'CategoryID')
              if (!catId && /deleted|cannot be accessed|not found/i.test(getTag(xml, 'LongMessage'))) gone = true
            } catch (e) {
              if (/deleted|cannot be accessed|not found/i.test((e as Error).message)) gone = true
            }
            // eBay has purged the listing, so its real category is unrecoverable.
            // File it under Legacy Items — the bucket the history import already
            // uses for records with no detail — rather than leaving it blank and
            // looking like a mapping gap we could still close.
            if (!catId && gone) {
              await sb.from('parts').update({ category: 'Legacy Items', subcategory: 'Other' }).eq('id', l.part_id)
              legacy++
              continue
            }
            if (!catId) continue
            const hit = CAT_LOOKUP.get(catId)
            const category = hit?.category || CATEGORY_ID_MAP[catId]
            await sb.from('listings')
              .update({ platform_data: { ...(l.platform_data || {}), CategoryID: catId } }).eq('id', l.id)
            if (!category) { unmapped++; continue }
            const patch: any = { category }
            if (hit?.subcategory) patch.subcategory = hit.subcategory
            await sb.from('parts').update(patch).eq('id', l.part_id)
            updated++; fetched++
          }
        }
      }

      return json({ updated, noData, unmapped, fetched, legacy, hasMore: false, treeCached: CAT_LOOKUP.size })
    }

    // Resolve the store's eBay merchant (ship-from) location. eBay's Inventory API
    // won't accept a listing without one. If eBay has none registered yet, create
    // PARTVAULT_MAIN from the store's SAVED ship-from address (settings.shipAddress)
    // so a first-time list doesn't dead-end at "no inventory location". Returns the
    // key, or null when there's no saved address to create one from.
    const ensureMerchantLocation = async (ebayHeaders: Record<string, string>, existingKey: string | undefined): Promise<string | null> => {
      if (existingKey) return existingKey
      const { data: sRow } = await sb.from('stores').select('settings').eq('id', storeId).single()
      const a = sRow?.settings?.shipAddress
      if (!(a && a.addressLine1 && a.city && a.postalCode && a.country)) return null
      const key = 'PARTVAULT_MAIN'
      const exist = await fetch(`https://api.ebay.com/sell/inventory/v1/location/${key}`, { headers: ebayHeaders })
      if (exist.ok) return key
      const payload = {
        location: { address: { addressLine1: a.addressLine1, city: a.city, stateOrProvince: a.stateOrProvince || '', postalCode: a.postalCode, country: String(a.country).toUpperCase() } },
        name: 'PartVault Main', merchantLocationStatus: 'ENABLED', locationTypes: ['WAREHOUSE'],
      }
      const res = await fetch(`https://api.ebay.com/sell/inventory/v1/location/${key}`, { method: 'POST', headers: ebayHeaders, body: JSON.stringify(payload) })
      if (res.ok || res.status === 204) return key
      const e = await res.json().catch(() => ({}))
      throw new Error(`Could not create your eBay ship-from location from the saved address (${e.errors?.[0]?.message || res.status}). Check Settings → eBay Inventory Location.`)
    }

    if (action === 'create_draft_listings') {
      await requireStoreMember()
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

      // requireMarketplace, not storeMarketplace: this path SENDS to eBay, and a
      // read we could not complete must not be answered with a guessed country
      // and currency. See the note at the top of ./ebay/marketplace.ts.
      const mkt = await requireMarketplace(sb, storeId)
      const ebayHeaders = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Language': mkt.lang,
        'Content-Language': mkt.lang,
        'X-EBAY-C-MARKETPLACE-ID': mkt.mp,
      }

      // Fetch account policies and location (use first of each)
      const [fpRes, ppRes, rpRes, locRes] = await Promise.all([
        fetch(`https://api.ebay.com/sell/account/v1/fulfillment_policy?marketplace_id=${mkt.mp}`, { headers: ebayHeaders }),
        fetch(`https://api.ebay.com/sell/account/v1/payment_policy?marketplace_id=${mkt.mp}`, { headers: ebayHeaders }),
        fetch(`https://api.ebay.com/sell/account/v1/return_policy?marketplace_id=${mkt.mp}`, { headers: ebayHeaders }),
        fetch('https://api.ebay.com/sell/inventory/v1/location', { headers: ebayHeaders }),
      ])
      const [fpData, ppData, rpData, locData] = await Promise.all([fpRes.json(), ppRes.json(), rpRes.json(), locRes.json()])

      const fulfillmentPolicyId  = fpData.fulfillmentPolicies?.[0]?.fulfillmentPolicyId
      const paymentPolicyId      = ppData.paymentPolicies?.[0]?.paymentPolicyId
      const returnPolicyId       = rpData.returnPolicies?.[0]?.returnPolicyId
      if (!fulfillmentPolicyId) throw new Error('No fulfillment policy on eBay account — set one up in eBay Seller Hub first')
      if (!paymentPolicyId)     throw new Error('No payment policy on eBay account — set one up in eBay Seller Hub first')
      if (!returnPolicyId)      throw new Error('No return policy on eBay account — set one up in eBay Seller Hub first')
      const merchantLocationKey = await ensureMerchantLocation(ebayHeaders, locData.locations?.[0]?.merchantLocationKey)
      if (!merchantLocationKey) throw new Error('No ship-from address saved — add it in Settings → eBay Inventory Location, then list again (it is created on eBay automatically).')

      const CONDITION_MAP: Record<string, string> = {
        'Used – Excellent': 'USED_EXCELLENT',
        'Used – Good':      'USED_EXCELLENT',
        'Used – Fair':      'USED_EXCELLENT',
        'For Parts Only':   'FOR_PARTS_OR_NOT_WORKING',
        'Refurbished':      'SELLER_REFURBISHED',
      }

      // Resolved per the store's marketplace (category_maps; AU fallback).
      const CATEGORY_ID = (await categoryMapFor(sb, mkt.mp)).map

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
              marketplaceId: mkt.mp,
              format: 'FIXED_PRICE',
              listingDescription: part.notes || part.title,
              pricingSummary: { price: { value: String(part.list_price), currency: mkt.currency } },
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
      // Price research must be LOCAL to the store's marketplace — AU comparables
      // are meaningless for a US/UK store (different market, different currency).
      const mktLookup = await storeMarketplace(sb, storeId)
      const headers = { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': mktLookup.mp, 'Content-Type': 'application/json' }

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
      // Market pricing must be local to the store's marketplace.
      const headers = { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': (await storeMarketplace(sb, storeId)).mp, 'Content-Type': 'application/json' }
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

    if (action === 'category_aspects') {
      // Return the full item-aspect (item specifics) definition for a friendly
      // category — used by the bulk Specifics editor to render its fields.
      const authHeader = req.headers.get('Authorization') || ''
      const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
      const { data: member } = await userClient.rpc('is_store_member', { p_store_id: storeId })
      if (!member) return json({ error: 'Not authorised' }, 403)

      const category = body.category || ''
      const { token } = await getToken()
      const mkt = await storeMarketplace(sb, storeId)
      const ebayHeaders = {
        'Authorization': `Bearer ${token}`, 'Accept': 'application/json',
        'Content-Language': mkt.lang, 'X-EBAY-C-MARKETPLACE-ID': mkt.mp,
      }
      const map = (await categoryMapFor(sb, mkt.mp)).map
      const categoryId = map[category] || '9886'
      const categoryTreeId = mkt.treeId
      let specs: any[] = []
      try {
        const aRes = await fetch(`https://api.ebay.com/commerce/taxonomy/v1/category_tree/${categoryTreeId}/get_item_aspects_for_category?category_id=${categoryId}`, { headers: ebayHeaders })
        if (aRes.ok) {
          const aData = await aRes.json()
          specs = (aData.aspects || []).map((a: any) => ({
            name: a.localizedAspectName,
            required: !!a.aspectConstraint?.aspectRequired,
            mode: a.aspectConstraint?.aspectMode || 'FREE_TEXT',            // FREE_TEXT | SELECTION_ONLY
            multi: a.aspectConstraint?.itemToAspectCardinality === 'MULTI',
            allowed: (a.aspectValues || []).map((v: any) => v.localizedValue).filter(Boolean).slice(0, 200),
          })).filter((s: any) => s.name)
        }
      } catch (_) { /* return empty on taxonomy hiccup */ }
      return json({ ok: true, version: EDGE_FN_VERSION, categoryId, specs })
    }

    if (action === 'apply_specifics') {
      // Bulk-set item specifics across selected parts. Always writes the value as
      // a manual override (parts.ebay_overrides.specifics) so it's authoritative
      // on the next publish/preview. Optionally pushes to CURRENTLY LIVE listings
      // via Trading ReviseItem (best-effort, per-item errors collected).
      const authHeader = req.headers.get('Authorization') || ''
      const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
      const partIds: string[] = Array.isArray(body.partIds) ? body.partIds : []
      const setVals: Record<string, string> = body.set || {}   // { aspectName: value }  ('' = clear)
      // HARD BLOCK: never push to live listings, whatever the caller asks for.
      // Local overrides still save and apply on the NEXT publish.
      const pushLive = ALLOW_LIVE_EBAY_EDITS && !!body.pushLive
      if (!partIds.length) return json({ error: 'No parts selected' }, 400)
      if (!Object.keys(setVals).length) return json({ error: 'No specifics to set' }, 400)

      const { data: canEdit } = await userClient.rpc('has_permission', { p_store_id: storeId, p_capability: 'add_edit' })
      if (!canEdit) return json({ error: 'Not authorised' }, 403)
      if (pushLive) {
        const { data: canPub } = await userClient.rpc('has_permission', { p_store_id: storeId, p_capability: 'publish' })
        if (!canPub) return json({ error: 'Updating live eBay listings needs the publish permission' }, 403)
      }

      const { data: parts } = await sb.from('parts').select('id, ebay_overrides').eq('store_id', storeId).in('id', partIds)
      let updated = 0
      for (const p of (parts || [])) {
        const ov = p.ebay_overrides || {}
        const spec: Record<string, string> = { ...(ov.specifics || {}) }
        for (const [k, v] of Object.entries(setVals)) spec[k] = v as string
        const { error: uErr } = await sb.from('parts').update({ ebay_overrides: { ...ov, specifics: spec } }).eq('id', p.id)
        if (!uErr) updated++
      }

      let pushed = 0
      const failed: any[] = []
      if (pushLive) {
        const xesc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        const { token, certId } = await getToken()
        const { data: live } = await sb.from('listings')
          .select('part_id, platform_listing_id').eq('store_id', storeId)
          .in('part_id', partIds).in('status', ['active', 'live']).is('deleted_at', null)
        for (const l of (live || [])) {
          const itemId = l.platform_listing_id
          if (!itemId) continue
          try {
            // Merge onto the listing's CURRENT specifics (ReviseItem replaces the
            // whole ItemSpecifics container, so we must send the full set).
            const gx = await trading(token, certId, 'GetItem',
              `<?xml version="1.0" encoding="utf-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${itemId}</ItemID><DetailLevel>ReturnAll</DetailLevel></GetItemRequest>`)
            const merged: Record<string, string> = extractItemSpecifics(gx)
            for (const [k, v] of Object.entries(setVals)) { if (v === '' || v == null) delete merged[k]; else merged[k] = v as string }
            const nvl = Object.entries(merged).filter(([, v]) => v != null && v !== '')
              .map(([k, v]) => `<NameValueList><Name>${xesc(k)}</Name><Value>${xesc(String(v))}</Value></NameValueList>`).join('')
            const rx = await trading(token, certId, 'ReviseItem',
              `<?xml version="1.0" encoding="utf-8"?><ReviseItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><Item><ItemID>${itemId}</ItemID><ItemSpecifics>${nvl}</ItemSpecifics></Item></ReviseItemRequest>`)
            if (getTag(rx, 'Ack') === 'Failure') { failed.push({ item: itemId, error: getTag(rx, 'LongMessage') || 'ReviseItem failed' }); continue }
            pushed++
          } catch (e) { failed.push({ item: itemId, error: (e as Error).message }) }
        }
      }
      return json({ ok: true, version: EDGE_FN_VERSION, updated, pushed, failed })
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
      // Fill blank make/model/year from the donor car so fitment/compatibility
      // work for imported parts (matches publish).
      await hydrateVehicleFromCar(sb, part)
      // Reflect the editor's current (possibly unsaved) values so the preview
      // matches what's on screen — no need to save first.
      if (typeof body.title === 'string' && body.title) part.title = body.title
      if (body.price != null && body.price !== '') part.list_price = +body.price || 0
      if (typeof body.condition === 'string' && body.condition) part.condition = body.condition
      if (typeof body.description === 'string') part.description = body.description

      const { token } = await getToken()
      const mkt = await storeMarketplace(sb, storeId)
      const ebayHeaders = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Language': mkt.lang,
        'Content-Language': mkt.lang,
        'X-EBAY-C-MARKETPLACE-ID': mkt.mp,
      }
      const PREVIEW_CATEGORY_ID = (await categoryMapFor(sb, mkt.mp)).map
      // Tree id per marketplace (US = eBay Motors tree 100 — its default tree has no vehicle parts).
      const categoryTreeId = mkt.treeId
      // Store config (same as publish): footer, shipping, best offer, image mix,
      // category learning. Loaded up front so category resolution can use it.
      const { data: storeRow } = await sb.from('stores').select('settings').eq('id', storeId).single()
      const settings = storeRow?.settings || {}

      // Category resolution priority: per-part override → learned (Part-type smart)
      // → live eBay Taxonomy suggestion → internal-category map → hard fallback.
      const catQuery = [part.make, part.model, part.year, part.category, part.title].filter(Boolean).join(' ')
      const ovCat = part.ebay_overrides || {}
      let categoryId = ''
      let categoryName = ''
      let categorySource = 'ai' // override | learned | ai | fallback
      if (ovCat.categoryId) {
        categoryId = String(ovCat.categoryId); categoryName = String(ovCat.categoryName || ''); categorySource = 'override'
      }
      if (!categoryId) {
        const L = learnedCategoryFor(settings, part)
        if (L) { categoryId = L.id; categoryName = L.name; categorySource = 'learned' }
      }
      if (!categoryId) {
        categoryId = PREVIEW_CATEGORY_ID[part.category] || '9886'; categorySource = 'fallback'
        try {
          const r = await fetch(`https://api.ebay.com/commerce/taxonomy/v1/category_tree/${categoryTreeId}/get_category_suggestions?q=${encodeURIComponent(catQuery || 'car part')}`, { headers: ebayHeaders })
          if (r.ok) {
            const d = await r.json()
            const sug = d.categorySuggestions?.[0]
            if (sug?.category?.categoryId) {
              categoryId = sug.category.categoryId
              const anc = (sug.categoryTreeNodeAncestors || []).map((a: any) => a.categoryName).reverse()
              categoryName = [...anc, sug.category.categoryName].filter(Boolean).join(' › ')
              categorySource = 'ai'
            }
          }
        } catch (_) { /* fallback id */ }
      }

      const { data: phRows } = await sb.from('photos').select('url, ebay_url, is_primary, display_order').eq('parent_type', 'part').eq('parent_id', partId).order('is_primary', { ascending: false }).order('display_order', { ascending: true })
      let partUrls = (phRows || []).map((r: any) => r.url || r.ebay_url).filter(Boolean)
      if (!partUrls.length) partUrls = (part.photos || []).map((p: any) => { if (p && typeof p === 'object') return p.url || p.ebay_url; try { const o = JSON.parse(p); return o.url || o.ebay_url || p } catch { return p } }).filter(Boolean)
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

      const { aspects, fitmentList, specs } = await fillAspects(part, categoryId, categoryTreeId, ebayHeaders, partUrls.slice(0, 2), settings.listingDefaults || {}, { provider: settings.aiModels?.specifics?.provider ?? settings.specificsProvider ?? 'gemini', model: settings.aiModels?.specifics?.model, sb, storeId, partId })
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

      const conditionDescription = String(part.condition_description || settings.listingDefaults?.conditionDescription || '').trim().slice(0, 1000)

      const result: any = {
        ok: true, categoryId, categoryName, categorySource, specifics, fitment: fitmentList,
        title: part.title, description, photos,
        price: +part.list_price || 0, condition: part.condition || 'Used – Good',
        conditionDescription,
        hasFooter: !!(settings.footer && settings.footer.trim()),
        allowOffers: !!settings.allowOffers,
        weightG, dims: { l: dimL, w: dimW, h: dimH },
      }

      // Persist the FULL preview on EVERY build (not just the background queue's
      // persist:true), so a manual preview is cached too — "build once, instant
      // after" instead of rebuilding every open. The panel only trusts the cache
      // while its inputs still match the sig below. Generated baseline only;
      // ebay_overrides (user corrections) still win at publish.
      if (partId) {
        const sig = JSON.stringify({ t: part.title || '', p: +part.list_price || 0, c: part.condition || '', d: part.description || '', ov: part.ebay_overrides || null })
        // Report whether the save actually landed — a missing ebay_specifics column
        // (migration not yet run) surfaces as persisted:false so the background queue
        // can stop retrying and tell the user to run the migration instead of spinning.
        const { error: persErr } = await sb.from('parts').update({ ebay_specifics: { ...result, sig, generated_at: new Date().toISOString() } }).eq('id', partId).eq('store_id', storeId)
        result.persisted = !persErr
        if (persErr) result.persistError = persErr.message
      }

      return json(result)
    }

    // Search eBay's live category tree so the user can correct a wrong category.
    if (action === 'category_suggestions') {
      await requireStoreMember()
      const q = String(body.query || '').trim()
      if (!q) return json({ suggestions: [] })
      const { token } = await getToken()
      const mkt = await storeMarketplace(sb, storeId)
      const headers = {
        'Authorization': `Bearer ${token}`, 'Accept': 'application/json',
        'Accept-Language': mkt.lang, 'Content-Language': mkt.lang, 'X-EBAY-C-MARKETPLACE-ID': mkt.mp,
      }
      try {
        const r = await fetch(`https://api.ebay.com/commerce/taxonomy/v1/category_tree/${mkt.treeId}/get_category_suggestions?q=${encodeURIComponent(q)}`, { headers })
        if (!r.ok) return json({ suggestions: [], error: `eBay ${r.status}` })
        const d = await r.json()
        const suggestions = (d.categorySuggestions || []).slice(0, 12).map((s: any) => {
          const anc = (s.categoryTreeNodeAncestors || []).map((a: any) => a.categoryName).reverse()
          return { id: s.category?.categoryId, name: [...anc, s.category?.categoryName].filter(Boolean).join(' › ') }
        }).filter((s: any) => s.id)
        return json({ suggestions })
      } catch (e: any) { return json({ suggestions: [], error: String(e?.message || e) }) }
    }

    // Set (or clear) a part's eBay-category override and, when set, LEARN it for
    // future parts of the same type ("Part type (smart)").
    if (action === 'set_category') {
      const authHeader = req.headers.get('Authorization') || ''
      const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
      const { data: allowedCat } = await userClient.rpc('has_permission', { p_store_id: storeId, p_capability: 'publish' })
      if (!allowedCat) return json({ error: 'You do not have permission to change listing categories for this store' }, 403)

      const partId = String(body.partId || '')
      if (!partId) throw new Error('partId required')
      const catId = String(body.categoryId || '').trim()
      const catName = String(body.categoryName || '').trim()
      const learn = body.learn !== false

      const { data: part, error: pErr } = await sb.from('parts').select('id, category, subcategory, make, model, title, part_number, ebay_overrides').eq('id', partId).eq('store_id', storeId).single()
      if (pErr || !part) throw new Error('Part not found')

      // Per-part override: set, or clear (reset to AI) when no categoryId given.
      const ov: any = { ...(part.ebay_overrides || {}) }
      if (catId) { ov.categoryId = catId; ov.categoryName = catName } else { delete ov.categoryId; delete ov.categoryName }
      await sb.from('parts').update({ ebay_overrides: ov }).eq('id', partId)

      // Learn for future parts with the same category key (read-merge-write settings).
      let learnedKey = ''
      if (catId && learn) {
        learnedKey = categoryKeyFor(part)
        // The read has to be checked before the write. supabase-js does not
        // throw, so on a failed read `settings` would be {} and this update
        // would replace the store's ENTIRE configuration — marketplace,
        // listing defaults, AI models, labels, the lot — with nothing but
        // categoryLearning. Learning a category is the least important thing
        // this function does; skipping it costs one correction, and it is a
        // correction the user can make again.
        const { data: sRow, error: sErr } = await sb.from('stores').select('settings').eq('id', storeId).single()
        if (sErr || !sRow) {
          console.warn(`category learning skipped for store ${storeId}: could not read settings — ${sErr?.message || 'no row'}`)
          learnedKey = ''
        } else {
          const settings = sRow.settings || {}
          const map = { ...(settings.categoryLearning || {}) }
          map[learnedKey] = { id: catId, name: catName, at: new Date().toISOString() }
          const { error: uErr } = await sb.from('stores').update({ settings: { ...settings, categoryLearning: map } }).eq('id', storeId)
          if (uErr) {
            console.warn(`category learning not saved for store ${storeId}: ${uErr.message}`)
            learnedKey = ''
          }
        }
      }
      return json({ ok: true, categoryId: catId, categoryName: catName, ebay_overrides: ov, learnedKey })
    }

    // ── SKU RECONCILE (eBay = source of truth) ─────────────────────────────
    // Austin lists a batch with ONE placeholder custom label, then fixes each
    // label on eBay when he shelves the item. Our sync SKIPS listings it already
    // knows, so those corrections never landed — hence the drift + EB-<itemId>
    // fallbacks. This re-reads the CURRENT label from eBay per live listing.
    // READ-ONLY: fetches from eBay, writes NOTHING (here or on eBay). Paged, so
    // the caller loops with nextOffset until hasMore is false, then classifies.
    if (action === 'sku_reconcile_report') {
      await requireStoreMember()
      const { token, certId } = await getToken()
      const offset = +body.offset || 0
      const LIMIT = 30
      // The caller passes ONLY the parts whose SKU looks auto-generated — one
      // eBay GetItem per listing burns the Trading API daily quota, so we never
      // re-check the thousands of listings that are already correct.
      const only: string[] = Array.isArray(body.partIds) ? body.partIds : []
      if (!only.length) return json({ error: 'partIds required — refusing to scan every listing (eBay API quota)' }, 400)
      let lq = sb.from('listings')
        .select('platform_listing_id, platform_sku, part_id')
        .eq('store_id', storeId).eq('platform', 'ebay').in('status', ['live', 'active'])
        .is('deleted_at', null)
        .in('part_id', only)
        .order('platform_listing_id', { ascending: true })
        .range(offset, offset + LIMIT - 1)
      const { data: ls, error: lErr } = await lq
      if (lErr) throw lErr
      const partIds = [...new Set((ls || []).map((l: any) => l.part_id).filter(Boolean))]
      const { data: ps } = partIds.length
        ? await sb.from('parts').select('id, sku, title, status').in('id', partIds)
        : { data: [] as any[] }
      const partById = new Map((ps || []).map((p: any) => [p.id, p]))

      const rows: any[] = []
      for (const l of (ls || [])) {
        const part = partById.get(l.part_id)
        if (!part) continue
        let ebaySku = ''
        let err = ''
        try {
          const xml = await trading(token, certId, 'GetItem', `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${l.platform_listing_id}</ItemID><DetailLevel>ReturnAll</DetailLevel></GetItemRequest>`)
          if (getTag(xml, 'Ack') === 'Failure') err = getTag(xml, 'LongMessage') || 'GetItem failed'
          else ebaySku = (getTag(xml, 'SKU') || '').trim()
        } catch (e: any) { err = String(e?.message || e).slice(0, 120) }
        rows.push({
          partId: part.id, itemId: l.platform_listing_id, title: part.title,
          currentSku: part.sku || '', ebaySku, storedPlatformSku: l.platform_sku || '', error: err,
        })
      }
      const { count } = await sb.from('listings').select('id', { count: 'exact', head: true })
        .eq('store_id', storeId).eq('platform', 'ebay').in('status', ['live', 'active']).is('deleted_at', null)
        .in('part_id', only)
      const nextOffset = offset + LIMIT
      return json({ ok: true, version: EDGE_FN_VERSION, rows, total: count || 0, hasMore: nextOffset < (count || 0), nextOffset })
    }

    // Apply ONLY the rows the user reviewed. Local write to parts.sku (+ the
    // listing's platform_sku mirror). NEVER touches eBay. Two-phase rename so a
    // swap can't transiently violate parts_sku_store_unique; full rollback on
    // failure. Every change is captured by the parts audit trigger (old→new).
    if (action === 'sku_reconcile_apply') {
      const authHeader = req.headers.get('Authorization') || ''
      const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
      const { data: mayEdit } = await userClient.rpc('has_permission', { p_store_id: storeId, p_capability: 'publish' })
      if (!mayEdit) return json({ error: 'You do not have permission to reconcile SKUs for this store' }, 403)

      const updates: { partId: string; newSku: string }[] = Array.isArray(body.updates) ? body.updates : []
      if (!updates.length) return json({ error: 'No updates supplied' }, 400)

      // Guard: no blank targets, no duplicate targets within the batch.
      const seen = new Set<string>()
      for (const u of updates) {
        const s = String(u.newSku || '').trim()
        if (!s) return json({ error: `Blank target SKU for part ${u.partId} — refused` }, 400)
        if (seen.has(s)) return json({ error: `Duplicate target SKU "${s}" in this batch — refused (Austin has not shelved these yet)` }, 400)
        seen.add(s)
      }
      // Guard: a target already held by a part that is NOT being renamed here.
      const ids = updates.map(u => u.partId)
      const { data: holders } = await sb.from('parts').select('id, sku').eq('store_id', storeId).in('sku', [...seen])
      const blocked = (holders || []).filter((h: any) => !ids.includes(h.id))
      if (blocked.length) return json({ error: `Target SKU(s) already used by other parts: ${blocked.map((b: any) => b.sku).join(', ')}` }, 409)

      const { data: before } = await sb.from('parts').select('id, sku').eq('store_id', storeId).in('id', ids)
      const original = new Map((before || []).map((p: any) => [p.id, p.sku]))
      const rollback = async () => {
        for (const [id, sku] of original) await sb.from('parts').update({ sku }).eq('id', id).eq('store_id', storeId)
      }
      try {
        // Phase 1 — park every row on a temp value so swaps can't collide.
        for (const u of updates) {
          const { error } = await sb.from('parts').update({ sku: `__pvtmp_${u.partId}` }).eq('id', u.partId).eq('store_id', storeId)
          if (error) throw new Error(`temp rename failed for ${u.partId}: ${error.message}`)
        }
        // Phase 2 — set the real eBay label.
        for (const u of updates) {
          const { error } = await sb.from('parts').update({ sku: String(u.newSku).trim() }).eq('id', u.partId).eq('store_id', storeId)
          if (error) throw new Error(`rename failed for ${u.partId}: ${error.message}`)
        }
      } catch (e: any) {
        await rollback()
        return json({ error: `Reconcile aborted and rolled back — nothing changed. ${String(e?.message || e)}` }, 500)
      }
      // Mirror onto the listing so the stored platform_sku stops being stale.
      for (const u of updates) {
        await sb.from('listings').update({ platform_sku: String(u.newSku).trim() })
          .eq('store_id', storeId).eq('platform', 'ebay').eq('part_id', u.partId).in('status', ['live', 'active'])
      }
      return json({ ok: true, version: EDGE_FN_VERSION, updated: updates.length })
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

      // requireMarketplace, not storeMarketplace: this path SENDS to eBay, and a
      // read we could not complete must not be answered with a guessed country
      // and currency. See the note at the top of ./ebay/marketplace.ts.
      const mkt = await requireMarketplace(sb, storeId)
      const ebayHeaders = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Language': mkt.lang,
        'Content-Language': mkt.lang,
        'X-EBAY-C-MARKETPLACE-ID': mkt.mp,
      }

      const [fpRes, ppRes, rpRes, locRes] = await Promise.all([
        fetch(`https://api.ebay.com/sell/account/v1/fulfillment_policy?marketplace_id=${mkt.mp}`, { headers: ebayHeaders }),
        fetch(`https://api.ebay.com/sell/account/v1/payment_policy?marketplace_id=${mkt.mp}`, { headers: ebayHeaders }),
        fetch(`https://api.ebay.com/sell/account/v1/return_policy?marketplace_id=${mkt.mp}`, { headers: ebayHeaders }),
        fetch('https://api.ebay.com/sell/inventory/v1/location', { headers: ebayHeaders }),
      ])
      const [fpData, ppData, rpData, locData] = await Promise.all([fpRes.json(), ppRes.json(), rpRes.json(), locRes.json()])
      const fulfillmentPolicyId  = fpData.fulfillmentPolicies?.[0]?.fulfillmentPolicyId
      const paymentPolicyId      = ppData.paymentPolicies?.[0]?.paymentPolicyId
      const returnPolicyId       = rpData.returnPolicies?.[0]?.returnPolicyId
      if (!fulfillmentPolicyId) throw new Error('No fulfillment policy on eBay account — set one up in eBay Seller Hub first')
      if (!paymentPolicyId)     throw new Error('No payment policy on eBay account — set one up in eBay Seller Hub first')
      if (!returnPolicyId)      throw new Error('No return policy on eBay account — set one up in eBay Seller Hub first')
      const merchantLocationKey = await ensureMerchantLocation(ebayHeaders, locData.locations?.[0]?.merchantLocationKey)
      if (!merchantLocationKey) throw new Error('No ship-from address saved — add it in Settings → eBay Inventory Location, then list again (it is created on eBay automatically).')

      // Auto-parts categories only accept "Used" (id 3000 = USED_EXCELLENT enum),
      // "For parts" (7000), "New" (1000), or Refurbished — NOT the graded
      // USED_GOOD/USED_ACCEPTABLE conditions (those are media-only).
      const CONDITION_MAP: Record<string, string> = {
        'Used – Excellent': 'USED_EXCELLENT', 'Used – Good': 'USED_EXCELLENT', 'Used – Fair': 'USED_EXCELLENT',
        'For Parts Only': 'FOR_PARTS_OR_NOT_WORKING', 'Refurbished': 'SELLER_REFURBISHED',
      }
      // Resolved per the store's marketplace (category_maps; AU fallback).
      const CATEGORY_ID = (await categoryMapFor(sb, mkt.mp)).map

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
      // the part's title; the per-marketplace map is the fallback. Tree id comes
      // from the store's marketplace (US = eBay Motors tree 100).
      const categoryTreeId = mkt.treeId
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
          // ══ HARD BLOCK ══ Never touch a listing that is already live on eBay.
          // Checked BEFORE any eBay write (inventory replace / compatibility /
          // offer update), so a re-publish can never alter a live listing.
          //
          // ⚠ FAIL-CLOSED. The import writes status 'live'; publish writes
          // 'active'. v3.36.11-12 only checked 'active', so the block silently
          // never fired for imported listings. Anything that is NOT a known
          // dead state therefore counts as live — a new/unknown status must
          // block, never wave a write through.
          if (!ALLOW_LIVE_EBAY_EDITS) {
            const DEAD = ['ended', 'sold', 'cancelled', 'canceled', 'deleted', 'draft', 'unsold']
            const { data: anyL } = await sb.from('listings')
              .select('platform_listing_id, status').eq('part_id', part.id)
              .eq('platform', 'ebay').is('deleted_at', null)
            const stillLive = (anyL || []).filter((l: any) => !DEAD.includes(String(l.status || '').toLowerCase()))
            if (stillLive.length) {
              throw new Error(`BLOCKED — already on eBay (item ${stillLive[0].platform_listing_id}, status "${stillLive[0].status}"). Editing live listings is disabled in this build; nothing was sent to eBay.`)
            }
          }
          // Fill blank make/model/year from the donor car BEFORE building fitment,
          // so imported parts still get eBay Parts Compatibility.
          await hydrateVehicleFromCar(sb, part)
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
          // Same priority as the preview: per-part override → learned (Part-type
          // smart) → live Taxonomy suggestion → internal-category map → fallback.
          const categoryId = String(part.ebay_overrides?.categoryId || '')
            || learnedCategoryFor(storeRow?.settings, part)?.id
            || (await leafCategoryFor(catQuery)) || CATEGORY_ID[part.category] || '9886'
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
          // Cap at 4 images — each costs ~1.5k Anthropic input tokens and the org
          // rate limit is 10k/min; 4 keeps identification quality with headroom.
          const aiPhotos = (partUrls.length ? partUrls : imageUrls).slice(0, 4)
          const { aspects, fitmentList } = await fillAspects(part, categoryId, categoryTreeId, ebayHeaders, aiPhotos, storeRow?.settings?.listingDefaults || {}, { provider: storeRow?.settings?.aiModels?.specifics?.provider ?? storeRow?.settings?.specificsProvider ?? 'gemini', model: storeRow?.settings?.aiModels?.specifics?.model, sb, storeId, partId: part.id })

          // Full listing description: the part's description (or notes) + the
          // store's standard footer from settings.
          const footer = storeRow?.settings?.footer || ''
          const fullDescription = buildDescription(part, fitmentList, footer)
          const allowOffers = !!storeRow?.settings?.allowOffers
          // Condition description: per-part override, else the store's default
          // blurb (Settings → Listing defaults). eBay accepts it for used /
          // refurbished / for-parts items (max 1000 chars), not for NEW.
          const condDesc = String(part.condition_description || storeRow?.settings?.listingDefaults?.conditionDescription || '').trim().slice(0, 1000)
          // Package weight (grams) + dimensions (cm) — shared with the preview.
          const { weightG, dimL, dimW, dimH } = resolveShipping(part, shipCats, shipDefW, shipDefDims)

          // 1. Create/replace the inventory item (PUT is idempotent)
          const invRes = await fetch(`https://api.ebay.com/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
            method: 'PUT', headers: ebayHeaders,
            body: JSON.stringify({
              product: { title: part.title, description: fullDescription, aspects, ...(imageUrls.length ? { imageUrls } : {}) },
              condition,
              ...(condDesc && condition !== 'NEW' ? { conditionDescription: condDesc } : {}),
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
          // The outcome is captured (never silently swallowed) and returned per
          // part, so an empty "fits my vehicle" list is diagnosable.
          const compat: { vehicles: number; added: number; status: number; reason: string } =
            { vehicles: fitmentList.length, added: 0, status: 0, reason: '' }
          if (!fitmentList.length) {
            compat.reason = (part.make && part.model)
              ? 'No fitment produced (AI returned none; donor should have been injected — check make/model)'
              : `Part has no make/model${part.car_id ? ' (and donor car had none)' : ''} — cannot build compatibility`
          }
          if (fitmentList.length) {
            try {
              const compatibleProducts: any[] = []
              for (const f of fitmentList) {
                if (!f.make || !f.model) continue
                // Same expansion the Compatible Year aspect uses — one function so
                // the specifics and the compatibility list can never claim different
                // years for the same part.
                //
                // ⚠ Behaviour change (2026-08-27): a row whose years cannot be
                // expanded now yields a make+model entry with no Year property.
                // Previously that was true only when yearFrom was MISSING; a
                // BACKWARDS range (yearFrom 2015, yearTo 2010 — the model does
                // produce these) fell through the loop and the vehicle vanished
                // from compatibility entirely, with nothing logged. Same treatment
                // for both now, on the path eBay search actually matches.
                const years: string[] = expandYears(f)
                if (!years.length) years.push('')
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
              if (!compatibleProducts.length) {
                compat.reason = 'Fitment entries all missing make/model'
              } else {
                const compatRes = await fetch(`https://api.ebay.com/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}/product_compatibility`, {
                  method: 'PUT', headers: ebayHeaders, body: JSON.stringify({ compatibleProducts }),
                })
                compat.status = compatRes.status
                if (compatRes.ok || compatRes.status === 204) {
                  compat.added = compatibleProducts.length
                } else {
                  compat.reason = `eBay rejected compatibility (${compatRes.status}): ${(await compatRes.text()).slice(0, 240)}`
                  console.warn(`Parts compatibility rejected for ${sku}: ${compat.reason}`)
                }
              }
            } catch (e: any) {
              compat.reason = `Compatibility error: ${String(e?.message || e).slice(0, 200)}`
              console.warn('Parts compatibility error', e)
            }
          }

          // 2. Create the offer — or reuse an existing one for this SKU
          const offerBody = {
            sku, marketplaceId: mkt.mp, format: 'FIXED_PRICE',
            // Fixed-price Inventory API listings are always Good 'Til Cancelled;
            // set it explicitly so the listing duration is never left ambiguous.
            listingDuration: 'GTC',
            listingDescription: fullDescription,
            pricingSummary: { price: { value: String(part.list_price), currency: mkt.currency } },
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
              const getRes = await fetch(`https://api.ebay.com/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${mkt.mp}`, { headers: ebayHeaders })
              offerId = (await getRes.json()).offers?.[0]?.offerId
              if (!offerId) throw new Error('Offer already exists but could not be retrieved')
              // HARD BLOCK: an existing offer may back a LIVE listing — updating it
              // would edit that listing. Disabled; reuse the offer as-is.
              if (ALLOW_LIVE_EBAY_EDITS) {
                await fetch(`https://api.ebay.com/sell/inventory/v1/offer/${offerId}`, { method: 'PUT', headers: ebayHeaders, body: JSON.stringify(offerBody) })
              }
            } else {
              throw new Error(msg || `Offer error ${offerRes.status}`)
            }
          }

          // 3. PUBLISH — this makes the listing LIVE on eBay
          const pubRes = await fetch(`https://api.ebay.com/sell/inventory/v1/offer/${offerId}/publish`, { method: 'POST', headers: ebayHeaders })
          const pubData = await pubRes.json()
          if (!pubRes.ok) throw new Error(pubData.errors?.[0]?.message || `Publish error ${pubRes.status}`)
          const listingId = pubData.listingId

          // 4. Record it — part now listed; listing status MUST be 'live': the
          // listings_status_check constraint rejects 'active' (see the import at
          // ~L837). This insert previously used 'active' AND ignored its error,
          // so every publish silently failed to record its listing row — which
          // also blinded the live-listing guard until the next sync. Error is
          // now surfaced rather than swallowed.
          await sb.from('parts').update({ status: 'listed' }).eq('id', part.id)
          await sb.from('listings').delete().eq('part_id', part.id).eq('platform', 'ebay').neq('status', 'sold')
          const { error: lIns } = await sb.from('listings').insert({
            store_id: storeId, part_id: part.id, platform: 'ebay',
            platform_listing_id: listingId, platform_sku: sku, status: 'live',
            list_price: part.list_price, listed_at: new Date().toISOString(),
            platform_data: { offerId, listingId, sku }, photos: part.photos || [], photos_archived: false,
          })
          if (lIns) throw new Error(`Listed on eBay (item ${listingId}) but recording it here failed: ${lIns.message}`)

          published++
          results.push({ partId: part.id, sku, listingId, compatibility: compat })
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

      const mktDelist = await storeMarketplace(sb, storeId)
      const ebayHeaders = {
        'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json',
        'Accept-Language': mktDelist.lang, 'Content-Language': mktDelist.lang, 'X-EBAY-C-MARKETPLACE-ID': mktDelist.mp,
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
      await requireStoreMember()
      const { token, certId } = await getToken()
      const xml = await trading(token, certId, 'GetUser', `<?xml version="1.0" encoding="utf-8"?>
<GetUserRequest xmlns="urn:ebay:apis:eBLBaseComponents">
</GetUserRequest>`)
      const username = getTag(xml, 'UserID')
      if (!username) throw new Error('Could not fetch eBay username')
      return json({ username })
    }

    if (action === 'setup_ebay_location') {
      await requireStoreMember()
      const { token } = await getToken()
      const address = body.address
      if (!address?.addressLine1 || !address?.city || !address?.postalCode || !address?.country) {
        throw new Error('Address line, city, postcode, and country are required')
      }

      const mktLoc = await storeMarketplace(sb, storeId)
      const ebayHeaders = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Language': mktLoc.lang,
        'Content-Language': mktLoc.lang,
        'X-EBAY-C-MARKETPLACE-ID': mktLoc.mp,
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
