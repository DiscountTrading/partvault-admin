-- ============================================================================
-- Guard: a user can't remove their OWN manage_users capability. Without this,
-- a non-owner admin could untick their own "Manage Users" and lock themselves
-- out of team management (the owner is already protected separately). Redefines
-- set_member_permissions, keeping the existing auth + owner protection + audit.
-- ============================================================================

begin;

create or replace function public.set_member_permissions(p_store_id uuid, p_user_id uuid, p_permissions jsonb)
returns void language plpgsql security definer set search_path = public
as $$
declare v_role text; v_old jsonb;
begin
  if not public.has_permission(p_store_id, 'manage_users') then raise exception 'Unauthorised'; end if;
  select role, permissions into v_role, v_old from public.store_members where store_id = p_store_id and user_id = p_user_id;
  if v_role is null then raise exception 'Not a member of this store'; end if;
  if v_role = 'owner' then raise exception 'The store owner always has full access'; end if;

  -- You can't strip your own Manage Users access (would lock you out of this page).
  if p_user_id = auth.uid() and not coalesce((p_permissions->>'manage_users')::boolean, false) then
    raise exception 'You can''t remove your own Manage Users access';
  end if;

  update public.store_members set permissions = coalesce(p_permissions, '{}'::jsonb)
   where store_id = p_store_id and user_id = p_user_id;

  insert into public.audit_log (id, store_id, table_name, record_id, action, old_data, new_data, changed_by, changed_at)
  values (gen_random_uuid(), p_store_id, 'store_members', p_user_id, 'UPDATE',
          jsonb_build_object('permissions', v_old),
          jsonb_build_object('permissions', coalesce(p_permissions, '{}'::jsonb)),
          auth.uid(), now());
end;
$$;

commit;
