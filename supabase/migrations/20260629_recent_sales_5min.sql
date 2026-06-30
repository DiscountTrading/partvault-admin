-- Live sales: on each 5-minute daytime tick, also pull NEW sales from the last 2
-- days (alongside the existing new-listings check), so a sale appears in PartVault
-- within ~5 minutes instead of waiting for the nightly. Lightweight: import_sold_orders
-- upserts ebay_sales (idempotent on order+line) and marks the matched part Sold — it
-- does NOT run fees/reconcile/cost (those stay on the nightly cron_sync at midnight).
-- One extra eBay call per tick (~288/day, well under the 5,000/day limit).
-- Pairs with realtime on ebay_sales so the UI updates without a refresh.

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
      -- NEW: lightweight new-SALES delta (last 2 days) so sales land within ~5 min.
      -- Capture only — fees/reconcile/cost remain on the nightly run.
      perform net.http_post(
        url     := v_url,
        headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', v_key),
        body    := jsonb_build_object('action', 'import_sold_orders', 'storeId', s.store_id, 'days', 2)
      );
    end if;
  end loop;
end; $$;
