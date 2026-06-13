-- ============================================================================
-- Per-user, per-capability permissions (replaces coarse owner/admin/member).
--
-- Each membership carries a `permissions` JSON of capability flags. The store
-- OWNER always has every capability and can never be locked out (anti-lockout
-- guardrail). Everyone else is fully customizable via the admin "User Access"
-- page. Enforcement is in the DATABASE (RLS + a soft-delete trigger + gated
-- RPCs) so unchecking a box actually removes the ability, not just the button.
--
-- Capabilities: add_edit | delete | publish | settings | manage_users
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. permissions column + backfill from existing roles
-- ---------------------------------------------------------------------------
alter table public.store_members
  add column if not exists permissions jsonb not null default '{}'::jsonb;

-- Anti-lockout: guarantee every store has exactly one unremovable owner. Older
-- stores (backfilled from profiles) may only have 'admin' members and no owner;
-- promote one (prefer an existing admin, else the earliest member) to owner.
with to_promote as (
  select distinct on (sm.store_id) sm.store_id, sm.user_id
  from public.store_members sm
  where not exists (
    select 1 from public.store_members o where o.store_id = sm.store_id and o.role = 'owner'
  )
  order by sm.store_id, (sm.role = 'admin') desc, sm.created_at asc
)
update public.store_members m
   set role = 'owner'
  from to_promote t
 where m.store_id = t.store_id and m.user_id = t.user_id;

-- Existing admins -> everything; existing members -> capture only.
-- Owners are left as-is (they bypass the flags entirely, see has_permission).
update public.store_members
   set permissions = '{"add_edit":true,"delete":true,"publish":true,"settings":true,"manage_users":true}'::jsonb
 where role = 'admin' and permissions = '{}'::jsonb;

update public.store_members
   set permissions = '{"add_edit":true}'::jsonb
 where role = 'member' and permissions = '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- 2. has_permission(): owner => always true; otherwise the flag must be set.
--    SECURITY DEFINER so it can read store_members past that table's own RLS.
-- ---------------------------------------------------------------------------
create or replace function public.has_permission(p_store_id uuid, p_capability text)
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
      and (role = 'owner' or coalesce((permissions ->> p_capability)::boolean, false))
  );
$$;

