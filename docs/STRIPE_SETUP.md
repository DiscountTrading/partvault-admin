# Activating Stripe billing

Everything is built and deployed (the `stripe-billing` edge function + the app
UI). It's **inert until you do the steps below** — then subscriptions, credit
packs and the customer portal all work. Start in **Stripe Test mode**, verify,
then repeat the price/webhook steps in **Live mode**.

## 1. Create the products & prices (Stripe Dashboard → Products)
Create one product per plan with the prices below (all recurring except credits).
Note each **price ID** (`price_…`) — you'll map them in step 3.

| Product | Price | Billing |
|---|---|---|
| PartVault Basic | $29 / mo | recurring monthly |
| PartVault Basic | $19 / mo | recurring monthly (12-month commitment) |
| PartVault Basic | $228 / yr | recurring yearly (upfront, incl. 2 bonus months) |
| PartVault Pro | $79 / $59 / $708 | monthly · monthly · yearly |
| PartVault Business | $129 / $99 / $1,188 | monthly · monthly · yearly |
| AI Credit Pack — 300 | $10 | **one-time** |
| AI Credit Pack — 1000 | ~$30 | one-time (optional) |

Notes:
- The "12-month commitment, paid monthly" price is just a monthly price; the
  commitment is enforced by your terms (Stripe bills monthly).
- For the **upfront** yearly price, set the amount to 12× the committed monthly.
  The "+2 months" bonus is handled by adding a **2-month free trial** on that
  price (Product → price → add free trial of 60 days), so the first renewal
  lands at month 14.

## 2. Set the edge-function secrets
```
npx supabase secrets set STRIPE_SECRET_KEY=sk_test_xxx \
  STRIPE_WEBHOOK_SECRET=whsec_xxx \
  APP_URL=https://admin.partvault.app \
  STRIPE_PRICES='{"basic_monthly":"price_…","basic_annual_monthly":"price_…","basic_annual_upfront":"price_…","pro_monthly":"price_…","pro_annual_monthly":"price_…","pro_annual_upfront":"price_…","business_monthly":"price_…","business_annual_monthly":"price_…","business_annual_upfront":"price_…","credits_300":"price_…","credits_1000":"price_…"}'
```
The `STRIPE_PRICES` keys must be exactly `${tier}_${cadence}` (cadence =
`monthly` | `annual_monthly` | `annual_upfront`) and `credits_300` / `credits_1000`
— that's what the app sends.

## 3. Create the webhook (Stripe → Developers → Webhooks → Add endpoint)
- **Endpoint URL:** `https://mtpektsxaklhedknincs.supabase.co/functions/v1/stripe-billing`
- **Events to send:** `checkout.session.completed`, `invoice.paid`,
  `customer.subscription.updated`, `customer.subscription.deleted`
- Copy the endpoint's **Signing secret** (`whsec_…`) into `STRIPE_WEBHOOK_SECRET` (step 2).

## 4. Test it
- In the app (a **non-founder** store): Settings → Plan → **Choose a plan** →
  complete Stripe test checkout (card `4242 4242 4242 4242`). The webhook flips
  `stores.plan` (tier/cadence/`paid_through`) automatically.
- **Buy AI credits** → one-time checkout → `grant_ai_credits` runs → balance goes up.
- **Manage billing** → opens the Stripe customer portal (update card / cancel).

## How it maps to the build
- Checkout + portal + webhook: `supabase/functions/stripe-billing/index.ts`.
- Webhook sets `stores.plan` via the service role (bypasses the plan-protect
  trigger) and calls `grant_ai_credits` for credit purchases.
- Plan tiers/limits, AI metering, credit consumption, gating, deletion/retention:
  already live (see `SUBSCRIPTIONS_AND_MULTI_COUNTRY.md`).
- Your own AU store is a **Founder** account — it never sees billing and is
  never gated.
