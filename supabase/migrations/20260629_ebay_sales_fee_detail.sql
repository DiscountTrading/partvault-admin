-- Per-sale eBay fee breakdown (final value fee, fixed per-order fee, promotion/ad
-- fees, regulatory, etc). The Finances API returns these per type; we previously
-- collapsed them into ebay_sales.fees. This stores the split so the Sales view can
-- explain why a fee differs (e.g. a promoted listing). Shape: { FEE_TYPE: amount }.

alter table public.ebay_sales
  add column if not exists fee_detail jsonb;
