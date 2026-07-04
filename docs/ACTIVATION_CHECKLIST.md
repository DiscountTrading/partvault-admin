# Go-live checklist — subscriptions & multi-country

Everything is built & deployed. These are the steps only you can do to switch it on.

## 1. Run the SQL migrations (Supabase → SQL editor)
Paste each file's contents and run. All idempotent; order doesn't matter.
- [ ] `supabase/migrations/20260703_category_maps.sql`  *(already run)*
- [ ] `supabase/migrations/20260704_marketplace_lock.sql`
- [ ] `supabase/migrations/20260704_plans.sql`
- [ ] `supabase/migrations/20260704_ai_credits.sql`
- [ ] `supabase/migrations/20260704_store_deletion.sql`  *(also creates the daily purge cron)*

Until run, the related features **fail safe** (metering/credits = unlimited,
marketplace lock = UI-only, deletion UI works but no scheduled purge).

## 2. Stripe billing
Follow `docs/STRIPE_SETUP.md` — create products/prices, set the 4 edge secrets
(`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICES`, `APP_URL`), add
the webhook. Test in Test mode, then Live.

## 3. Multi-country go-live (per new country)
- [ ] Confirm your eBay production keyset is enabled for the marketplace (US/UK/CA).
- [ ] Create an eBay **test/sandbox seller account** for that country.
- [ ] Create a PartVault store, set its marketplace at creation, connect that
      country's eBay account (the connect step enforces a match).
- [ ] Publish a test part and check: category (from `category_maps`), item
      specifics, currency, and title spelling (tyre/tire) are all correct.
- [ ] Category maps already built for AU/US/GB/CA (`ebay-taxonomy` fn); re-run it
      if eBay changes a tree.

## 4. Already handled (no action)
- Currency display, AI locale/spelling, region-correct vehicle recognition &
  local price research, per-region postage-cost defaults.
- Plans/trial/gating, AI metering + credit packs, deletion/retention lifecycle.
- Your AU store is a grandfathered **Founder** account: unlimited, never gated.

See `SUBSCRIPTIONS_AND_MULTI_COUNTRY.md` for the full design.
