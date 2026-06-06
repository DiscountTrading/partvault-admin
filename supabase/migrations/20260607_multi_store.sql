-- ============================================================================
-- Multi-store support: one user can belong to / manage many stores.
--
-- Before: each user mapped to exactly ONE store via profiles.store_id, and RLS
-- keyed off that single store. After: a store_members join table makes the
-- user<->store relationship many-to-many; RLS keys off membership.
--
-- Also fixes a pre-existing security gap: the `cars` policies were NOT store
-- scoped (only checked auth.uid() IS NOT NULL), so any logged-in user could
-- read/write every store's cars. Now membership-scoped, with a DELETE policy added.
--
-- Safe to run once. Wrapped in a transaction so a failure rolls back cleanly.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Membership table (many-to-many user <-> store)
-- ---------------------------------------------------------------------------
create table if not exists public.store_members (
  user_id    uuid not null references auth.users(id) on delete cascade,
  store_id   uuid not null references public.stores(id) on delete cascade,
  role       text not null default 'member',          -- 'owner' | 'admin' | 'member'
  created_at timestamptz not null default now(),
  primary key (user_id, store_id)
);

alter table public.store_members enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Membership helpers (SECURITY DEFINER => bypass RLS, no recursion)
-- ---------------------------------------------------------------------------
create or replace function public.is_store_member(p_store_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.store_members
    where store_id = p_store_id and user_id = auth.uid()
  );
$$;

create or replace function public.is_store_admin(p_store_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.store_members
    where store_id = p_store_id
      and user_id = auth.uid()
      and role in ('owner', 'admin')
  );
$$;

-- Resolve photo access through its parent (part/car) store membership
create or replace function public.can_access_photo(p_parent_type text, p_parent_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select case
    when p_parent_type = 'part' then exists (
      select 1 from public.parts p
      where p.id = p_parent_id and public.is_store_member(p.store_id)
    )
    when p_parent_type = 'car' then exists (
      select 1 from public.cars c
      where c.id = p_parent_id and public.is_store_member(c.store_id)
    )
    else false
  end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Backfill existing profiles -> memberships (nobody loses access)
--    Existing single-store users become members of their current store,
--    keeping their existing role.
-- ---------------------------------------------------------------------------
insert into public.store_members (user_id, store_id, role)
select user_id, store_id, coalesce(role, 'member')
from public.profiles
where user_id is not null and store_id is not null
on conflict (user_id, store_id) do nothing;

-- ---------------------------------------------------------------------------
-- 4. RLS on the membership table itself
-- ---------------------------------------------------------------------------
drop policy if exists store_members_select_own on public.store_members;
create policy store_members_select_own on public.store_members
  for select using (user_id = auth.uid());

-- Admins/owners can view & manage the membership of stores they administer
drop policy if exists store_members_admin_manage on public.store_members;
create policy store_members_admin_manage on public.store_members
  for all
  using (public.is_store_admin(store_id))
  with check (public.is_store_admin(store_id));

-- ---------------------------------------------------------------------------
-- 5. RPCs for the frontend
-- ---------------------------------------------------------------------------

-- All stores the current user can access (drives the store switcher).
create or replace function public.get_my_stores()
returns table (
  store_id   uuid,
  store_name text,
  role       text,
  join_code  text,
  ebay_user  text,
  is_default boolean
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
    (s.id = (select p.store_id from public.profiles p where p.user_id = auth.uid() limit 1))
  from public.store_members m
  join public.stores s on s.id = m.store_id
  where m.user_id = auth.uid()
  order by s.name;
$$;

-- Create a new store and make the caller its owner (atomic).
create or replace function public.create_store(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
begin
  if coalesce(trim(p_name), '') = '' then
    raise exception 'Store name is required';
  end if;

  insert into public.stores (name, join_code)
  values (p_name, upper(substr(md5(random()::text), 1, 6)))
  returning id into new_id;

  insert into public.store_members (user_id, store_id, role)
  values (auth.uid(), new_id, 'owner');

  return new_id;
end;
$$;

-- Join an existing store by its join code (membership role = member).
create or replace function public.join_store(p_join_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  s_id uuid;
begin
  select id into s_id from public.stores
  where join_code = upper(trim(p_join_code));

  if s_id is null then
    raise exception 'Invalid join code';
  end if;

  insert into public.store_members (user_id, store_id, role)
  values (auth.uid(), s_id, 'member')
  on conflict (user_id, store_id) do nothing;

  return s_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Rewrite RLS on scoped tables: profile-store checks -> membership checks
-- ---------------------------------------------------------------------------

-- cars (FIX: was unscoped — only checked auth.uid() IS NOT NULL)
drop policy if exists "Store members can insert cars" on public.cars;
drop policy if exists "Store members can update cars" on public.cars;
drop policy if exists "Store members can view cars"   on public.cars;
drop policy if exists cars_select on public.cars;
drop policy if exists cars_insert on public.cars;
drop policy if exists cars_update on public.cars;
drop policy if exists cars_delete on public.cars;
create policy cars_select on public.cars for select using (public.is_store_member(store_id));
create policy cars_insert on public.cars for insert with check (public.is_store_member(store_id));
create policy cars_update on public.cars for update using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
create policy cars_delete on public.cars for delete using (public.is_store_member(store_id));

-- parts
drop policy if exists parts_select on public.parts;
drop policy if exists parts_insert on public.parts;
drop policy if exists parts_update on public.parts;
drop policy if exists parts_delete on public.parts;
create policy parts_select on public.parts for select using (public.is_store_member(store_id));
create policy parts_insert on public.parts for insert with check (public.is_store_member(store_id));
create policy parts_update on public.parts for update using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
create policy parts_delete on public.parts for delete using (public.is_store_member(store_id));

-- listings
drop policy if exists listings_select on public.listings;
drop policy if exists listings_insert on public.listings;
drop policy if exists listings_update on public.listings;
drop policy if exists listings_delete on public.listings;
create policy listings_select on public.listings for select using (public.is_store_member(store_id));
create policy listings_insert on public.listings for insert with check (public.is_store_member(store_id));
create policy listings_update on public.listings for update using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));
create policy listings_delete on public.listings for delete using (public.is_store_member(store_id));

-- csv_exports (single ALL policy)
drop policy if exists csv_exports_store_access on public.csv_exports;
create policy csv_exports_store_access on public.csv_exports
  for all using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));

