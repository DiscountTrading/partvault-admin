// Stripe billing for PartVault (see docs/SUBSCRIPTIONS_AND_MULTI_COUNTRY.md).
// Two entry points in one function:
//   • action calls (JWT-authed, from the admin): create_checkout / open_portal
//   • Stripe webhook (signature-verified): flips stores.plan + grants credits
//
// INERT until these secrets are set (supabase secrets set ...):
//   STRIPE_SECRET_KEY       sk_live_… / sk_test_…
//   STRIPE_WEBHOOK_SECRET   whsec_…   (from the webhook endpoint you create)
//   STRIPE_PRICES           JSON map, e.g. {"basic_monthly":"price_…","pro_annual_upfront":"price_…","credits_300":"price_…"}
//   APP_URL                 https://admin.partvault.app  (checkout return URLs)
// Price-key scheme: `${tier}_${cadence}` (cadence = monthly | annual_monthly |
// annual_upfront) for plans; `credits_${amount}` for credit packs.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, stripe-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })

const SK        = Deno.env.get('STRIPE_SECRET_KEY') || ''
const WH_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET') || ''
const PRICES    = (() => { try { return JSON.parse(Deno.env.get('STRIPE_PRICES') || '{}') } catch { return {} } })()
const APP_URL   = Deno.env.get('APP_URL') || 'https://admin.partvault.app'
const CREDIT_PACKS: Record<string, number> = { credits_300: 300, credits_1000: 1000 } // key → credits granted

// Thin Stripe REST helper (form-encoded; avoids bundling the SDK).
async function stripe(path: string, params: Record<string, string>, method = 'POST') {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${SK}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: method === 'GET' ? undefined : new URLSearchParams(params).toString(),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.message || `Stripe ${path} ${res.status}`)
  return data
}

