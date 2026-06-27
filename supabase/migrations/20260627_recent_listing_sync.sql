-- Frequent, low-impact "catch new listings" check.
--
-- The pg_cron job partvault-nightly-sync already ticks every 5 minutes but only
-- acts at each store's local midnight (full cron_sync). This adds a lightweight
-- branch: on every OTHER tick (i.e. every 5 min during the day) it calls the new
-- `import_recent` edge action, which makes ONE GetSellerList call over a short
-- window and imports only listings not already in the DB. So a freshly-listed
-- item appears in PartVault within ~5 minutes instead of waiting for the nightly.
--
-- Cost: ~1 eBay API call per tick when nothing is new (~288/day, well under the
-- 5,000/day Trading limit). Read-only against eBay; purely additive in our DB.
-- The full sold-orders / fees / reconcile work stays on the nightly run.

begin;

create or replace function public.trigger_nightly_sync() returns void
language plpgsql security definer set search_path = public as $$
declare
  s          record;
  tz         text;
  local_hour int;
  local_date text;
  v_url text := 'https://mtpektsxaklhedknincs.supabase.co/functions/v1/ebay-import';
  v_key text := 'sb_publishable_STtCN1zWydiIFtgHR1Yn5g_n9YBH102';
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

    if local_hour = 0 then
      -- Full nightly sync at the store's local midnight.
      perform net.http_post(
        url     := v_url,
        headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', v_key),
        body    := jsonb_build_object('action', 'cron_sync', 'storeId', s.store_id, 'runDate', local_date)
      );
    else
      -- Lightweight new-listings check every 5 min during the day.
      perform net.http_post(
        url     := v_url,
        headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', v_key),
        body    := jsonb_build_object('action', 'import_recent', 'storeId', s.store_id, 'days', 3)
      );
    end if;
  end loop;
end; $$;

-- The cron job already runs '*/5 * * * *' calling trigger_nightly_sync(), so the
-- create-or-replace above is enough. Re-assert the schedule safely (unschedule if
-- present, then schedule) so this migration also works on a fresh database without
-- creating a duplicate job.
select cron.unschedule('partvault-nightly-sync')
  where exists (select 1 from cron.job where jobname = 'partvault-nightly-sync');
select cron.schedule('partvault-nightly-sync', '*/5 * * * *',
  $$ select public.trigger_nightly_sync(); $$);

commit;
