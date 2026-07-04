// Plan tiers & capability gating (see docs/SUBSCRIPTIONS_AND_MULTI_COUNTRY.md).
// The plan lives on the store (stores.plan jsonb) and is only writable by the
// service role. AI limits are enforced SERVER-side in ai-assess; the client
// gates UI/features and explains what each tier unlocks.

export const PLAN_LIMITS = {
  trial:    { label: 'Free Trial', aiFull: 100,  seats: 99, items: 99999, stockControl: true,  history: true,  analytics: true,  multiStore: false },
  basic:    { label: 'Basic',      aiFull: 50,   seats: 1,  items: 500,   stockControl: false, history: false, analytics: false, multiStore: false },
  pro:      { label: 'Pro',        aiFull: 1000, seats: 3,  items: 5000,  stockControl: true,  history: true,  analytics: true,  multiStore: false },
  business: { label: 'Business',   aiFull: 3000, seats: 10, items: 25000, stockControl: true,  history: true,  analytics: true,  multiStore: true },
}

// Resolve a store's plan row into an effective state the UI can act on.
// - founder stores (grandfathered originals) are never gated.
// - an expired, unconverted trial becomes 'expired' (read-mostly + upgrade nudge).
// - unknown/missing tier defaults to business (fail-open: never lock a paying
//   user out because of a data hiccup; billing truth arrives via Stripe later).
export function planState(planRow) {
  const p = planRow || {}
  const tier = p.tier || 'business'
  const limits = PLAN_LIMITS[tier] || PLAN_LIMITS.business
  const trialEnds = p.trial_ends_at ? new Date(p.trial_ends_at) : null
  const trialDaysLeft = trialEnds ? Math.ceil((trialEnds - Date.now()) / 86400000) : null
  const expired = tier === 'trial' && trialEnds && trialEnds < new Date()
  return {
    tier,
    label: limits.label,
    limits,
    founder: !!p.founder,
    trialEnds,
    trialDaysLeft,
    expired,
    // Capability checks — founder bypasses everything.
    can: (cap) => !!p.founder || (!expired && !!limits[cap]),
  }
}
