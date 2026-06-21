-- Nightly auto-sync: keep the database current with eBay every night, unattended.
-- All steps are READ-ONLY against eBay (import listings, update sold orders,
-- reconcile/flag) — nothing is pushed back to eBay.
--
-- Mechanism: pg_cron ticks every 2 minutes across the Sydney-midnight window
-- (13:00–15:59 UTC covers AEST and AEDT). Each tick calls the edge function's
-- `cron_sync` action per connected store, which advances that store's daily run
-- (import → sold orders → reconcile) and is idempotent once the day is done.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Per-store, per-day run state so the job resumes if a tick is interrupted.
create table if not exists public.sync_runs (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.stores(id) on delete cascade,
  run_date   date not null,
  phase      text not null default 'import',   -- import | backfill | reconcile | done
  job_id     uuid,
  detail     text,
  done       boolean not null default false,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, run_date)
);
alter table public.sync_runs enable row level security; -- service role (edge) only

-- Fan out a cron_sync call to every store that has eBay connected.
create or replace function public.trigger_nightly_sync() returns void
language plpgsql security definer set search_path = public as $$
declare s record;
begin
  for s in select distinct store_id from public.ebay_tokens loop
    perform net.http_post(
      url     := 'https://mtpektsxaklhedknincs.supabase.co/functions/v1/ebay-import',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', 'sb_publishable_STtCN1zWydiIFtgHR1Yn5g_n9YBH102'
      ),
      body    := jsonb_build_object('action', 'cron_sync', 'storeId', s.store_id)
    );
  end loop;
end; $$;

-- Schedule: every 2 minutes between 13:00 and 15:59 UTC (= ~23:00–02:00 Sydney,
-- spanning midnight in both AEST and AEDT). The run completes in the first few
-- ticks and no-ops for the rest of the window.
select cron.unschedule('partvault-nightly-sync')
  where exists (select 1 from cron.job where jobname = 'partvault-nightly-sync');
select cron.schedule('partvault-nightly-sync', '*/2 13-15 * * *',
  $$ select public.trigger_nightly_sync(); $$);
