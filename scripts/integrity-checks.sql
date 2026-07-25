-- PartVault data-integrity / isolation report (READ-ONLY).
-- Run via the read-only role (see reference_readonly_db_access). One SELECT that
-- returns a row per check: severity | check | detail | n. Any CRITICAL row = a
-- real cross-company or orphan problem to investigate immediately.
with
xstore_listings as (   -- a listing tied to a part that belongs to a DIFFERENT store
  select count(*) n from public.listings l join public.parts p on p.id = l.part_id
  where l.store_id <> p.store_id and l.deleted_at is null
),
xstore_sales as (      -- a sale tied to a part in a different store
  select count(*) n from public.ebay_sales s join public.parts p on p.id = s.part_id
  where s.part_id is not null and s.store_id <> p.store_id
),
null_store_parts as (select count(*) n from public.parts where store_id is null and deleted_at is null),
null_store_sales as (select count(*) n from public.ebay_sales where store_id is null),
null_store_listings as (select count(*) n from public.listings where store_id is null and deleted_at is null),
orphan_car_parts as (  -- part points at a car row that doesn't exist / is deleted
  select count(*) n from public.parts p
  where p.car_id is not null and p.deleted_at is null
    and not exists (select 1 from public.cars c where c.id = p.car_id and c.deleted_at is null)
),
dup_sku as (           -- same SKU on >1 active listing within a store (eBay key clash)
  select count(*) n from (
    select store_id, platform_sku from public.listings
    where deleted_at is null and status in ('live','active','listed') and platform_sku is not null
    group by store_id, platform_sku having count(*) > 1
  ) d
),
neg_days as (select count(*) n from public.part_insights where days_on_shelf < 0),
view_cols as (         -- migration 20260721 applied? (date reliability columns)
  select count(*) n from information_schema.columns
  where table_schema='public' and table_name='part_insights' and column_name in ('date_reliable','date_source')
),
listed_status as (     -- parts marked 'listed' with no live listing row (sync drift)
  select count(*) n from public.parts p
  where p.status='listed' and p.deleted_at is null
    and not exists (select 1 from public.listings l where l.part_id=p.id and l.status in ('live','active','listed') and l.deleted_at is null)
)
select * from (
  select 'CRITICAL' sev, 'cross-store listings (part in another store)' chk, n::text detail, n from xstore_listings
  union all select 'CRITICAL','cross-store sales (part in another store)', n::text, n from xstore_sales
  union all select 'CRITICAL','parts with NULL store_id',    n::text, n from null_store_parts
  union all select 'CRITICAL','sales with NULL store_id',    n::text, n from null_store_sales
  union all select 'CRITICAL','listings with NULL store_id', n::text, n from null_store_listings
  union all select 'WARN','parts linked to a missing/deleted car', n::text, n from orphan_car_parts
  union all select 'WARN','duplicate active-listing SKUs (per store)', n::text, n from dup_sku
  union all select 'WARN','part_insights rows with negative days_on_shelf', n::text, n from neg_days
  union all select 'WARN','parts ''listed'' with no live listing row', n::text, n from listed_status
  union all select case when n=2 then 'OK' else 'CRITICAL' end, 'part_insights has date_reliable+date_source', n||'/2', case when n=2 then 0 else 1 end from view_cols
) r
order by case sev when 'CRITICAL' then 0 when 'WARN' then 1 else 2 end, n desc, chk;
