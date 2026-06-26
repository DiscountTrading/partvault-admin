-- "Days on shelf" / "days to sell" were anchored on parts.acquired_date, which is
-- the CURRENT eBay listing StartTime. For a RELISTED item that StartTime is later
-- than the original sale, so the day-count went negative and the previous view
-- clamped it to 0 (the misleading "0 days on shelf").
--
-- A relisted item is the same physical item as its original listing, so we should
-- anchor on the EARLIEST date we know about it. We already capture every listing
-- in public.listings, so min(listed_at) (first_listed_at) is the true original
-- listing date. Anchor = least(acquired_date, first_listed_at, created_at).
--
-- Where the anchor is still later than the end date (genuinely unknown — e.g. a
-- sold order imported with no earlier listing on record), return NULL rather than
-- a misleading 0, so the UI can show "—".
--
-- Self-contained: re-declares the whole view, superseding 20260622_insights_clamp_days.sql.

alter table public.parts add column if not exists shipping_charged   numeric;
alter table public.parts add column if not exists market_price       numeric;
alter table public.parts add column if not exists market_count       integer;
alter table public.parts add column if not exists market_checked_at  timestamptz;

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
