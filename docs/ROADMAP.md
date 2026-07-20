# PartVault — Roadmap & open items

_Last updated 2026-07-20 (v3.36.47). The mobile PWA (fast capture → eBay) is the core product; keep every change biased toward faster capture and cleaner listings._

---

## 🔴 Needs YOU to run (SQL you must apply — I can't write to prod)

1. **Pending migrations bundle** — `supabase/diagnostics/pending_migrations_20260719.sql`
   Adds: `parts.ebay_specifics`, `ebay_sales` discount fields, configurable sync interval, **weighted AI credits RPCs**, `parts.removal_minutes`, and the SKU-unique backstop. Idempotent — paste the whole thing into the Supabase SQL editor.
   - Until run: the AI removal-minutes estimate isn't saved, and Gemini/Claude credit weighting isn't fully applied.

2. **Sync scheduler fix** — `supabase/diagnostics/fix_sync_cron_schedule.sql`
   Your 6-hourly sync only fires at midnight because the cron job still only ticks 13:00–15:59 UTC. This one line reschedules it to `*/5 * * * *` so every interval boundary actually runs. **Highest-impact fix in this list.**

---

## 🟢 Done recently (deployed)

- **AI: part assessment → Gemini** (~18× cheaper than Sonnet), Claude fallback, per-store toggle (Settings → 🧠 AI model). Mobile uses it automatically. Verified on a real part.
- **Preview caching** — a manual preview now caches its build ("build once, instant after").
- **Tables** — pinned filters/headers/horizontal-scrollbar, global text-size (zoom), fixed columns across By-Part/List/De-list, right-aligned money columns, Sales two-column, page-size selector, Dashboard fit-to-screen.
- **Sync panel** — shows last run (manual/scheduled) + next scheduled run.

---

## 🟡 AI multi-provider — next steps

- [ ] **eBay item-specifics (fillAspects) → Gemini.** Currently Claude Haiku in `ebay-import`. Next cheap win; needs a `callGemini` helper in ebay-import + a quality check. Publish-adjacent — do with review, not unattended.
- [ ] **Descriptions** — decide Gemini vs Claude. Leave on Claude until we compare copy quality.
- [ ] **Identity-based specifics reuse** — when only the description/price changed (not the part's identity), reuse cached specifics instead of re-running the AI. Makes description edits instant + free.
- [ ] **Optional price-reasoning layer** (Claude) over the live eBay comps — an AI "recommended price", if wanted.
- [ ] Add `ebay_specifics` to the audit-log deny-list (avoid bloat now that previews persist).

## 🟡 Data-viewing polish (from the 2026-07-20 walkthrough)

- [ ] **Profit column clipped** on Sales & Analytics (it's the key number). Pin SKU/Title left + Profit right; let the middle scroll.
- [ ] **Cost = $0 everywhere** → Profit == price, margins read 100%. Decide how imported/listed parts get a cost basis (apply the base-cost % fallback? show "—" = "no cost data" vs "$0" = free?). Biggest data-trust issue.
- [ ] Analytics: truncated headers ("On sh…", "Mar…", "vs M…") + empty Margin/vs-Market columns eating width.
- [ ] Inventory: the AI-status icon is ambiguous — clearer glyphs / legend.

## 🟡 Listing quality (older roadmap, some open)

- [ ] AI-written **condition text** per part.
- [ ] **Pricing accuracy** (eBay sold comps, not just active listings).
- [ ] **Payment/return policy** management in-app.
- [ ] **Size-based postage** selection at publish.

---

## 🔵 Bigger bets (need external setup / decisions)

- [ ] **Subscriptions / Stripe** — tiers $19/$59/$99 designed; needs Stripe keys + eBay US/UK test accounts to finish billing.
- [ ] **eBay Marketing** — Discount/Sale + Promoted Listings; needs the `sell.marketing` scope + a reconnect.
- [ ] **Multi-country / marketplace** expansion (design locked).

## 🧹 Cleanup

- [ ] Delete dead code: `Publish.jsx`, `Delist.jsx` (folded into Inventory eBay mode).
- [ ] Dead handlers in Settings (`quickSync`, `importAllListings`, `cancelImport`).

---

_ReadSheet (the Smartsheet competitor) is tracked separately — not part of PartVault._
