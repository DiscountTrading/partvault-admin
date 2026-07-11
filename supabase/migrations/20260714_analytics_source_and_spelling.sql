-- ============================================================================
-- 1. Expose parts.source on the part_insights view so the By-part analytics can
--    filter by origin (PartVault / eBay API / Imported history) like By-model
--    and By-car already do. Self-contained recreate of 20260627_insights_anchor.
-- 2. Vehicle-spelling cleanup: bulk-rename a misspelt make/model to a canonical
--    spelling across parts + cars, recorded so it can be undone.
--      source tokens: 'ebay_import' = eBay API sync · 'ebay_history' = CSV import
--      · anything else (manual/null) = PartVault.
--
-- Idempotent; apply via the Supabase SQL editor.
-- ============================================================================

begin;

-- ── 1. part_insights + source ───────────────────────────────────────────────
drop view if exists public.part_insights;
create view public.part_insights with (security_invoker = true) as
select
  p.id as part_id, p.store_id, p.sku, p.title, p.make, p.model, p.year, p.source,
  p.status, p.list_price, p.sold_price, p.shipping_charged, p.acquired_date, p.created_at, p.sold_date,
  p.market_price, p.market_count, p.market_checked_at,
  case when p.market_price > 0 and p.list_price > 0
    then round(((p.list_price - p.market_price) / p.market_price) * 100, 1)
  end as price_variance_pct,
  c.total_cost,
  coalesce(li.listing_count, 0) as listing_count,
  li.first_listed_at,
  coalesce(li.total_days_listed, 0)::int as total_days_listed,
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

-- ── 2. Spelling cleanup log (for undo) ──────────────────────────────────────
create table if not exists public.spelling_merges (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references public.stores(id) on delete cascade,
  kind          text not null,          -- 'make' | 'model'
  make          text,                    -- make context for a model merge
  canonical     text not null,           -- the chosen correct spelling
  variants      text[] not null,         -- the misspellings that were changed
  reversal      jsonb not null,          -- [{t:'parts'|'cars', id, val}] originals
  parts_changed int  not null default 0,
  cars_changed  int  not null default 0,
  created_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id) on delete set null,
  undone_at     timestamptz
);
create index if not exists spelling_merges_store_idx on public.spelling_merges (store_id, created_at desc);

alter table public.spelling_merges enable row level security;
drop policy if exists spelling_merges_select on public.spelling_merges;
create policy spelling_merges_select on public.spelling_merges
  for select using (public.is_store_member(store_id));

-- Bulk-rename make/model across parts + cars, capturing originals for undo.
create or replace function public.merge_vehicle_spelling(
  p_store_id uuid, p_kind text, p_make text, p_from text[], p_to text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_rev jsonb := '[]'::jsonb; v_parts int := 0; v_cars int := 0; v_op uuid;
begin
  if not public.has_permission(p_store_id, 'add_edit') then raise exception 'Unauthorised'; end if;
  if coalesce(p_to, '') = '' then raise exception 'Target spelling required'; end if;
  if p_from is null or array_length(p_from, 1) is null then raise exception 'Nothing to change'; end if;

  if p_kind = 'make' then
    select coalesce(jsonb_agg(jsonb_build_object('t','parts','id',id,'val',make)), '[]'::jsonb) into v_rev
      from public.parts where store_id = p_store_id and deleted_at is null and make = any(p_from) and make is distinct from p_to;
    with upd as (update public.parts set make = p_to
      where store_id = p_store_id and deleted_at is null and make = any(p_from) and make is distinct from p_to returning 1)
      select count(*) into v_parts from upd;
    v_rev := v_rev || (select coalesce(jsonb_agg(jsonb_build_object('t','cars','id',id,'val',make)), '[]'::jsonb)
      from public.cars where store_id = p_store_id and deleted_at is null and make = any(p_from) and make is distinct from p_to);
    with upd as (update public.cars set make = p_to
      where store_id = p_store_id and deleted_at is null and make = any(p_from) and make is distinct from p_to returning 1)
      select count(*) into v_cars from upd;

  elsif p_kind = 'model' then
    select coalesce(jsonb_agg(jsonb_build_object('t','parts','id',id,'val',model)), '[]'::jsonb) into v_rev
      from public.parts where store_id = p_store_id and deleted_at is null
        and make is not distinct from p_make and model = any(p_from) and model is distinct from p_to;
    with upd as (update public.parts set model = p_to
      where store_id = p_store_id and deleted_at is null and make is not distinct from p_make and model = any(p_from) and model is distinct from p_to returning 1)
      select count(*) into v_parts from upd;
    v_rev := v_rev || (select coalesce(jsonb_agg(jsonb_build_object('t','cars','id',id,'val',model)), '[]'::jsonb)
      from public.cars where store_id = p_store_id and deleted_at is null and make is not distinct from p_make and model = any(p_from) and model is distinct from p_to);
    with upd as (update public.cars set model = p_to
      where store_id = p_store_id and deleted_at is null and make is not distinct from p_make and model = any(p_from) and model is distinct from p_to returning 1)
      select count(*) into v_cars from upd;
  else
    raise exception 'Unknown kind %', p_kind;
  end if;

  insert into public.spelling_merges (store_id, kind, make, canonical, variants, reversal, parts_changed, cars_changed, created_by)
  values (p_store_id, p_kind, p_make, p_to, p_from, v_rev, v_parts, v_cars, auth.uid())
  returning id into v_op;

  return jsonb_build_object('op_id', v_op, 'parts', v_parts, 'cars', v_cars);
end $$;
grant execute on function public.merge_vehicle_spelling(uuid, text, text, text[], text) to authenticated;

-- Undo a merge: restore each affected row's original make/model.
create or replace function public.undo_spelling_merge(p_op_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_op public.spelling_merges; r jsonb; n int := 0;
begin
  select * into v_op from public.spelling_merges where id = p_op_id;
  if v_op.id is null then raise exception 'Merge not found'; end if;
  if not public.has_permission(v_op.store_id, 'add_edit') then raise exception 'Unauthorised'; end if;
  if v_op.undone_at is not null then raise exception 'Already undone'; end if;

  for r in select * from jsonb_array_elements(v_op.reversal) loop
    if r->>'t' = 'parts' then
      if v_op.kind = 'make' then update public.parts set make = r->>'val' where id = (r->>'id')::uuid;
      else update public.parts set model = r->>'val' where id = (r->>'id')::uuid; end if;
    else
      if v_op.kind = 'make' then update public.cars set make = r->>'val' where id = (r->>'id')::uuid;
      else update public.cars set model = r->>'val' where id = (r->>'id')::uuid; end if;
    end if;
    n := n + 1;
  end loop;

  update public.spelling_merges set undone_at = now() where id = p_op_id;
  return jsonb_build_object('restored', n);
end $$;
grant execute on function public.undo_spelling_merge(uuid) to authenticated;

commit;
