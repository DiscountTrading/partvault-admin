# PartVault — Subscriptions & Multi-Country Spec

Status: **locked design** (2026-07-03). Source of truth for the subscription/billing
model, per-store location/marketplace, category architecture, and store deletion.

---

## 1. Subscription tiers

| | **Free Trial** | **Basic** | **Pro** | **Business** |
|---|---|---|---|---|
| Price | 14 days, full | **$19/mo** | ~$59/mo | ~$99/mo |
| Mobile capture + inventory | ✅ | ✅ | ✅ | ✅ |
| List / sync to eBay | ✅ | ✅ | ✅ | ✅ |
| AI | Full (capped ~100) | Limited: fast Haiku naming + ~50 full assessments/mo | Full (fair-use ~1,000/mo) | Highest limits |
| Searchable stock control + warehouse locations/QR | ✅ | — | ✅ | ✅ |
| Historical import + costing + analytics | ✅ | — | ✅ | ✅ |
| Users (seats) | — | 1 | 3 | 10+ |
| Stores / companies | — | 1 | 1 | multiple |
| Item allowance | — | 500 | 5,000 | 25,000 |

- Start Basic at **$19** deliberately (land cheap, upsell to Pro/Business). Price can rise later.
- **AI is the only real variable cost** (~5¢/full Sonnet assessment) — it is the primary gating lever. Overage sold as credit packs.
- Item allowances, not a per-stored-item monthly fee (a monthly tax on stored rows punishes keeping full inventory — the product's core value).

## 2. Billing model

- **Billable unit = the store.** Each store = one eBay account + its own inventory/P&L. Plan/trial/limits attach to the store.
- **One subscription per store.** Two stores = two subscriptions. Business tier later bundles several (+per-extra-store add-on).
- **Seats (users)** are a within-store limit by tier.
- **Trial is per *account*, used once** — not per store — to stop delete/recreate farming.
- Stripe: owner = one customer, one subscription per store (multi-store = multiple line items).

## 3. Location / marketplace (per store)

`marketplace` (EBAY_AU | EBAY_US | EBAY_GB) + `currency` (AUD/USD/GBP) + `locale` live in **store settings**. A user can run stores in different countries (multi-store already supported).

**Determination — guess → confirm → lock:**
1. **Guess** at store creation from browser locale/timezone (timezone already auto-detected).
2. **Confirm** the marketplace during onboarding, *before the first capture*.
3. **Locked once the first part is created.** After that it is immutable (UI + server enforced). A different country = a **new store**.
4. **eBay connect must match** the store's marketplace. Connecting a mismatched account is blocked with a clear message ("This store is set to Australia — connect an AU eBay account or create a new store for the US").
5. Never auto-convert prices or reinterpret historical (currency-stamped) sales.

## 4. Category architecture (multi-country safe)

- **The part stores the neutral friendly category** (`Lighting & Bulbs → Tail Lights`) — marketplace-agnostic, the single source of truth. The AI already picks from this tree, so it is safe by construction.
- **The real eBay category ID is resolved at list-time** from the part's store → marketplace map. Never the stored source of truth.
- **Per-marketplace maps:** friendly category → eBay category ID, one map per marketplace (AU/US/GB). Best populated from **eBay's Taxonomy API** (`getDefaultCategoryTreeId` → `getCategoryTree`), matched once to the closest leaf and cached per `(marketplace, categoryTreeId, version)`.
- **Item specifics/aspects** resolved per-marketplace via `getItemAspectsForCategory`.
- **Anti-mixup safeguards:** any cached eBay ID is stamped `{marketplace, id, treeVersion}` and re-resolved if it doesn't match the store's marketplace; validated against that marketplace's cached tree before publish; UI only ever shows the active store's marketplace; eBay's publish call is the final backstop (rejects wrong-marketplace categories).

## 5. Store deletion & retention

| Phase | Window | State | Recovery |
|---|---|---|---|
| Soft-deleted | Days 0–30 | Hidden in-app, billing stopped | Self-service restore, **free** |
| Archived | Days 31–180 | Back-end only | Support restore + **one-off recovery fee** |
| Purged | 180+ days | Permanently hard-deleted | Not recoverable |

- **Delete:** owner/admin only, type-to-confirm. On delete: hide from all members, stop billing (keep any paid time credited), **revoke eBay tokens immediately** (never archived), stop syncs.
- **Always offer "delete permanently now"** (GDPR/right-to-erasure override of the archive).
- Photos ride along in archive, purged at 180 days.
- Disclose the 180-day retention schedule in Terms/Privacy.
- **eBay listings are NOT deleted** (they live on eBay) — stated on the confirm screen.
- Internal admin tool lists archived stores and triggers restore.

## 6. Billing on restore

- Restore **requires a valid payment method** (fails → stays deleted/archived).
- **Deletion keeps already-paid time credited** (track `paid_through`):
  - Restore **within the paid window** → resume **free**, original billing anchor.
  - Restore **after it lapsed** → subscription **restarts at current price, charged on the recovery day** (new anchor), no gap back-charge.
- **Archive restores (31–180) always pay the one-off recovery fee**; the subscription charge only applies if the paid window has lapsed.
- **Trials never resurrect** (trial eligibility is account-level, used once) — restoring a former trial starts paid on the recovery day.
- Resume at **current list price**, not grandfathered.

## 7. Build sequence

1. **Foundation (safe, AU default):** marketplace/currency/locale in store settings + shared marketplace config + currency formatting. No behaviour change for existing AU stores. ← *in progress*
2. **Location lifecycle:** onboarding confirm → lock-at-first-part → eBay-connect match guard.
3. **Category maps:** Taxonomy-API resolver + per-marketplace cache table; map friendly tree for AU (from existing IDs) then US/GB; stamp-and-validate at publish; per-marketplace item aspects.
4. **Currency/units:** currency display everywhere; US shipping in lb/oz; per-region shipping profiles; AI locale spelling.
5. **Subscription/gating:** `plan` on store, capability map gating UI + edge functions, AI-usage metering, seat/item allowances.
6. **Stripe billing:** subscriptions per store, trial, overage credit packs.
7. **Deletion/retention:** soft→archive→purge lifecycle, restore + rebilling, internal restore tool.

### External dependencies (need Paul / accounts)
- **Stripe account + API keys** (steps 5–6) and final prices/recovery-fee amount.
- **eBay test seller accounts** for US and UK (step 3–4 verification) — category IDs are pulled live from the Taxonomy API, but publishing must be tested per marketplace.
- Confirm eBay production keyset is enabled for US/UK marketplaces (normally yes).
