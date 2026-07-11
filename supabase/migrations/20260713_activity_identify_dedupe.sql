-- ============================================================================
-- Activity log: identify the part clearly + one entry per change.
--
-- Two problems Paul hit:
--   1. A part ending on eBay produced TWO rows — a `listings` row ("listing …
--      ended") AND the `parts` row ("Returned to stock") — for one real event.
--      The parts row already captures every status transition (Listed / Sold /
--      Returned to stock / Ended), so we now EXCLUDE `listings` rows (like we do
--      `jobs`). One part change = one entry.
--   2. Rows didn't show which part. Parts summaries now include the SKU, e.g.
--      "part Toyota Camry Headlight [ABC-014] — Returned to stock", so identical
--      titles are still distinguishable.
--
-- Supersedes get_audit_log from 20260711_audit_details_and_cleanup. Keeps the
-- details payload, friendly summaries, numeric-value diff + real-changes filter.
-- Idempotent; apply via the Supabase SQL editor.
-- ============================================================================

begin;

drop function if exists public.get_audit_log(uuid, int, text, timestamptz);

create function public.get_audit_log(
  p_store_id uuid, p_limit int default 300, p_search text default null, p_before timestamptz default null
)
returns table (id uuid, created_at timestamptz, user_email text, action text, entity_type text, summary text, details jsonb)
language sql security definer stable set search_path = public
as $$
  select
    a.id, a.changed_at, u.email,
    case
      when a.table_name = 'sync' then 'sync_' || coalesce(a.new_data->>'kind', 'manual')
      when a.table_name = 'store_members' then
        case lower(a.action) when 'insert' then 'member_added' when 'delete' then 'member_removed' else 'member_updated' end
      when lower(a.action) = 'update' and (a.new_data->>'deleted_at') is not null and (a.old_data->>'deleted_at') is null then 'delete'
      when lower(a.action) = 'update' and (a.new_data->>'deleted_at') is null and (a.old_data->>'deleted_at') is not null then 'restore'
      when a.table_name = 'parts' and lower(a.action) = 'update'
           and (a.new_data->>'status') is distinct from (a.old_data->>'status') then
        case a.new_data->>'status'
          when 'sold' then 'sold' when 'listed' then 'listed' when 'live' then 'listed'
          when 'ended' then 'ended' when 'in_stock' then 'restocked' else lower(a.action) end
      else lower(a.action)
    end as action,
    a.table_name,
    case a.table_name
      when 'sync' then coalesce(a.new_data->>'summary', 'eBay sync')
      when 'parts' then 'part ' || coalesce(a.new_data->>'title', a.old_data->>'title', '')
        || coalesce(nullif(' [' || coalesce(a.new_data->>'sku', a.old_data->>'sku', '') || ']', ' []'), '')
        || case
             when lower(a.action) = 'insert' then ' — added'
             when lower(a.action) = 'update' and (a.new_data->>'deleted_at') is not distinct from (a.old_data->>'deleted_at') then
               case
                 when (a.new_data->>'status') is distinct from (a.old_data->>'status') then ' — ' ||
                   case a.new_data->>'status'
                     when 'sold' then 'Marked as sold'
                     when 'listed' then 'Listed to eBay'
                     when 'in_stock' then 'Returned to stock'
                     when 'ended' then 'Listing ended'
                     else 'Status set to ' || initcap(coalesce(a.new_data->>'status', '')) end
                 else coalesce(' — ' || public.audit_change_summary(a.old_data, a.new_data), '')
               end
             else ''
           end
      when 'cars' then 'car ' || coalesce(a.new_data->>'make', a.old_data->>'make', '') || ' ' || coalesce(a.new_data->>'model', a.old_data->>'model', '')
        || coalesce(' — ' || public.audit_change_summary(a.old_data, a.new_data), '')
      when 'store_members' then case lower(a.action)
        when 'insert' then 'user added to store' when 'delete' then 'user removed from store' else 'user access changed' end
      else a.table_name
    end as summary,
    case
      when a.table_name = 'sync' then '[]'::jsonb
      when lower(a.action) = 'insert' then public.audit_change_details('{}'::jsonb, coalesce(a.new_data, '{}'::jsonb))
      when lower(a.action) = 'delete' then public.audit_change_details(coalesce(a.old_data, '{}'::jsonb), '{}'::jsonb)
      else public.audit_change_details(a.old_data, a.new_data)
    end as details
  from public.audit_log a
  left join auth.users u on u.id = a.changed_by
  where a.store_id = p_store_id
    and public.has_permission(p_store_id, 'manage_users')
    and a.table_name not in ('jobs', 'listings')  -- machinery + the parts-row duplicate of an eBay listing change
    and (p_before is null or a.changed_at < p_before)
    and (
      a.table_name <> 'parts'
      or lower(a.action) in ('insert', 'delete')
      or (a.new_data->>'deleted_at') is distinct from (a.old_data->>'deleted_at')
      or public.audit_change_summary(a.old_data, a.new_data) is not null
    )
    and (
      p_search is null or p_search = '' or
      (coalesce(a.new_data::text, '') || ' ' || coalesce(a.old_data::text, '') || ' ' || a.table_name || ' ' || coalesce(u.email, '')) ilike '%' || p_search || '%'
    )
  order by a.changed_at desc
  limit greatest(1, least(p_limit, 1000));
$$;

grant execute on function public.get_audit_log(uuid, int, text, timestamptz) to authenticated;

commit;
