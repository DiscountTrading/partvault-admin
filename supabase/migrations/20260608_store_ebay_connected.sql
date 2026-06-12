-- ============================================================================
-- Fix: store switcher showed "eBay not connected" for stores that ARE connected.
--
-- get_my_stores() reported eBay status via the persisted *username string*
-- (coalesce(ebay_user, settings->>'ebayUsername')). That string is only written
-- after a successful GetUser call, so a store with a valid OAuth token but no
-- fetched username looked disconnected — disagreeing with the Settings panel,
-- which keys off the token's expiry (the real connection signal).
--
-- This adds an explicit ebay_connected boolean derived from a non-null token
-- expiry (app-config-only rows have null expires_at and are NOT a connection).
-- The username stays as a best-effort label. SECURITY DEFINER lets the function
-- read ebay_tokens past its admin-only RLS.
-- ============================================================================

begin;

drop function if exists public.get_my_stores();

create function public.get_my_stores()
returns table (
  store_id       uuid,
  store_name     text,
  role           text,
  join_code      text,
  ebay_user      text,
  ebay_connected boolean,
  is_default     boolean
)
language sql
security definer
stable
set search_path = public
as $$
  select
    s.id,
    s.name,
    m.role,
    s.join_code,
    coalesce(s.ebay_user, s.settings->>'ebayUsername'),
    exists (
      select 1 from public.ebay_tokens t
      where t.store_id = s.id and t.expires_at is not null
    ),
    (s.id = (select p.store_id from public.profiles p where p.user_id = auth.uid() limit 1))
  from public.store_members m
  join public.stores s on s.id = m.store_id
  where m.user_id = auth.uid()
  order by s.name;
$$;

grant execute on function public.get_my_stores() to authenticated;

commit;
