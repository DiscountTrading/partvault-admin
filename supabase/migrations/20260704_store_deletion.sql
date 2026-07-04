-- Store deletion & retention (docs/SUBSCRIPTIONS_AND_MULTI_COUNTRY.md §5-6).
-- Soft-delete → free self-restore within grace → archive → purge, all anchored
-- to paid_through. Uses dedicated columns (not plan) so it never trips the
-- plan-protect trigger. eBay tokens are revoked immediately on delete.

alter table public.stores add column if not exists deleted_at  timestamptz;
alter table public.stores add column if not exists grace_until timestamptz; -- free self-restore until this
alter table public.stores add column if not exists purge_after timestamptz; -- hard-delete becomes due at this

-- Hide deleted stores from everyone's store list (drives switcher + active store).
drop function if exists public.get_my_stores();
create function public.get_my_stores()
returns table (
  store_id uuid, store_name text, role text, join_code text,
  ebay_user text, ebay_connected boolean, is_default boolean
)
language sql security definer stable set search_path = public
as $$
  select s.id, s.name, m.role, s.join_code,
    coalesce(s.ebay_user, s.settings->>'ebayUsername'),
    exists (select 1 from public.ebay_tokens t where t.store_id = s.id and t.expires_at is not null),
    (s.id = (select p.store_id from public.profiles p where p.user_id = auth.uid() limit 1))
  from public.store_members m
  join public.stores s on s.id = m.store_id
  where m.user_id = auth.uid() and s.deleted_at is null
  order by s.name;
$$;
grant execute on function public.get_my_stores() to authenticated;

-- Recently-deleted stores the caller OWNS and can still recover.
create or replace function public.get_my_deleted_stores()
returns table (store_id uuid, store_name text, deleted_at timestamptz, purge_after timestamptz, free_restore boolean)
language sql security definer stable set search_path = public
as $$
  select s.id, s.name, s.deleted_at, s.purge_after, (now() <= s.grace_until)
  from public.store_members m
  join public.stores s on s.id = m.store_id
  where m.user_id = auth.uid() and m.role = 'owner'
    and s.deleted_at is not null and s.purge_after > now()
  order by s.deleted_at desc;
$$;
grant execute on function public.get_my_deleted_stores() to authenticated;

-- Delete a store (owner only). Soft by default; p_hard schedules immediate purge.
-- Retention anchor = paid_through (what they've paid for), else now.
create or replace function public.delete_store(p_store_id uuid, p_hard boolean default false)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_anchor timestamptz;
begin
  if not exists (select 1 from public.store_members where store_id = p_store_id and user_id = auth.uid() and role = 'owner') then
    raise exception 'Only the store owner can delete this store.';
  end if;
  select coalesce((plan->>'paid_through')::timestamptz, now()) into v_anchor from public.stores where id = p_store_id;
  update public.stores set
    deleted_at  = now(),
    grace_until = v_anchor + interval '30 days',
    purge_after = case when p_hard then now() else v_anchor + interval '12 months' end
  where id = p_store_id;
  -- Revoke eBay access immediately (also stops the nightly sync, which joins ebay_tokens).
  delete from public.ebay_tokens where store_id = p_store_id;
end $$;
grant execute on function public.delete_store(uuid, boolean) to authenticated;

-- Self-service restore — free, only within the grace window. Beyond that the
-- store is in archive and restoring requires a new 12-month plan (Billing).
create or replace function public.restore_store(p_store_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not exists (select 1 from public.store_members where store_id = p_store_id and user_id = auth.uid() and role = 'owner') then
    raise exception 'Only the store owner can restore this store.';
  end if;
  if not exists (select 1 from public.stores where id = p_store_id and deleted_at is not null and now() <= grace_until) then
    raise exception 'This store is in archive. Restoring it requires starting a new 12-month plan — do it from Billing.';
  end if;
  update public.stores set deleted_at = null, grace_until = null, purge_after = null where id = p_store_id;
end $$;
grant execute on function public.restore_store(uuid) to authenticated;

-- Daily SAFETY SCAN (report-only) of stores past their purge_after. This does
-- NOT delete anything — it emails an alert listing stores awaiting deletion.
-- Actual erasure only happens via a confirmed manual purge (edge action
-- purge_deleted_stores, which requires confirm + explicit store IDs).
-- Needs pg_cron + pg_net (already enabled).
select cron.schedule(
  'partvault-purge-deleted',
  '30 3 * * *',
  $cron$
  select net.http_post(
    url     := 'https://mtpektsxaklhedknincs.supabase.co/functions/v1/ebay-import',
    headers := jsonb_build_object('Content-Type','application/json','apikey','sb_publishable_STtCN1zWydiIFtgHR1Yn5g_n9YBH102'),
    body    := jsonb_build_object('action','purge_scan')
  );
  $cron$
);
