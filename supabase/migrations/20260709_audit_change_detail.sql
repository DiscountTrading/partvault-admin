-- ============================================================================
-- Activity log: show WHAT changed, richer action types, and keep-going paging.
--
-- The audit trigger already stores full old_data/new_data snapshots, so we can
-- synthesise a field-level diff without any new logging. This migration:
--   1. audit_change_summary(old,new) — a readable "field old→new" diff for the
--      meaningful part/car fields (long text fields just say "edited").
--   2. get_audit_log() gains:
--        - parts summaries that append the diff (or "background update" when only
--          bookkeeping fields like updated_at/market_checked_at changed — so the
--          sync's touch-only rows are self-explanatory, not mysterious "edits");
--        - a richer `action` for status transitions (sold / listed / ended /
--          restocked) so the feed is sortable by what happened, not just add/edit;
--        - a `p_before` cursor param for "Load more" paging past the first page.
--
-- Idempotent; apply via the Supabase SQL editor (see reference_db_migrations).
-- ============================================================================

begin;

create or replace function public.audit_change_summary(p_old jsonb, p_new jsonb)
returns text language sql immutable set search_path = public as $$
  select nullif(string_agg(
    case when f.long then f.label || ' edited'
         else f.label || ' ' || coalesce(nullif(p_old->>f.key, ''), '—') || '→' || coalesce(nullif(p_new->>f.key, ''), '—') end,
    ' · ' order by f.ord), '')
  from (values
    ('status','status',1,false),
    ('list_price','price',2,false),
    ('sold_price','sold price',3,false),
    ('sku','SKU',4,false),
    ('category','category',5,false),
    ('subcategory','subcategory',6,false),
    ('condition','condition',7,false),
    ('make','make',8,false),
    ('model','model',9,false),
    ('year','year',10,false),
    ('title','name',11,false),
    ('location','location',12,false),
    ('weight','weight',13,false),
    ('part_number','part #',14,false),
    ('description','description',15,true),
    ('notes','notes',16,true)
  ) as f(key, label, ord, long)
  where (p_old ? f.key or p_new ? f.key)
    and (p_old->>f.key) is distinct from (p_new->>f.key);
$$;
grant execute on function public.audit_change_summary(jsonb, jsonb) to authenticated;

drop function if exists public.get_audit_log(uuid, int, text);
drop function if exists public.get_audit_log(uuid, int, text, timestamptz);

create or replace function public.get_audit_log(
  p_store_id uuid,
  p_limit    int         default 300,
  p_search   text        default null,
  p_before   timestamptz default null
)
returns table (id uuid, created_at timestamptz, user_email text, action text, entity_type text, summary text)
language sql security definer stable set search_path = public
as $$
  select
    a.id,
    a.changed_at,
    u.email,
    case
      when a.table_name = 'sync' then 'sync_' || coalesce(a.new_data->>'kind', 'manual')  -- sync_nightly / sync_manual / sync_live
      when a.table_name = 'store_members' then
        case lower(a.action) when 'insert' then 'member_added' when 'delete' then 'member_removed' else 'member_updated' end
      when lower(a.action) = 'update' and (a.new_data->>'deleted_at') is not null and (a.old_data->>'deleted_at') is null then 'delete'
      when lower(a.action) = 'update' and (a.new_data->>'deleted_at') is null and (a.old_data->>'deleted_at') is not null then 'restore'
      when a.table_name in ('parts', 'listings') and lower(a.action) = 'update'
           and (a.new_data->>'status') is distinct from (a.old_data->>'status') then
        case a.new_data->>'status'
          when 'sold' then 'sold'
          when 'listed' then 'listed'
          when 'live' then 'listed'
          when 'ended' then 'ended'
          when 'in_stock' then 'restocked'
          else lower(a.action)
        end
      else lower(a.action)
    end as action,
    a.table_name,
    case a.table_name
      when 'sync' then coalesce(a.new_data->>'summary', 'eBay sync')
      when 'parts' then 'part ' || coalesce(a.new_data->>'title', a.old_data->>'title', '')
        || case
             when lower(a.action) = 'insert' then ' added'
             when lower(a.action) = 'update'
                  and (a.new_data->>'deleted_at') is not distinct from (a.old_data->>'deleted_at') -- not a soft delete/restore
               then coalesce(' — ' || public.audit_change_summary(a.old_data, a.new_data), ' — background update')
             else ''
           end
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
    and (p_before is null or a.changed_at < p_before)
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

grant execute on function public.get_audit_log(uuid, int, text, timestamptz) to authenticated;

commit;
