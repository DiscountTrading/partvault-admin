// Client → stripe-billing edge function. Redirects to Stripe Checkout / the
// billing portal. Throws a readable error (incl. "not configured yet") the UI
// can surface — everything is inert until the Stripe secrets/prices are set.
import { sb } from './supabase'

const FN = 'https://mtpektsxaklhedknincs.supabase.co/functions/v1/stripe-billing'

async function call(body) {
  const { data: { session } } = await sb.auth.getSession()
  const res = await fetch(FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
    body: JSON.stringify(body),
  })
  const d = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(d.error || 'Billing is unavailable right now.')
  return d
}

// Plan: startCheckout({ storeId, tier, cadence }). Credits: startCheckout({ storeId, pack }).
export async function startCheckout(opts) {
  const { url } = await call({ action: 'create_checkout', ...opts })
  if (url) window.location.href = url
}
export async function openBillingPortal(storeId) {
  const { url } = await call({ action: 'open_portal', storeId })
  if (url) window.location.href = url
}
