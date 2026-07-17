-- ============================================================================
-- Slim the audit trigger: store only meaningful CHANGES, never the whole row.
--
-- Before: every INSERT/UPDATE/DELETE stored to_jsonb(OLD) + to_jsonb(NEW) — all
-- ~30 columns before AND after, including the photo-URL array and the AI
-- description (~5 KB/row). A one-field edit (e.g. ai_assessed) paid the full
-- 5 KB. Bulk jobs pushed audit_log to 387 MB.
--
-- After:
--   • Bulky / re-creatable columns are NEVER audited (any table):
--       description  – AI can rewrite it
--       photos       – the files live in Supabase Storage
--       platform_data– raw eBay API dump, rebuilt on the next sync
--     Dropped on insert, update AND delete — nothing worth recovering is lost.
--   • UPDATE → only the columns that actually changed (old + new of each), plus a
--     few small identity columns (title/sku/status/make/model/…) so the Activity
--     feed can still label + diff rows. A genuine no-op logs nothing.
--   • INSERT → the new row (minus the excluded columns).
--   • DELETE → the old row (minus the excluded columns) — sku, price, location,
--     status, part number, notes, costs etc. are all kept, so a deleted part is
--     fully restorable except its (regenerable) description/photos.
--
-- Deliberately a DENY list, not an allow list: a new business column is audited
-- by default, so we can never silently stop tracking something that matters.
-- Identity columns match what get_audit_log() reads, so the feed is unaffected.
-- Idempotent; apply via the Supabase SQL editor.
-- ============================================================================

create or replace function public.log_audit_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_new jsonb;
  d_old jsonb := '{}'::jsonb;
  d_new jsonb := '{}'::jsonb;
  k     text;
  -- bulky / re-creatable — never stored (removed from every snapshot)
  excl  text[] := array['description','photos','platform_data'];
  -- small identifiers kept on every UPDATE row so the feed can label + diff
  ident text[] := array['title','sku','status','make','model','year','deleted_at','platform_sku','name'];
begin
  if TG_OP = 'INSERT' then
    insert into public.audit_log(store_id, table_name, record_id, action, old_data, new_data, changed_by)
    values (NEW.store_id, TG_TABLE_NAME, NEW.id, 'INSERT', null, to_jsonb(NEW) - excl, auth.uid());
    return null;

  elsif TG_OP = 'DELETE' then
    insert into public.audit_log(store_id, table_name, record_id, action, old_data, new_data, changed_by)
    values (OLD.store_id, TG_TABLE_NAME, OLD.id, 'DELETE', to_jsonb(OLD) - excl, null, auth.uid());
    return null;
  end if;

  -- UPDATE: identity fields (both sides, so unchanged ones don't read as changes)
  -- + the columns that genuinely changed, excluding the bulky/re-creatable ones.
  v_old := to_jsonb(OLD);
  v_new := to_jsonb(NEW);

  foreach k in array ident loop
    if v_new ? k then
      d_old := d_old || jsonb_build_object(k, v_old -> k);
      d_new := d_new || jsonb_build_object(k, v_new -> k);
    end if;
  end loop;

  for k in select jsonb_object_keys(v_new) loop
    -- skip excluded columns, and updated_at (redundant with audit_log.changed_at)
    if k <> 'updated_at' and not (k = any(excl))
       and (v_old -> k) is distinct from (v_new -> k) then
      d_old := d_old || jsonb_build_object(k, v_old -> k);
      d_new := d_new || jsonb_build_object(k, v_new -> k);
    end if;
  end loop;

  -- Nothing meaningful changed (only identity present, all equal) → no noise row.
  if d_old = d_new then
    return null;
  end if;

  insert into public.audit_log(store_id, table_name, record_id, action, old_data, new_data, changed_by)
  values (coalesce(NEW.store_id, OLD.store_id), TG_TABLE_NAME, coalesce(NEW.id, OLD.id), 'UPDATE', d_old, d_new, auth.uid());
  return null;
end;
$$;

-- Nightly prune so history can't pile up again. 30-day window; adjust freely.
-- (Small diff rows + autovacuum reuse keep the table bounded without VACUUM FULL.)
do $$
begin
  perform cron.unschedule('prune_audit_log');
exception when others then null;   -- not scheduled yet → ignore
end $$;
select cron.schedule('prune_audit_log', '30 14 * * *',
  $prune$delete from public.audit_log where changed_at < now() - interval '30 days'$prune$);
