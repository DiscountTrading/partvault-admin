-- ============================================================================
-- PartVault — pending migrations bundle (2026-07-19)
-- Paste the whole thing into the Supabase SQL editor and run once.
-- All idempotent. Ordered so the additive ones apply first; the SKU backstop
-- runs LAST because it's the only block that can stop early (if real duplicate
-- SKUs still exist). If it stops there, everything above has already applied —
-- resolve the named duplicates and re-run just section 4.
-- ============================================================================

-- 1) parts.ebay_specifics — cache for the background eBay-specifics step -------
alter table public.parts add column if not exists ebay_specifics jsonb;

-- 2) ebay_sales discount capture ---------------------------------------------
alter table public.ebay_sales add column if not exists discount numeric;
alter table public.ebay_sales add column if not exists applied_promotions jsonb;

-- 3) configurable auto-sync interval -----------------------------------------
begin;

alter table public.sync_runs add column if not exists run_slot int not null default 0;
alter table public.sync_runs drop constraint if exists sync_runs_store_id_run_date_key;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sync_runs_store_run_slot_key') then
    alter table public.sync_runs add constraint sync_runs_store_run_slot_key unique (store_id, run_date, run_slot);
  end if;
end $$;

create or replace function public.trigger_nightly_sync() returns void
language plpgsql security definer set search_path = public as $$
declare
  s          record;
  tz         text;
  local_hour int;
  local_date text;
  every      int;
begin
  for s in
    select distinct t.store_id, st.settings as settings
    from public.ebay_tokens t
    join public.stores st on st.id = t.store_id
  loop
    tz := coalesce(nullif(s.settings->>'timezone', ''), 'Australia/Sydney');
    begin
      local_hour := extract(hour from (now() at time zone tz))::int;
      local_date := to_char((now() at time zone tz), 'YYYY-MM-DD');
    exception when others then
      tz := 'Australia/Sydney';
      local_hour := extract(hour from (now() at time zone tz))::int;
      local_date := to_char((now() at time zone tz), 'YYYY-MM-DD');
    end;

    every := coalesce(nullif(s.settings->>'syncIntervalHours', '')::int, 24);
    if every < 3 then every := 3; end if;

    if (local_hour % every) = 0 then
      perform net.http_post(
        url     := 'https://mtpektsxaklhedknincs.supabase.co/functions/v1/ebay-import',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'apikey', 'sb_publishable_STtCN1zWydiIFtgHR1Yn5g_n9YBH102'
        ),
        body    := jsonb_build_object('action', 'cron_sync', 'storeId', s.store_id, 'runDate', local_date, 'runSlot', local_hour)
      );
    end if;
  end loop;
end; $$;

commit;

-- 4) SKU unique backstop (LAST — may stop here if duplicates still exist) ------
update public.parts set sku = null where sku = '';

do $$
declare
  v_dupes text;
begin
  select string_agg(format('store %s / sku %L (%s copies)', store_id, sku, cnt), '; ')
    into v_dupes
    from (
      select store_id, sku, count(*) as cnt
        from public.parts
       where sku is not null
       group by store_id, sku
      having count(*) > 1
    ) d;

  if v_dupes is not null then
    raise exception
      'Cannot add unique SKU index — duplicates still exist: %. Resolve them then re-run this section.',
      v_dupes;
  end if;
end $$;

create unique index if not exists parts_store_sku_unique
  on public.parts (store_id, sku)
  where sku is not null;
