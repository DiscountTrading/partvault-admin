-- ============================================================================
-- Activity log: render eBay sync summary events + add free-text search.
--
-- The edge function (ebay-import) now writes ONE summary row per sync run into
-- the existing audit_log with table_name = 'sync', action = 'SYNC', and the
-- composed line in new_data->>'summary'. This migration teaches get_audit_log to
-- surface those as a 'sync' activity type, and adds an optional p_search term
-- (matched across the change payload, table name and user email) so any entry —
-- sync runs included — is findable even when buried under per-row changes.
--
-- Replaces the 2-arg get_audit_log(uuid,int) with a 3-arg version (the extra
-- param defaults to null, so existing 2-arg callers keep working).
-- ============================================================================

begin;

drop function if exists public.get_audit_log(uuid, int);

create or replace function public.get_audit_log(
  p_store_id uuid,
  p_limit    int  default 300,
  p_search   text default null
)
returns table (id uuid, created_at timestamptz, user_email text, action text, entity_type text, summary text)
language sql security definer stable set search_path = public
as $$
  select
    a.id,
    a.changed_at,
    u.email,
    case
      when a.table_name = 'sync' then 'sync'
      when a.table_name = 'store_members' then
        case lower(a.action) when 'insert' then 'member_added' when 'delete' then 'member_removed' else 'member_updated' end
      when lower(a.action) = 'update' and (a.new_data->>'deleted_at') is not null and (a.old_data->>'deleted_at') is null then 'delete'
      when lower(a.action) = 'update' and (a.new_data->>'deleted_at') is null and (a.old_data->>'deleted_at') is not null then 'restore'
      else lower(a.action)
    end as action,
    a.table_name,
    case a.table_name
      when 'sync' then coalesce(a.new_data->>'summary', 'eBay sync')
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
    and (
      p_search is null or p_search = '' or
      (
        coalesce(a.new_data::text, '') || ' ' ||
        coalesce(a.old_data::text, '') || ' ' ||
        a.table_name || ' ' ||
        coalesce(u.email, '')
      ) ilike '%' || p_search || '%'
    )
  order by a.changed_at desc
  limit greatest(1, least(p_limit, 1000));
$$;

grant execute on function public.get_audit_log(uuid, int, text) to authenticated;

commit;
