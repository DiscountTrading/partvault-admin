-- Store switcher was showing "connected" instead of the eBay account name
-- because coalesce() treats an empty-string ebay_user as a real value. Use
-- nullif so a blank falls through to settings.ebayUsername (populated when the
-- eBay account is fetched in Settings). Also keeps the deleted-store filter.
drop function if exists public.get_my_stores();
create function public.get_my_stores()
returns table (
  store_id uuid, store_name text, role text, join_code text,
  ebay_user text, ebay_connected boolean, is_default boolean
)
language sql security definer stable set search_path = public
as $$
  select s.id, s.name, m.role, s.join_code,
    coalesce(nullif(s.ebay_user, ''), nullif(s.settings->>'ebayUsername', '')),
    exists (select 1 from public.ebay_tokens t where t.store_id = s.id and t.expires_at is not null),
    (s.id = (select p.store_id from public.profiles p where p.user_id = auth.uid() limit 1))
  from public.store_members m
  join public.stores s on s.id = m.store_id
  where m.user_id = auth.uid() and s.deleted_at is null
  order by s.name;
$$;
grant execute on function public.get_my_stores() to authenticated;
