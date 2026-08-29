-- ============================================================================
-- The audit trail records what a PERSON did, and keeps enough to undo it.
--
-- Paul, 2026-08-30: "this is generally save user errors not sync errors, know
-- who made a change and when and what happened and can it be undone."
--
-- MEASURED on the live DB before writing this:
--   database          581 MB   — 116% of the 500 MB free tier
--   audit_log         465 MB   (heap 24 MB, indexes 4 MB, TOAST 438 MB)
--     of which jobs   348 MB   9,394 rows — 97.7% of the payload
--              parts    8 MB   16,559 rows
--   growth/month:  jobs 345 MB   parts 8 MB   listings 0.2 MB
--
--   And of 16,482 parts rows in the last 30 days:
--     16,475 written by the SYNC (service role, no auth.uid())
--          7 written by a PERSON
--
-- So 99.96% of the trail answered a question nobody asked. sync_runs already
-- records what the sync did; this table exists to answer "who changed this, and
-- can I put it back".
--
-- ⚠ 20260715_audit_diff_only.sql IS ALREADY APPLIED — the live log_audit_event
-- carries its `excl` array. It did not help, because its deny list is
-- description / photos / platform_data and the bloat was `meta` on jobs.
--
-- FOUR CHANGES
--   1. A person's edit is audited IN FULL — description and photos included.
--      They were excluded for everyone, which quietly made undo impossible for
--      the one case the trail is for: someone clears a description by accident
--      and there is no copy of it. A whole part row is 1,867 bytes and there are
--      ~7 human edits a month, so this costs about 26 KB a month.
--      The sync keeps the slim diff.
--   2. `meta` is never audited. 71 kB a row on jobs, read by nothing.
--   3. The jobs audit trigger is DROPPED — an internal work queue, regenerated
--      by the next sync, and the Activity feed only ever offered Parts and Cars.
--   4. Machine-written rows are pruned after 30 days; a person's are kept
--      forever. Recent sync forensics stay available (the sync writes prices and
--      statuses, so that matters), and accountability never expires.
--
-- Steady state after this: a few MB, permanently, instead of 4.1 GB a year.
--
-- ⚠ The trigger function below is the LIVE definition read back with
-- pg_get_functiondef, edited in two places. It is deliberately not
-- hand-written: a first draft reconstructed it from the previous migration's
-- prose and got the identity list, the no-op test and the return value wrong —
-- it returned NEW where the live trigger returns null.
--
-- NOTE: this stores enough to undo a change. There is no undo BUTTON yet — that
-- is a separate piece of work, and this is the data it would need.
--
-- Idempotent. Apply via the Supabase SQL editor — no PAT required.
-- ============================================================================

-- 1 ── who wrote it decides what is kept ---------------------------------------
CREATE OR REPLACE FUNCTION public.log_audit_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_old jsonb;
  v_new jsonb;
  d_old jsonb := '{}'::jsonb;
  d_new jsonb := '{}'::jsonb;
  k     text;
  -- Columns never stored. Set at the top of begin rather than here, because
  -- what is worth keeping depends on WHO wrote the row.
  excl  text[];
  -- small identifiers kept on every UPDATE row so the feed can label + diff
  ident text[] := array['title','sku','status','make','model','year','deleted_at','platform_sku','name'];
begin
  -- A PERSON's edit keeps everything, because the point of the trail is undoing
  -- a human mistake and you cannot restore a description you never recorded.
  -- Measured: a whole part row is 1,867 bytes and there are ~7 human edits a
  -- month, so keeping the lot costs about 26 KB a month.
  --
  -- The SYNC (service role, no auth.uid()) writes ~550 rows a day, so it drops
  -- the bulky re-creatable columns. platform_data and meta are raw API dumps
  -- nobody edits or restores, so they go either way.
  excl := case
            when auth.uid() is not null then array['platform_data','meta']
            else array['description','photos','platform_data','meta']
          end;

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
$function$;


-- 2 ── the jobs queue is not audited -------------------------------------------
drop trigger if exists jobs_audit on public.jobs;

-- 3 ── remove what was already written -----------------------------------------
delete from public.audit_log where table_name = 'jobs';

-- 4 ── prune machine-written rows on a schedule --------------------------------
-- Keeps every row a person wrote, forever. Drops the sync's after p_days.
create or replace function public.prune_audit_log(p_days int default 30)
returns integer
language plpgsql
security definer
set search_path = public
as $prune$
declare
  n integer;
begin
  delete from public.audit_log
   where changed_by is null                       -- machine-written only
     and changed_at < now() - make_interval(days => greatest(p_days, 1));
  get diagnostics n = row_count;
  return n;
end;
$prune$;

-- SECURITY DEFINER + a default argument is an open API if it stays callable by
-- anon. It is a maintenance job: cron and the service role only.
revoke all on function public.prune_audit_log(int) from public;
revoke all on function public.prune_audit_log(int) from anon;
revoke all on function public.prune_audit_log(int) from authenticated;
grant execute on function public.prune_audit_log(int) to postgres, service_role;

do $sched$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'partvault-prune-audit') then
      perform cron.unschedule('partvault-prune-audit');
    end if;
    -- 03:20, before the 03:30 purge job, so the two do not overlap.
    perform cron.schedule('partvault-prune-audit', '20 3 * * *',
                          'select public.prune_audit_log(30)');
  else
    raise notice 'pg_cron not installed — run select public.prune_audit_log(30) yourself, or schedule it.';
  end if;
end
$sched$;

-- 5 ── give the disk back --------------------------------------------------------
-- The DELETE above frees nothing on its own: the space stays inside audit_log's
-- TOAST as dead tuples and the table still counts against the quota. VACUUM FULL
-- rewrites the table and returns it. It takes an ACCESS EXCLUSIVE lock, so run
-- it when a sync is not in flight; it rewrites ~10 MB of survivors, so seconds.
--
-- It cannot run inside a transaction block. Run it on its own, straight after:
--
--   vacuum (full, analyze) public.audit_log;
