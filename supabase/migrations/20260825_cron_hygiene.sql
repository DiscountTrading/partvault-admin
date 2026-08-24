-- ============================================================================
--  AVAILABILITY — replace a VACUUM FULL that runs every minute with a daily
--  prune, and reclaim the space it was fighting.
--
--  Found during the security audit: a pg_cron job named `vac_junk_once` (the
--  name says it was meant to run once) has been executing
--
--      vacuum full public.job_run_details
--
--  on the `* * * * *` schedule — every 60 seconds, indefinitely. VACUUM FULL
--  takes an ACCESS EXCLUSIVE lock and rewrites the entire table, so anything
--  touching it blocks for the duration, once a minute, forever.
--
--  What it was fighting: cron.job_run_details had 211,426 rows / 35 MB going
--  back to 2026-05-16. pg_cron appends a row per job run and never trims; with
--  five jobs (one of them every minute) that grows without bound. The right
--  answer is to delete old rows on a schedule and let autovacuum reclaim the
--  space — which is what pg_cron's own documentation recommends. It also matters
--  here because this project has run close to its storage ceiling before.
--
--  Idempotent: unschedule is guarded by an existence check, and the new job is
--  unscheduled-then-scheduled so re-running cannot create a duplicate.
-- ============================================================================

-- 1. Stop the every-minute VACUUM FULL.
select cron.unschedule('vac_junk_once')
 where exists (select 1 from cron.job where jobname = 'vac_junk_once');

-- 2. Prune run history daily instead, keeping a week for diagnostics.
select cron.unschedule('prune_cron_history')
 where exists (select 1 from cron.job where jobname = 'prune_cron_history');

select cron.schedule('prune_cron_history', '15 14 * * *',
  $$ delete from cron.job_run_details where end_time < now() - interval '7 days' $$);

-- 3. One-off catch-up for the backlog this job will inherit.
delete from cron.job_run_details where end_time < now() - interval '7 days';

-- Verify:
--   select jobname, schedule, active from cron.job order by jobname;
--   select count(*), pg_size_pretty(pg_total_relation_size('cron.job_run_details'))
--     from cron.job_run_details;
