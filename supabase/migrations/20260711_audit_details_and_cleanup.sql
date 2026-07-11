-- ============================================================================
-- Activity log: fix phantom "price changed" rows, add a full change-detail
-- payload for the per-row Details view, and stop internal job-queue rows from
-- leaking into the feed. Supersedes 20260709 (audit_change_detail) AND
-- 20260710 (audit_summary_friendly) — this is the single migration to run.
--
-- Three fixes:
--   1. NUMERIC-DIFF PHANTOM. audit_change_summary compared fields as TEXT
--      (->>), so a price stored as 50 in one write and 50.00 in another (same
--      money, different scale) was reported as "price 50→50.00". The sync never
--      writes parts.list_price, so these were never real eBay price changes —
--      just a text-vs-value mismatch. Now compares the JSONB VALUES (->), where
--      50 and 50.00 are equal, so numeric-format-only diffs disappear.
--   2. DETAILS PAYLOAD. New audit_change_details(old,new) returns a JSON array
--      of every meaningful field that actually changed, with old/new values, so
--      the Activity view can show a full "what changed" table on demand.
--   3. JOB NOISE. The generic audit trigger is attached to the internal `jobs`
--      queue (import/sync machinery). Those "jobs / added jobs" rows are not
--      user activity — the friendly per-sync summary row already represents sync
--      work — so get_audit_log now excludes table_name = 'jobs'.
--
-- Idempotent (create-or-replace); apply via the Supabase SQL editor.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Friendly one-line summary. Compares JSONB values (->) not text (->>) so a
-- numeric re-scale (50 vs 50.00) is NOT counted as a change. Display still uses
-- ->> for a clean human value.
-- ---------------------------------------------------------------------------
create or replace function public.audit_change_summary(p_old jsonb, p_new jsonb)
returns text language sql immutable set search_path = public as $$
  select nullif(string_agg(
    case when f.long then f.label || ' edited'
         else f.label || ' ' || coalesce(nullif(p_old->>f.key, ''), '—') || '→' || coalesce(nullif(p_new->>f.key, ''), '—') end,
    ' · ' order by f.ord), '')
  from (values
    ('status','status',1,false),('list_price','price',2,false),('sold_price','sold price',3,false),
    ('sku','SKU',4,false),('category','category',5,false),('subcategory','subcategory',6,false),
    ('condition','condition',7,false),('make','make',8,false),('model','model',9,false),
    ('year','year',10,false),('title','name',11,false),('location','location',12,false),
    ('loc_row','row',13,false),('loc_bay','bay',14,false),('loc_shelf','shelf',15,false),
    ('weight','weight',16,false),('part_number','part #',17,false),
    ('description','description',18,true),('notes','notes',19,true)
  ) as f(key, label, ord, long)
  where (p_old ? f.key or p_new ? f.key)
    and (p_old->f.key) is distinct from (p_new->f.key);  -- VALUE compare, not text
$$;
grant execute on function public.audit_change_summary(jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Full field-level diff for the Details view. Every key that actually changed
-- (JSONB value compare), minus internal/bookkeeping/huge fields. Returns
-- [{ field, old, new }, …] preserving the JSON types so the UI can format.
-- ---------------------------------------------------------------------------
create or replace function public.audit_change_details(p_old jsonb, p_new jsonb)
returns jsonb language sql immutable set search_path = public as $$
  with keys as (
    select k from jsonb_object_keys(coalesce(p_old, '{}'::jsonb)) k
    union
    select k from jsonb_object_keys(coalesce(p_new, '{}'::jsonb)) k
  )
  select coalesce(
    jsonb_agg(jsonb_build_object('field', k, 'old', p_old->k, 'new', p_new->k) order by k),
    '[]'::jsonb)
  from keys
  where k not in (
    -- bookkeeping / sync touch fields
    'updated_at','created_at','market_checked_at','market_price','market_count',
    -- internal / identity (never user-meaningful)
    'id','store_id','record_id','embedding','search_vector','tsv',
    -- large blobs that don't read well in a diff row
    'photos','platform_data','ebay_overrides'
  )
  and (p_old->k) is distinct from (p_new->k);
$$;
grant execute on function public.audit_change_details(jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Read RPC. Same 4-param call signature; adds a `details` column and excludes
-- the internal jobs queue. Keeps the friendly summaries + real-changes-only
-- filter from 20260710.
-- ---------------------------------------------------------------------------
drop function if exists public.get_audit_log(uuid, int, text);
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
      when a.table_name in ('parts', 'listings') and lower(a.action) = 'update'
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
        || case
             when lower(a.action) = 'insert' then ' — added'
             when lower(a.action) = 'update' and (a.new_data->>'deleted_at') is not distinct from (a.old_data->>'deleted_at') then
               case
                 when (a.new_data->>'status') is distinct from (a.old_data->>'status') then ' — ' ||
                   case a.new_data->>'status'
                     when 'sold' then 'Marked as sold'
                     when 'listed' then 'Listed to eBay'
                     when 'in_stock' then 'Returned to stock'
                     else 'Status set to ' || initcap(coalesce(a.new_data->>'status', '')) end
                 else coalesce(' — ' || public.audit_change_summary(a.old_data, a.new_data), '')
               end
             else ''
           end
      when 'cars' then 'car ' || coalesce(a.new_data->>'make', a.old_data->>'make', '') || ' ' || coalesce(a.new_data->>'model', a.old_data->>'model', '')
        || coalesce(' — ' || public.audit_change_summary(a.old_data, a.new_data), '')
      when 'listings' then 'listing ' || coalesce(a.new_data->>'platform_sku', a.old_data->>'platform_sku', '')
        || case when lower(a.action) = 'update' and (a.new_data->>'status') is distinct from (a.old_data->>'status') then ' — ' ||
             case a.new_data->>'status'
               when 'ended' then 'Listing ended' when 'sold' then 'Listing sold' when 'live' then 'Went live'
               else 'Status set to ' || initcap(coalesce(a.new_data->>'status', '')) end
           else '' end
      when 'store_members' then case lower(a.action)
        when 'insert' then 'user added to store' when 'delete' then 'user removed from store' else 'user access changed' end
      else a.table_name
    end as summary,
    -- Full change detail for the per-row Details expander (inserts/deletes get
    -- the whole new/old row so the UI can show what was created/removed).
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
    and a.table_name <> 'jobs'          -- internal import/sync queue, not user activity
    and (p_before is null or a.changed_at < p_before)
    -- Real changes only: drop parts UPDATE rows where no meaningful field changed
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
