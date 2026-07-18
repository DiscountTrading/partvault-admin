-- ============================================================================
-- Configurable eBay auto-sync interval (per store).
--
--  • stores.settings->>'syncIntervalHours' — 3 / 6 / 12 / 24, default 24 (nightly),
--    floored at 3h server-side to stay well within eBay's API limits.
--  • sync_runs gains run_slot so more than one resumable run per local day is
--    tracked (slot = the local hour the window started, e.g. 0/6/12/18 for 6h).
--  • The cron (ticks every 5 min) now fires the full cron_sync at each interval
--    boundary in the store's own timezone, not just local midnight.
--
-- Idempotent. Apply via the Supabase SQL editor.
-- ============================================================================
begin;

-- 1. Track >1 run per local day. Existing rows default to slot 0 (the old nightly).
alter table public.sync_runs add column if not exists run_slot int not null default 0;
alter table public.sync_runs drop constraint if exists sync_runs_store_id_run_date_key;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sync_runs_store_run_slot_key') then
    alter table public.sync_runs add constraint sync_runs_store_run_slot_key unique (store_id, run_date, run_slot);
  end if;
end $$;

-- 2. Interval-aware cron: fire the full cron_sync at each interval boundary in the
--    store's timezone. Passes run_slot so each window is its own resumable run.
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

    -- Per-store interval (hours). Default 24 (nightly); never below 3.
    every := coalesce(nullif(s.settings->>'syncIntervalHours', '')::int, 24);
    if every < 3 then every := 3; end if;

    -- Fire at each interval boundary (6h → hours 0,6,12,18). The resumable run for
    -- this window (run_date + run_slot = local_hour) completes across the hour's
    -- 5-minute ticks, then no-ops until the next boundary.
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
