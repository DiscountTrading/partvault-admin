-- Per-part manual overrides for the eBay listing (item specifics, fitment, and
-- later category). The user's corrections in the listing preview win over the
-- AI-generated values at publish time. Shape:
--   { "specifics": { "<aspect name>": "<value>" }, "fitment": [ ... ], "categoryId": "", "categoryName": "" }
alter table public.parts add column if not exists ebay_overrides jsonb;
