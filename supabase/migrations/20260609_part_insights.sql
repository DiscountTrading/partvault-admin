-- ============================================================================
-- Stock insights — per-part business metrics computed from parts + listings.
--
-- A view (security_invoker = true) so the querying user's RLS on parts/listings
-- still applies (store-scoped). Covers everything derivable from current data;
-- promotion metrics (eBay Promoted Listings) are deferred until the Marketing
-- API is wired up.
--
-- Metrics: total_cost, days_on_shelf, days_to_sell, listing_count (relist proxy),
-- total_days_listed, realized_profit, potential_profit, margin_pct.
-- ============================================================================

begin;

drop view if exists public.part_insights;

create view public.part_insights
with (security_invoker = true)
as
select
  p.id            as part_id,
  p.store_id,
  p.sku,
  p.title,
  p.make, p.model, p.year,
  p.status,
  p.list_price,
  p.sold_price,
  p.acquired_date,
  p.created_at,
  p.sold_date,
  c.total_cost,
  coalesce(li.listing_count, 0)                  as listing_count,
  li.first_listed_at,
  coalesce(li.total_days_listed, 0)::int          as total_days_listed,
  -- time the part has occupied a shelf (until sold, else until now)
  floor(extract(epoch from (
    coalesce(p.sold_date::timestamptz, now()) - coalesce(p.acquired_date::timestamptz, p.created_at)
  )) / 86400)::int                                as days_on_shelf,
  -- how long it took to sell (sold parts only)
  case when p.status = 'sold' and p.sold_date is not null then
    floor(extract(epoch from (
      p.sold_date::timestamptz - coalesce(p.acquired_date::timestamptz, p.created_at)
    )) / 86400)::int
  end                                             as days_to_sell,
  -- realised profit on sold parts; potential profit on everything else
  case when p.status = 'sold' then p.sold_price - c.total_cost end as realized_profit,
  case when p.status <> 'sold' then p.list_price - c.total_cost end as potential_profit,
  case
    when p.status = 'sold'  and p.sold_price > 0 then round(((p.sold_price - c.total_cost) / p.sold_price) * 100, 1)
    when p.status <> 'sold' and p.list_price > 0 then round(((p.list_price - c.total_cost) / p.list_price) * 100, 1)
  end                                             as margin_pct
from public.parts p
cross join lateral (
  -- sum the numeric values in the costs jsonb (robust to which keys exist)
  select coalesce(sum(value::numeric), 0) as total_cost
  from jsonb_each_text(coalesce(p.costs, '{}'::jsonb))
  where value ~ '^-?[0-9.]+$'
) c
left join lateral (
  select
    count(*)            as listing_count,
    min(l.listed_at)    as first_listed_at,
    sum(extract(epoch from (coalesce(l.sold_at, l.ended_at, now()) - l.listed_at)) / 86400) as total_days_listed
  from public.listings l
  where l.part_id = p.id and l.listed_at is not null
) li on true
where p.deleted_at is null;

grant select on public.part_insights to authenticated;

commit;
