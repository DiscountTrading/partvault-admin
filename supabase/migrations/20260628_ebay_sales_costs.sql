-- Per-row cost snapshot for historical (CSV-imported) sales.
--
-- Historical sales have no real cost data (no inventory part, no fees in the Orders
-- report). To keep revenue from sitting in the books with no cost attached, the
-- admin computes per-category AVERAGES from the last 90 days of real (API) sales —
-- purchase / admin / labour / storage / eBay listing fees / promotion fees / postage
-- — and writes that snapshot onto every CSV row, then LOCKS it (lock state lives in
-- stores.settings.historicalCostLock). The snapshot is frozen so figures can't drift
-- as the rolling average moves; a guarded unlock allows a deliberate recompute.
--
-- `costs` mirrors the shape of parts.costs (a flat {category: amount} object).

alter table public.ebay_sales
  add column if not exists costs jsonb;
