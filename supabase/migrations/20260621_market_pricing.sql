-- Cached eBay market price per part (from the Browse API) + a pricing-variance
-- metric for Insights. We store it rather than calling Browse live for every
-- row (rate limits / efficient API usage).
alter table public.parts add column if not exists market_price numeric;
alter table public.parts add column if not exists market_count int;
alter table public.parts add column if not exists market_checked_at timestamptz;

drop view if exists public.part_insights;
create view public.part_insights with (security_invoker = true) as
select
  p.id as part_id, p.store_id, p.sku, p.title, p.make, p.model, p.year,
  p.status, p.list_price, p.sold_price, p.acquired_date, p.created_at, p.sold_date,
  p.market_price, p.market_count, p.market_checked_at,
  -- our price vs the eBay market median: + = over-priced, - = under-priced
  case when p.market_price > 0 and p.list_price > 0
    then round(((p.list_price - p.market_price) / p.market_price) * 100, 1)
  end as price_variance_pct,
  c.total_cost,
  coalesce(li.listing_count, 0) as listing_count,
  li.first_listed_at,
  coalesce(li.total_days_listed, 0)::int as total_days_listed,
  floor(extract(epoch from (
    coalesce(p.sold_date::timestamptz, now()) - coalesce(p.acquired_date::timestamptz, p.created_at)
  )) / 86400)::int as days_on_shelf,
  case when p.status = 'sold' and p.sold_date is not null then
    floor(extract(epoch from (
      p.sold_date::timestamptz - coalesce(p.acquired_date::timestamptz, p.created_at)
    )) / 86400)::int
  end as days_to_sell,
  case when p.status = 'sold' then p.sold_price - c.total_cost end as realized_profit,
  case when p.status <> 'sold' then p.list_price - c.total_cost end as potential_profit,
  case
    when p.status = 'sold'  and p.sold_price > 0 then round(((p.sold_price - c.total_cost) / p.sold_price) * 100, 1)
    when p.status <> 'sold' and p.list_price > 0 then round(((p.list_price - c.total_cost) / p.list_price) * 100, 1)
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
