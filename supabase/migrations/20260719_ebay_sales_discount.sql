-- ============================================================================
-- Capture eBay order-line promotions/discounts so the Sales "Sale price"
-- breakdown can show full price vs the promoted price the buyer actually paid.
--   discount            = total line-level discount (sum of appliedPromotions)
--   applied_promotions  = [{ desc, amount }] for the itemised popup
-- Additive + nullable, so the live sold sync keeps working before this is run
-- (the sync's schema-fallback drops these columns until the migration lands).
-- Idempotent. Apply via the Supabase SQL editor.
-- ============================================================================
alter table public.ebay_sales add column if not exists discount numeric;
alter table public.ebay_sales add column if not exists applied_promotions jsonb;
