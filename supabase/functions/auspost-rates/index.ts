// Australia Post live shipping rates. Holds the AUSPOST_API_KEY as a Supabase
// secret (never in the browser) and returns real Aus Post parcel prices so the
// Dashboard/COGS postage figure can stop being a weight-estimate.
//
// Uses the public Postage Assessment Calculation (PAC) API — real Australia Post
// RETAIL prices, needs only an API key from developers.auspost.com.au:
//   GET /postage/parcel/domestic/service.json    → available services + prices
//   GET /postage/parcel/domestic/calculate.json  → price for one service_code
//   header: AUTH-KEY: <api key>
// Account-NEGOTIATED rates (the Shipping & Tracking /shipping/v1/prices endpoint,
// Basic auth + Account-Number) are a follow-up once the account creds are in — see
// the note near the calculate branch. The response says which source was used.
//
// Auth: any store member (verified in code via is_store_member); verify_jwt is off
// at the gateway (config.toml) so the browser preflight isn't rejected.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })

const EDGE_FN_VERSION = '3.36.53'
const PAC_BASE = 'https://digitalapi.auspost.com.au/postage/parcel/domestic'

// A sensible default carton when a part has no box dims yet (a small parcel).
const DEFAULT_BOX = { length: 22, width: 16, height: 7.7 } // cm

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const KEY = Deno.env.get('AUSPOST_API_KEY')
    const body = await req.json().catch(() => ({}))
    const action = body.action || 'calculate'

    // Authorise: caller must be a member of the store.
    const url = Deno.env.get('SUPABASE_URL')!
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!
    const { storeId } = body
    if (!storeId) return json({ error: 'storeId required' }, 400)
    const userClient = createClient(url, anon, { global: { headers: { Authorization: req.headers.get('Authorization') || '' } } })
    const { data: member } = await userClient.rpc('is_store_member', { p_store_id: storeId })
    if (!member) return json({ error: 'Not authorised' }, 403)

    // Lightweight "is it connected?" probe for the Settings UI — no key needed.
    if (action === 'status') {
      return json({ ok: true, configured: !!KEY, account: !!Deno.env.get('AUSPOST_ACCOUNT_NUMBER'), version: EDGE_FN_VERSION })
    }

    if (!KEY) return json({ error: 'Australia Post isn’t connected yet. Add the AUSPOST_API_KEY secret in Supabase (from developers.auspost.com.au), then try again.', configured: false }, 400)

    const from = String(body.fromPostcode || '').trim()
    const to = String(body.toPostcode || '').trim()
    if (!/^\d{4}$/.test(from) || !/^\d{4}$/.test(to)) return json({ error: 'A 4-digit from_postcode and to_postcode are required.' }, 400)
    const weight = Math.min(22, Math.max(0.01, +body.weightKg || 0.5)) // kg; PAC domestic max ~22kg
    const length = +body.length || DEFAULT_BOX.length
    const width = +body.width || DEFAULT_BOX.width
    const height = +body.height || DEFAULT_BOX.height

    const params = () => new URLSearchParams({
      from_postcode: from, to_postcode: to,
      length: String(length), width: String(width), height: String(height), weight: String(weight),
    })
    const pacGet = async (path: string, extra?: Record<string, string>) => {
      const q = params()
      if (extra) for (const [k, v] of Object.entries(extra)) q.set(k, v)
      const r = await fetch(`${PAC_BASE}/${path}?${q}`, { headers: { 'AUTH-KEY': KEY } })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || d.error) throw new Error(d?.error?.errorMessage || `Australia Post HTTP ${r.status}`)
      return d
    }

    // List the services (with prices) available for this parcel.
    if (action === 'services') {
      const d = await pacGet('service.json')
      const services = (d.services?.service || []).map((s: any) => ({ code: s.code, name: s.name, price: +s.price || 0 }))
        .filter((s: any) => s.price > 0).sort((a: any, b: any) => a.price - b.price)
      return json({ ok: true, services, version: EDGE_FN_VERSION })
    }

    // calculate: price one service. If none given, use the cheapest standard
    // service returned for this parcel (usually Parcel Post).
    // NOTE (account rates): to bill the store's NEGOTIATED prices instead of retail,
    // swap this branch for the Shipping & Tracking API — POST
    // https://digitalapi.auspost.com.au/shipping/v1/prices/items with Basic auth
    // (API key:secret) + `Account-Number` header — once AUSPOST_ACCOUNT_NUMBER /
    // AUSPOST_API_SECRET secrets are set. Same in/out shape, different pricing source.
    let serviceCode = body.serviceCode as string | undefined
    let serviceName = ''
    if (!serviceCode) {
      const sd = await pacGet('service.json')
      const svcs = (sd.services?.service || []).map((s: any) => ({ code: s.code, name: s.name, price: +s.price || 0 }))
        .filter((s: any) => s.price > 0).sort((a: any, b: any) => a.price - b.price)
      if (!svcs.length) return json({ error: 'Australia Post returned no services for this parcel — check the postcodes, weight and size.' }, 400)
      serviceCode = svcs[0].code; serviceName = svcs[0].name
    }
    const d = await pacGet('calculate.json', { service_code: serviceCode })
    const cost = +d.postage_result?.total_cost || 0
    return json({
      ok: true, cost, currency: 'AUD', source: 'auspost-retail',
      serviceCode, service: d.postage_result?.service || serviceName || null,
      version: EDGE_FN_VERSION,
    })
  } catch (e) {
    return json({ error: (e as Error)?.message || String(e) }, 400)
  }
})
