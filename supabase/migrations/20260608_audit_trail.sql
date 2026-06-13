-- ============================================================================
-- Audit trail — REUSE the existing system, don't recreate it.
--
-- The database already has a populated `audit_log` (id, store_id, table_name,
-- record_id, action, old_data, new_data, changed_by, changed_at) fed by the
-- generic trigger function `log_audit_event()`, currently attached to jobs,
-- listings, and parts. This migration:
--   1. Extends that same logging to `cars`.
--   2. Logs user-access changes (permissions / add / remove) from the team RPCs.
--   3. Adds a read-side `get_audit_log` RPC (SECURITY DEFINER, manage_users-gated)
--      that maps the real columns and synthesises readable summaries.
-- It does NOT touch the existing table, its rows, or its existing SELECT policy
-- (the read RPC is SECURITY DEFINER, so it works regardless of that policy).
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Extend the existing audit logging to cars (same function as parts)
-- ---------------------------------------------------------------------------
drop trigger if exists cars_audit on public.cars;
create trigger cars_audit
  after insert or update or delete on public.cars
  for each row execute function public.log_audit_event();

-- ---------------------------------------------------------------------------
-- 2. Log user-access changes into the same audit_log. store_members has a
--    composite key (no single id) so we log explicitly from the RPCs, with
--    before/after permissions, rather than via a row trigger.
-- ---------------------------------------------------------------------------
create or replace function public.set_member_permissions(p_store_id uuid, p_user_id uuid, p_permissions jsonb)
returns void language plpgsql security definer set search_path = public
as $$
declare v_role text; v_old jsonb;
begin
  if not public.has_permission(p_store_id, 'manage_users') then raise exception 'Unauthorised'; end if;
  select role, permissions into v_role, v_old from public.store_members where store_id = p_store_id and user_id = p_user_id;
  if v_role is null then raise exception 'Not a member of this store'; end if;
  if v_role = 'owner' then raise exception 'The store owner always has full access'; end if;
  update public.store_members set permissions = coalesce(p_permissions, '{}'::jsonb)
   where store_id = p_store_id and user_id = p_user_id;
  insert into public.audit_log (id, store_id, table_name, record_id, action, old_data, new_data, changed_by, changed_at)
  values (gen_random_uuid(), p_store_id, 'store_members', p_user_id, 'UPDATE',
          jsonb_build_object('permissions', v_old),
          jsonb_build_object('permissions', coalesce(p_permissions, '{}'::jsonb)),
          auth.uid(), now());
end;
$$;

create or replace function public.remove_member(p_store_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare v_role text; v_perms jsonb;
begin
  if not public.has_permission(p_store_id, 'manage_users') then raise exception 'Unauthorised'; end if;
  select role, permissions into v_role, v_perms from public.store_members where store_id = p_store_id and user_id = p_user_id;
  if v_role = 'owner' then raise exception 'The store owner cannot be removed'; end if;
  delete from public.store_members where store_id = p_store_id and user_id = p_user_id;
  insert into public.audit_log (id, store_id, table_name, record_id, action, old_data, new_data, changed_by, changed_at)
  values (gen_random_uuid(), p_store_id, 'store_members', p_user_id, 'DELETE',
          jsonb_build_object('role', v_role, 'permissions', v_perms), null, auth.uid(), now());
end;
$$;

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
  if found then
    insert into public.audit_log (id, store_id, table_name, record_id, action, old_data, new_data, changed_by, changed_at)
    values (gen_random_uuid(), s_id, 'store_members', auth.uid(), 'INSERT',
            null, jsonb_build_object('role', 'member', 'permissions', '{"add_edit":true}'::jsonb), auth.uid(), now());
  end if;
  return s_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Read RPC for the Activity view — maps real columns, synthesises summaries,
--    normalises soft-delete (deleted_at) to delete/restore, gates on manage_users.
-- ---------------------------------------------------------------------------
create or replace function public.get_audit_log(p_store_id uuid, p_limit int default 300)
returns table (id uuid, created_at timestamptz, user_email text, action text, entity_type text, summary text)
language sql security definer stable set search_path = public
as $$
  select
    a.id,
    a.changed_at,
    u.email,
    case
      when a.table_name = 'store_members' then
        case lower(a.action) when 'insert' then 'member_added' when 'delete' then 'member_removed' else 'member_updated' end
      when lower(a.action) = 'update' and (a.new_data->>'deleted_at') is not null and (a.old_data->>'deleted_at') is null then 'delete'
      when lower(a.action) = 'update' and (a.new_data->>'deleted_at') is null and (a.old_data->>'deleted_at') is not null then 'restore'
      else lower(a.action)
    end as action,
    a.table_name,
    case a.table_name
      when 'parts' then 'part ' || coalesce(a.new_data->>'title', a.old_data->>'title', '')
        || case when lower(a.action) = 'update' and (a.new_data->>'status') is distinct from (a.old_data->>'status')
                then ' (' || coalesce(a.old_data->>'status','') || ' → ' || coalesce(a.new_data->>'status','') || ')' else '' end
      when 'cars' then 'car ' || coalesce(a.new_data->>'make', a.old_data->>'make', '') || ' ' || coalesce(a.new_data->>'model', a.old_data->>'model', '')
      when 'listings' then 'listing ' || coalesce(a.new_data->>'platform_sku', a.old_data->>'platform_sku', '')
      when 'store_members' then case lower(a.action)
        when 'insert' then 'user added to store'
        when 'delete' then 'user removed from store'
        else 'user access changed' end
      else a.table_name
    end as summary
  from public.audit_log a
  left join auth.users u on u.id = a.changed_by
  where a.store_id = p_store_id
    and public.has_permission(p_store_id, 'manage_users')
  order by a.changed_at desc
  limit greatest(1, least(p_limit, 1000));
$$;

grant execute on function public.get_audit_log(uuid, int) to authenticated;

commit;
