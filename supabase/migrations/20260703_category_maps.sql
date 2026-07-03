-- Per-marketplace category maps: PartVault's neutral friendly category → the
-- correct eBay category ID for each marketplace (AU/US/GB/CA…). Populated from
-- eBay's Taxonomy API by the ebay-taxonomy edge function. Reference data —
-- readable by any authenticated user; only the edge function (service role) writes.
create table if not exists public.category_maps (
  marketplace        text not null,          -- EBAY_AU | EBAY_US | EBAY_GB | EBAY_CA
  friendly_category  text not null,          -- PartVault top-level category
  ebay_category_id   text,                   -- resolved leaf category id for that marketplace
  ebay_category_name text,                   -- human-readable path (for review)
  category_tree_id   text,                   -- marketplace's category tree id
  updated_at         timestamptz not null default now(),
  primary key (marketplace, friendly_category)
);

alter table public.category_maps enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='category_maps' and policyname='category_maps_read') then
    create policy category_maps_read on public.category_maps for select to authenticated using (true);
  end if;
end $$;