// Verify a Stripe webhook signature (HMAC-SHA256 over `${t}.${payload}`).
async function verifySig(payload: string, header: string): Promise<boolean> {
  try {
    const parts = Object.fromEntries(header.split(',').map(kv => kv.split('=')))
    const t = parts['t']; const v1 = parts['v1']
    if (!t || !v1) return false
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(WH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`))
    const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('')
    // constant-time-ish compare
    if (hex.length !== v1.length) return false
    let diff = 0; for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ v1.charCodeAt(i)
    return diff === 0
  } catch { return false }
}

const svc = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const isoFromUnix = (s?: number) => s ? new Date(s * 1000).toISOString() : null

// Merge fields into stores.plan (service role → bypasses the plan-protect trigger).
async function patchPlan(storeId: string, patch: Record<string, unknown>) {
  const db = svc()
  const { data } = await db.from('stores').select('plan').eq('id', storeId).single()
  await db.from('stores').update({ plan: { ...(data?.plan || {}), ...patch } }).eq('id', storeId)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (!SK) return json({ error: 'Billing is not configured yet (no Stripe key).' }, 503)

  // ── Webhook path (Stripe → us), identified by the signature header ──────────
  const sig = req.headers.get('stripe-signature')
  if (sig) {
    const body = await req.text()
    if (!WH_SECRET || !(await verifySig(body, sig))) return json({ error: 'bad signature' }, 400)
    let evt: any; try { evt = JSON.parse(body) } catch { return json({ error: 'bad json' }, 400) }
    const obj = evt.data?.object || {}
    try {
      if (evt.type === 'checkout.session.completed') {
        const md = obj.metadata || {}
        const storeId = md.storeId
        if (storeId && obj.mode === 'payment' && md.kind === 'credits') {
          await svc().rpc('grant_ai_credits', { p_store_id: storeId, p_amount: +md.credits || 0 })
        } else if (storeId && obj.mode === 'subscription') {
          const sub = await stripe(`subscriptions/${obj.subscription}`, {}, 'GET')
          await patchPlan(storeId, {
            tier: md.tier, cadence: md.cadence,
            paid_through: isoFromUnix(sub.current_period_end),
            stripe_customer: obj.customer, stripe_subscription: obj.subscription,
            trial_ends_at: null,
          })
        }
      } else if (evt.type === 'invoice.paid') {
        const storeId = obj.subscription_details?.metadata?.storeId || obj.lines?.data?.[0]?.metadata?.storeId
        if (storeId && obj.lines?.data?.[0]?.period?.end) await patchPlan(storeId, { paid_through: isoFromUnix(obj.lines.data[0].period.end) })
      } else if (evt.type === 'customer.subscription.updated') {
        const storeId = obj.metadata?.storeId
        if (storeId) await patchPlan(storeId, { paid_through: isoFromUnix(obj.current_period_end), cancel_at_period_end: !!obj.cancel_at_period_end })
      } else if (evt.type === 'customer.subscription.deleted') {
        const storeId = obj.metadata?.storeId
        if (storeId) await patchPlan(storeId, { tier: 'basic', cadence: null, stripe_subscription: null })
      }
    } catch (e) { return json({ error: (e as Error).message }, 500) }
    return json({ received: true })
  }

  // ── Action path (admin UI, JWT-authed) ──────────────────────────────────────
  let body: any = {}
  try { body = await req.json() } catch { /* empty */ }
  const { action, storeId } = body
  if (!storeId) return json({ error: 'storeId required' }, 400)

  // Caller must be able to manage billing for this store (publish permission ~ admin).
  const authHeader = req.headers.get('Authorization') || ''
  const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
  const { data: allowed } = await userClient.rpc('has_permission', { p_store_id: storeId, p_capability: 'publish' })
  if (!allowed) return json({ error: 'Not authorised to manage billing for this store' }, 403)

  const db = svc()
  const { data: store } = await db.from('stores').select('plan, name').eq('id', storeId).single()
  const plan = store?.plan || {}

  // Reuse or create the Stripe customer for this store.
  const ensureCustomer = async (): Promise<string> => {
    if (plan.stripe_customer) return plan.stripe_customer
    const { data: { user } } = await userClient.auth.getUser()
    const cust = await stripe('customers', { email: user?.email || '', name: store?.name || '', 'metadata[storeId]': storeId })
    await patchPlan(storeId, { stripe_customer: cust.id })
    return cust.id
  }

  if (action === 'create_checkout') {
    // Plan: body { tier, cadence }.  Credit pack: body { pack: 'credits_300' }.
    const isCredits = !!body.pack
    const key = isCredits ? body.pack : `${body.tier}_${body.cadence}`
    const price = PRICES[key]
    if (!price) return json({ error: `Billing isn't configured for "${key}" yet (missing price id).` }, 503)
    const customer = await ensureCustomer()
    const meta: Record<string, string> = isCredits
      ? { 'metadata[storeId]': storeId, 'metadata[kind]': 'credits', 'metadata[credits]': String(CREDIT_PACKS[key] || 0) }
      : { 'metadata[storeId]': storeId, 'metadata[kind]': 'subscription', 'metadata[tier]': body.tier, 'metadata[cadence]': body.cadence,
          // copy metadata onto the subscription so later invoice/updated events carry it
          'subscription_data[metadata][storeId]': storeId, 'subscription_data[metadata][tier]': body.tier, 'subscription_data[metadata][cadence]': body.cadence }
    const session = await stripe('checkout/sessions', {
      customer, mode: isCredits ? 'payment' : 'subscription',
      'line_items[0][price]': price, 'line_items[0][quantity]': '1',
      success_url: `${APP_URL}/?billing=success`, cancel_url: `${APP_URL}/?billing=cancel`,
      ...meta,
    })
    return json({ url: session.url })
  }

  if (action === 'open_portal') {
    // Stripe-hosted billing portal (update card, cancel, invoices).
    const customer = await ensureCustomer()
    const sess = await stripe('billing_portal/sessions', { customer, return_url: `${APP_URL}/` })
    return json({ url: sess.url })
  }

  return json({ error: 'Unknown action' }, 400)
})
