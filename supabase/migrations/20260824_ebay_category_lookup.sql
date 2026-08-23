-- ═══════════════════════════════════════════════════════════════════════════
--  eBay category → PartVault category/subcategory lookup.
--
--  Why: the sync never captured eBay's category, and the backfill that covered
--  for it relied on a hand-written 45-entry map of category IDs. eBay has
--  several hundred car-part categories, so 943 of Discount Trading's parts had a
--  category ID nobody had mapped, and NO imported part ever got a subcategory.
--
--  This table is that map, but built from eBay's own taxonomy instead of by
--  hand: for each of our 16 top-level categories we walk the subtree once and
--  record every descendant. A category ID then resolves locally, forever, with
--  no per-part API call — and the leaf's own name gives us the subcategory.
--
--  Refreshed by the `refresh_category_tree` edge action. Rows are marketplace-
--  scoped because a US/UK store's tree differs from AU's.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.ebay_category_lookup (
  marketplace       text not null,               -- 'EBAY_AU', 'EBAY_US', …
  category_id       text not null,               -- eBay leaf or branch id
  friendly_category text not null,               -- our top-level name
  leaf_name         text,                        -- eBay's own name for this node
  subcategory       text,                        -- our subcategory, matched from leaf_name
  root_id           text,                        -- the top-level id it descends from
  updated_at        timestamptz not null default now(),
  primary key (marketplace, category_id)
);

create index if not exists ebay_category_lookup_cat_idx on public.ebay_category_lookup(category_id);

alter table public.ebay_category_lookup enable row level security;

-- Reference data, not store data: any signed-in user may read it; only the edge
-- function (service role) writes it.
drop policy if exists ebay_category_lookup_read on public.ebay_category_lookup;
create policy ebay_category_lookup_read on public.ebay_category_lookup
  for select to authenticated using (true);
