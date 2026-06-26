-- The sync page never showed a "last run" because:
--   1. sync_runs has RLS enabled with NO select policy for users (edge/service
--      role only), but the banner reads it client-side as the logged-in user —
--      so the query was silently blocked and always returned nothing.
--   2. Only the nightly cron writes sync_runs; manual syncs write the audit_log
--      'sync' summary instead, so they never appeared either.
--
-- Fix: (a) let store members read their own sync_runs (for live nightly progress),
-- and (b) add get_last_sync() returning the most recent sync of ANY kind (manual
-- or nightly) from the audit_log, so the page can always show when it last ran.

-- (a) Store members can read their store's nightly run state.
drop policy if exists sync_runs_select on public.sync_runs;
create policy sync_runs_select on public.sync_runs
  for select using (public.is_store_member(store_id));

-- (b) Last sync of any kind (manual log_sync OR nightly cron_sync both write a
-- 'sync' row into audit_log on completion/failure).
create or replace function public.get_last_sync(p_store_id uuid)
returns table (synced_at timestamptz, summary text, kind text, ok boolean)
language sql security definer stable set search_path = public as $$
  select
    a.changed_at,
    coalesce(a.new_data->>'summary', 'eBay sync'),
    coalesce(a.new_data->>'kind', 'sync'),
    coalesce((a.new_data->>'ok')::boolean, true)
  from public.audit_log a
  where a.store_id = p_store_id
    and a.table_name = 'sync'
    and public.is_store_member(p_store_id)
  order by a.changed_at desc
  limit 1;
$$;
grant execute on function public.get_last_sync(uuid) to authenticated;
