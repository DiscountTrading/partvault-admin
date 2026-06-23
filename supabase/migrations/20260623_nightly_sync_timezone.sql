-- Make the nightly auto-sync timezone-aware so PartVault works worldwide.
--
-- Before: a fixed UTC window (13:00–15:59) hard-coded to Sydney midnight. Wrong
-- for any store outside AU. Now: the cron ticks every 5 minutes, 24/7, and only
-- fires a store when it is currently the midnight hour IN THAT STORE'S timezone
-- (stores.settings->>'timezone', an IANA name captured from the browser, editable
-- in Settings). The store's LOCAL date is passed as run_date so sync_runs stays
-- one-row-per-local-day and idempotent.

begin;

create or replace function public.trigger_nightly_sync() returns void
language plpgsql security definer set search_path = public as $$
declare
  s          record;
  tz         text;
  local_hour int;
  local_date text;
begin
  for s in
    select distinct t.store_id, st.settings as settings
    from public.ebay_tokens t
    join public.stores st on st.id = t.store_id
  loop
    -- Fall back to Sydney if a store hasn't set a timezone yet.
    tz := coalesce(nullif(s.settings->>'timezone', ''), 'Australia/Sydney');
    begin
      local_hour := extract(hour from (now() at time zone tz))::int;
      local_date := to_char((now() at time zone tz), 'YYYY-MM-DD');
    exception when others then
      -- Bad/unknown tz string → treat as Sydney so the store still syncs.
      tz := 'Australia/Sydney';
      local_hour := extract(hour from (now() at time zone tz))::int;
      local_date := to_char((now() at time zone tz), 'YYYY-MM-DD');
    end;

    -- Only during the store's local midnight hour. The resumable run finishes
    -- across the hour's ticks and no-ops once that local day is done.
    if local_hour = 0 then
      perform net.http_post(
        url     := 'https://mtpektsxaklhedknincs.supabase.co/functions/v1/ebay-import',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'apikey', 'sb_publishable_STtCN1zWydiIFtgHR1Yn5g_n9YBH102'
        ),
        body    := jsonb_build_object('action', 'cron_sync', 'storeId', s.store_id, 'runDate', local_date)
      );
    end if;
  end loop;
end; $$;

-- Reschedule: every 5 minutes, all hours (the function gates on local midnight).
select cron.unschedule('partvault-nightly-sync')
  where exists (select 1 from cron.job where jobname = 'partvault-nightly-sync');
select cron.schedule('partvault-nightly-sync', '*/5 * * * *',
  $$ select public.trigger_nightly_sync(); $$);

commit;
