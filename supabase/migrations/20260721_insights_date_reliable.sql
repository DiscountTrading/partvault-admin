-- "Days on shelf" is anchored on least(acquired_date, first_listed_at, created_at).
-- For imported / older parts we often have NEITHER a recorded acquisition date NOR
-- an original eBay listing date, so the anchor silently falls back to created_at —
-- the row's IMPORT timestamp. That makes "days on shelf" read as "days since we
-- imported the row", which is misleading and pollutes the best/worst-performer and
-- movers analytics.
--
-- This re-declares part_insights (superseding 20260627_insights_anchor_earliest.sql)
-- adding two columns so the UI can flag and optionally exclude those rows:
--   date_source   : 'acquired' | 'listed' | 'created'  (which date the anchor used)
--   date_reliable : true when we have a real acquisition OR original-listing date
--                   (i.e. NOT the created_at fallback), so time-on-shelf is trustworthy.
--
-- Fix the underlying data with Settings → eBay Sync → "Backfill Listing Dates",
-- which re-fetches each part's original eBay StartTime into public.listings.

drop view if exists public.part_insights;
create view public.part_insights with (security_invoker = true) as
select
  p.id as part_id, p.store_id, p.sku, p.title, p.make, p.model, p.year,
  p.status, p.list_price, p.sold_price, p.shipping_charged, p.acquired_date, p.created_at, p.sold_date,
  p.market_price, p.market_count, p.market_checked_at,
  case when p.market_price > 0 and p.list_price > 0
    then round(((p.list_price - p.market_price) / p.market_price) * 100, 1)
  end as price_variance_pct,
  c.total_cost,
  coalesce(li.listing_count, 0) as listing_count,
  li.first_listed_at,
  coalesce(li.total_days_listed, 0)::int as total_days_listed,
  -- earliest date we know for this item: original listing, recorded acquisition,
  -- or (last resort) when the row was created. least() ignores NULLs.
  case when coalesce(p.sold_date::timestamptz, now())
         >= least(p.acquired_date::timestamptz, li.first_listed_at, p.created_at)
    then floor(extract(epoch from (
      coalesce(p.sold_date::timestamptz, now())
      - least(p.acquired_date::timestamptz, li.first_listed_at, p.created_at)
    )) / 86400)::int
  end as days_on_shelf,
  case when p.status = 'sold' and p.sold_date is not null
         and p.sold_date::timestamptz >= least(p.acquired_date::timestamptz, li.first_listed_at, p.created_at)
    then floor(extract(epoch from (
      p.sold_date::timestamptz
      - least(p.acquired_date::timestamptz, li.first_listed_at, p.created_at)
    )) / 86400)::int
  end as days_to_sell,
  -- Which date the shelf anchor came from, and whether it's trustworthy. A real
  -- acquisition or original-listing date = reliable; created_at fallback = not.
  case
    when p.acquired_date is not null and (li.first_listed_at is null or p.acquired_date::timestamptz <= li.first_listed_at) then 'acquired'
    when li.first_listed_at is not null then 'listed'
    else 'created'
  end as date_source,
  (p.acquired_date is not null or li.first_listed_at is not null) as date_reliable,
  case when p.status = 'sold' then (p.sold_price + coalesce(p.shipping_charged, 0)) - c.total_cost end as realized_profit,
  case when p.status <> 'sold' then p.list_price - c.total_cost end as potential_profit,
  case
    when p.status = 'sold'  and (p.sold_price + coalesce(p.shipping_charged,0)) > 0
      then round((((p.sold_price + coalesce(p.shipping_charged,0)) - c.total_cost) / (p.sold_price + coalesce(p.shipping_charged,0))) * 100, 1)
    when p.status <> 'sold' and p.list_price > 0
      then round(((p.list_price - c.total_cost) / p.list_price) * 100, 1)
  end as margin_pct
from public.parts p
cross join lateral (
  select coalesce(sum(value::numeric), 0) as total_cost
  from jsonb_each_text(coalesce(p.costs, '{}'::jsonb))
  where value ~ '^-?[0-9.]+$'
) c
left join lateral (
  select
    count(*) as listing_count,
    min(l.listed_at) as first_listed_at,
    sum(extract(epoch from (coalesce(l.sold_at, l.ended_at, now()) - l.listed_at)) / 86400) as total_days_listed
  from public.listings l
  where l.part_id = p.id and l.listed_at is not null
) li on true
where p.deleted_at is null;

grant select on public.part_insights to authenticated;