grant execute on function public.has_permission(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Cars/parts: add/edit gated by add_edit; hard-delete gated by delete.
-- ---------------------------------------------------------------------------
drop policy if exists parts_insert on public.parts;
drop policy if exists parts_update on public.parts;
drop policy if exists parts_delete on public.parts;
create policy parts_insert on public.parts for insert with check (public.has_permission(store_id, 'add_edit'));
create policy parts_update on public.parts for update using (public.has_permission(store_id, 'add_edit')) with check (public.has_permission(store_id, 'add_edit'));
create policy parts_delete on public.parts for delete using (public.has_permission(store_id, 'delete'));

drop policy if exists cars_insert on public.cars;
drop policy if exists cars_update on public.cars;
drop policy if exists cars_delete on public.cars;
create policy cars_insert on public.cars for insert with check (public.has_permission(store_id, 'add_edit'));
create policy cars_update on public.cars for update using (public.has_permission(store_id, 'add_edit')) with check (public.has_permission(store_id, 'add_edit'));
create policy cars_delete on public.cars for delete using (public.has_permission(store_id, 'delete'));

-- Soft-delete is an UPDATE of deleted_at, so the add_edit update policy would
-- otherwise let a worker "delete". Block any change to deleted_at unless the
-- caller has the delete capability. Covers delete AND restore.
create or replace function public.enforce_delete_permission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.deleted_at is distinct from OLD.deleted_at then
    if not public.has_permission(OLD.store_id, 'delete') then
      raise exception 'Not authorised to delete in this store';
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_parts_delete_perm on public.parts;
create trigger trg_parts_delete_perm before update on public.parts
  for each row execute function public.enforce_delete_permission();

drop trigger if exists trg_cars_delete_perm on public.cars;
create trigger trg_cars_delete_perm before update on public.cars
  for each row execute function public.enforce_delete_permission();

-- ---------------------------------------------------------------------------
-- 4. Settings / eBay gated by `settings`; team gated by `manage_users`.
--    (Replaces the old is_store_admin checks on these.)
-- ---------------------------------------------------------------------------
drop policy if exists stores_update on public.stores;
create policy stores_update on public.stores
  for update using (public.has_permission(id, 'settings')) with check (public.has_permission(id, 'settings'));

drop policy if exists ebay_tokens_select on public.ebay_tokens;
create policy ebay_tokens_select on public.ebay_tokens
  for select using (public.has_permission(store_id, 'settings'));

drop policy if exists store_members_admin_manage on public.store_members;
create policy store_members_admin_manage on public.store_members
  for all
  using (public.has_permission(store_id, 'manage_users'))
  with check (public.has_permission(store_id, 'manage_users'));

-- eBay credential RPCs: authorize on the settings capability instead of admin role
create or replace function public.set_ebay_cert_id(p_store_id uuid, p_cert_id text)
returns void language plpgsql security definer set search_path to 'public', 'vault'
as $function$
declare v_existing_vault_id uuid; v_new_secret_id uuid;
begin
  if not public.has_permission(p_store_id, 'settings') then raise exception 'Unauthorised'; end if;
  select cert_id_id into v_existing_vault_id from public.ebay_tokens where store_id = p_store_id;
  if v_existing_vault_id is not null then
    perform vault.update_secret(v_existing_vault_id, p_cert_id);
  else
    v_new_secret_id := vault.create_secret(p_cert_id, 'ebay_cert_' || p_store_id::text);
    insert into public.ebay_tokens (store_id, cert_id_id) values (p_store_id, v_new_secret_id)
    on conflict (store_id) do update set cert_id_id = excluded.cert_id_id;
  end if;
end;
$function$;

create or replace function public.set_ebay_app_config(p_store_id uuid, p_app_id text, p_ru_name text)
returns void language plpgsql security definer set search_path to 'public'
as $function$
begin
  if not public.has_permission(p_store_id, 'settings') then raise exception 'Unauthorised'; end if;
  insert into public.ebay_tokens (store_id, app_id, ru_name) values (p_store_id, p_app_id, p_ru_name)
  on conflict (store_id) do update set app_id = excluded.app_id, ru_name = excluded.ru_name;
end;
$function$;

create or replace function public.disconnect_ebay(p_store_id uuid)
returns void language plpgsql security definer set search_path to 'public'
as $function$
begin
  if not public.has_permission(p_store_id, 'settings') then raise exception 'Unauthorised'; end if;
  update public.ebay_tokens
     set expires_at = null, expires_in = null, access_token_id = null, refresh_token_id = null, updated_at = now()
   where store_id = p_store_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. New members (join_store) start with capture-only (Add/Edit).
-- ---------------------------------------------------------------------------
create or replace function public.join_store(p_join_code text)
returns uuid language plpgsql security definer set search_path = public
as $$
declare s_id uuid;
begin
  select id into s_id from public.stores where join_code = upper(trim(p_join_code));
  if s_id is null then raise exception 'Invalid join code'; end if;
  insert into public.store_members (user_id, store_id, role, permissions)
  values (auth.uid(), s_id, 'member', '{"add_edit":true}'::jsonb)
  on conflict (user_id, store_id) do nothing;
  return s_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Team-management RPCs for the User Access page (all gated by manage_users,
--    all protect the owner row).
-- ---------------------------------------------------------------------------
create or replace function public.get_store_members(p_store_id uuid)
returns table (user_id uuid, email text, name text, role text, permissions jsonb)
language sql security definer stable set search_path = public
as $$
  select m.user_id, u.email, p.name, m.role, m.permissions
  from public.store_members m
  join auth.users u on u.id = m.user_id
  left join public.profiles p on p.user_id = m.user_id
  where m.store_id = p_store_id
    and public.has_permission(p_store_id, 'manage_users')
  order by (m.role = 'owner') desc, u.email;
$$;

create or replace function public.set_member_permissions(p_store_id uuid, p_user_id uuid, p_permissions jsonb)
returns void language plpgsql security definer set search_path = public
as $$
declare v_role text;
begin
  if not public.has_permission(p_store_id, 'manage_users') then raise exception 'Unauthorised'; end if;
  select role into v_role from public.store_members where store_id = p_store_id and user_id = p_user_id;
  if v_role is null then raise exception 'Not a member of this store'; end if;
  if v_role = 'owner' then raise exception 'The store owner always has full access'; end if;
  update public.store_members set permissions = coalesce(p_permissions, '{}'::jsonb)
   where store_id = p_store_id and user_id = p_user_id;
end;
$$;

create or replace function public.remove_member(p_store_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare v_role text;
begin
  if not public.has_permission(p_store_id, 'manage_users') then raise exception 'Unauthorised'; end if;
  select role into v_role from public.store_members where store_id = p_store_id and user_id = p_user_id;
  if v_role = 'owner' then raise exception 'The store owner cannot be removed'; end if;
  delete from public.store_members where store_id = p_store_id and user_id = p_user_id;
end;
$$;

grant execute on function public.get_store_members(uuid)                 to authenticated;
grant execute on function public.set_member_permissions(uuid, uuid, jsonb) to authenticated;
grant execute on function public.remove_member(uuid, uuid)              to authenticated;

commit;