-- photos (scoped via parent part/car)
drop policy if exists photos_select on public.photos;
drop policy if exists photos_insert on public.photos;
drop policy if exists photos_update on public.photos;
drop policy if exists photos_delete on public.photos;
create policy photos_select on public.photos for select using (public.can_access_photo(parent_type, parent_id));
create policy photos_insert on public.photos for insert with check (public.can_access_photo(parent_type, parent_id));
create policy photos_update on public.photos for update using (public.can_access_photo(parent_type, parent_id));
create policy photos_delete on public.photos for delete using (public.can_access_photo(parent_type, parent_id));

-- ebay_tokens (admin/owner of the store only; writes done server-side via service_role)
drop policy if exists ebay_tokens_select on public.ebay_tokens;
create policy ebay_tokens_select on public.ebay_tokens
  for select using (public.is_store_admin(store_id));

-- stores
drop policy if exists "Store members can view their store" on public.stores;
drop policy if exists stores_select on public.stores;
create policy stores_select on public.stores for select using (public.is_store_member(id));
drop policy if exists "Store admins can update their store" on public.stores;
drop policy if exists stores_update on public.stores;
create policy stores_update on public.stores for update using (public.is_store_admin(id)) with check (public.is_store_admin(id));
-- (INSERT policy "Authenticated users can create stores" left intact)

-- profiles: view profiles belonging to any store you're a member of
drop policy if exists "View profiles in same store" on public.profiles;
create policy "View profiles in same store" on public.profiles
  for select using (public.is_store_member(store_id));
-- ("Own profile full access" left intact)

-- ---------------------------------------------------------------------------
-- 7. Grants — allow the authenticated role to call the RPCs/helpers
-- ---------------------------------------------------------------------------
grant execute on function public.is_store_member(uuid)            to authenticated;
grant execute on function public.is_store_admin(uuid)             to authenticated;
grant execute on function public.can_access_photo(text, uuid)     to authenticated;
grant execute on function public.get_my_stores()                  to authenticated;
grant execute on function public.create_store(text)               to authenticated;
grant execute on function public.join_store(text)                 to authenticated;

commit;
