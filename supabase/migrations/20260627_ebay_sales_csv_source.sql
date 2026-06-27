-- Historical sales import from an uploaded eBay Seller Hub "Orders report" CSV.
--
-- WHY: eBay's order/transaction APIs only reach back ~90 days, so any sale older
-- than that can never be pulled by the nightly/manual sync. The Seller Hub Orders
-- report, however, exports years of history. This lets us backfill those old sales
-- into the ebay_sales mirror so the Dashboard's "All" window shows true lifetime
-- sales — not just the rolling 90-day API window.
--
-- WHAT THIS ADDS:
--   (a) `source` — distinguishes API-imported rows ('api') from CSV-imported
--       historical rows ('csv_orders_report'). The Orders report carries NO fee
--       column, so CSV rows are revenue-accurate but have fees = 0; tagging them
--       keeps that honest and lets the nightly reconcile leave them alone (the API
--       can't see them, so it must never "fix" or delete them).
--   (b) an index on (store_id, legacy_item_id) so the importer's dedup check —
--       "do we already have a sale for this eBay item number?" — is fast.
--
-- DEDUP REMAINS BULLETPROOF: ebay_sales already has unique (store_id, order_id,
-- line_item_id) — eBay's own key — so the table can never physically hold a real
-- duplicate. The importer additionally skips any CSV row whose eBay item number is
-- already present (existing records win), per the store's one-physical-part model.

begin;

alter table public.ebay_sales
  add column if not exists source text not null default 'api';

create index if not exists ebay_sales_store_item_idx
  on public.ebay_sales (store_id, legacy_item_id);

commit;
