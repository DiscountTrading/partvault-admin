-- Platform-management RPCs for the standalone Ops console (ops.html) — lets a
-- platform admin manage stores, users and memberships from the app instead of
-- the Supabase dashboard. Every function is SECURITY DEFINER and refuses any
-- caller who isn't in platform_admins (is_platform_admin()); normal RLS makes
-- these rows invisible to customer sessions. Idempotent: safe to re-run.

-- All stores (incl. soft-deleted, so grace/purge state is visible) with the
-- headline numbers the console lists them by.
create or replace function public.ops_list_stores()
returns table (
  id uuid, name text, created_at timestamptz, deleted_at timestamptz,
  grace_until timestamptz, subscription_tier text, plan jsonb, join_code text,
  ebay_user text, ebay_connected boolean, marketplace text,
  members bigint, parts bigint, live_listings bigint, sales bigint, sample boolean
) language sql stable security definer set search_path = public as $$
  select s.id, s.name, s.created_at, s.deleted_at, s.grace_until,
         s.subscription_tier, s.plan, s.join_code,
         s.ebay_user, exists (select 1 from ebay_tokens t where t.store_id = s.id) as ebay_connected,
         s.settings->>'marketplace' as marketplace,
         (select count(*) from store_members m where m.store_id = s.id) as members,
         (select count(*) from parts p where p.store_id = s.id and p.deleted_at is null) as parts,
         (select count(*) from listings l where l.store_id = s.id and l.status = 'live' and l.deleted_at is null) as live_listings,
         (select count(*) from ebay_sales es where es.store_id = s.id and not es.cancelled) as sales,
         exists (select 1 from parts p where p.store_id = s.id and p.is_sample) as sample
  from stores s
  where is_platform_admin()
  order by s.created_at desc
$$;

-- Every signed-up user with their memberships. auth.users is only reachable
-- because this runs as definer; the is_platform_admin() gate is the lock.
create or replace function public.ops_list_users()
returns table (
  id uuid, email text, created_at timestamptz, last_sign_in_at timestamptz,
  memberships jsonb
) language sql stable security definer set search_path = public as $$
  select u.id, u.email::text, u.created_at, u.last_sign_in_at,
         coalesce((
           select jsonb_agg(jsonb_build_object('store_id', m.store_id, 'store', s.name, 'role', m.role) order by s.name)
           from store_members m join stores s on s.id = m.store_id
           where m.user_id = u.id
         ), '[]'::jsonb) as memberships
  from auth.users u
  where is_platform_admin()
  order by u.created_at desc
$$;

-- Members of one store, with emails resolved.
create or replace function public.ops_store_members(p_store_id uuid)
returns table (user_id uuid, email text, role text, permissions jsonb, created_at timestamptz, last_sign_in_at timestamptz)
language sql stable security definer set search_path = public as $$
  select m.user_id, u.email::text, m.role, m.permissions, m.created_at, u.last_sign_in_at
  from store_members m join auth.users u on u.id = m.user_id
  where is_platform_admin() and m.store_id = p_store_id
  order by m.created_at
$$;

-- Change a member's role. Refuses to demote the last owner so a store can
-- never end up unmanageable.
create or replace function public.ops_set_member_role(p_store_id uuid, p_user_id uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_platform_admin() then raise exception 'Not authorised'; end if;
  if p_role not in ('owner', 'member', 'worker') then raise exception 'Invalid role %', p_role; end if;
  if p_role <> 'owner' and (select count(*) from store_members where store_id = p_store_id and role = 'owner') = 1
     and exists (select 1 from store_members where store_id = p_store_id and user_id = p_user_id and role = 'owner') then
    raise exception 'This is the store''s only owner — promote someone else to owner first';
  end if;
  update store_members set role = p_role where store_id = p_store_id and user_id = p_user_id;
  if not found then raise exception 'No such membership'; end if;
end $$;

-- Remove a member from a store (same last-owner guard).
create or replace function public.ops_remove_member(p_store_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_platform_admin() then raise exception 'Not authorised'; end if;
  if (select count(*) from store_members where store_id = p_store_id and role = 'owner') = 1
     and exists (select 1 from store_members where store_id = p_store_id and user_id = p_user_id and role = 'owner') then
    raise exception 'This is the store''s only owner — promote someone else to owner first';
  end if;
  delete from store_members where store_id = p_store_id and user_id = p_user_id;
  if not found then raise exception 'No such membership'; end if;
end $$;

-- Add an existing signed-up user to a store by email.
create or replace function public.ops_add_member(p_store_id uuid, p_email text, p_role text default 'member')
returns void language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  if not is_platform_admin() then raise exception 'Not authorised'; end if;
  if p_role not in ('owner', 'member', 'worker') then raise exception 'Invalid role %', p_role; end if;
  select id into v_user from auth.users where lower(email) = lower(trim(p_email)) limit 1;
  if v_user is null then raise exception 'No account found for % — they need to sign up first', p_email; end if;
  if exists (select 1 from store_members where store_id = p_store_id and user_id = v_user) then
    raise exception '% is already a member of this store', p_email;
  end if;
  insert into store_members (store_id, user_id, role) values (p_store_id, v_user, p_role);
end $$;

-- Lock the definer functions down: only signed-in sessions may even call them
-- (the admin check inside is the real gate).
revoke all on function public.ops_list_stores() from public, anon;
revoke all on function public.ops_list_users() from public, anon;
revoke all on function public.ops_store_members(uuid) from public, anon;
revoke all on function public.ops_set_member_role(uuid, uuid, text) from public, anon;
revoke all on function public.ops_remove_member(uuid, uuid) from public, anon;
revoke all on function public.ops_add_member(uuid, text, text) from public, anon;
grant execute on function public.ops_list_stores() to authenticated;
grant execute on function public.ops_list_users() to authenticated;
grant execute on function public.ops_store_members(uuid) to authenticated;
grant execute on function public.ops_set_member_role(uuid, uuid, text) to authenticated;
grant execute on function public.ops_remove_member(uuid, uuid) to authenticated;
grant execute on function public.ops_add_member(uuid, text, text) to authenticated;
