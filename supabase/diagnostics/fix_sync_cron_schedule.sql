-- ============================================================================
-- FIX: 6h / 12h scheduled syncs only fire at midnight
-- ============================================================================
-- Diagnosis (2026-07-20): trigger_nightly_sync() DOES support the per-store
-- interval (it fires when local_hour % syncIntervalHours = 0). BUT the pg_cron
-- job that CALLS it is still on the old midnight-only schedule — it only ticks
-- every 2 minutes between 13:00–15:59 UTC (a leftover from when sync was
-- midnight-only). For Discount Trading (Brisbane, UTC+10):
--   • 00:00 Brisbane = 14:00 UTC → inside the window → fires ✓
--   • 06:00 Brisbane = 20:00 UTC → cron not running → never fires ✗
--   • 12:00 Brisbane = 02:00 UTC → cron not running → never fires ✗
--   • 18:00 Brisbane = 08:00 UTC → cron not running → never fires ✗
-- So only the midnight run is ever recorded. A run always writes a sync_runs
-- row, so "no 6am/12pm row" means it did NOT run (not "ran but didn't record").
--
-- Fix: reschedule the job to tick every 5 minutes, 24/7 (the function itself
-- gates on the interval, so off-boundary ticks are cheap no-ops). This is what
-- migration 20260623_nightly_sync_timezone.sql intended but was never applied.
-- Run this in the Supabase SQL editor (needs cron privileges — your account).
-- ============================================================================

-- 1) OPTIONAL — see the current schedule first (confirm the job name):
--    select jobid, jobname, schedule, active from cron.job
--    where command ilike '%trigger_nightly_sync%';

-- 2) Reschedule (upserts the existing job by name):
select cron.schedule('partvault-nightly-sync', '*/5 * * * *',
  $$ select public.trigger_nightly_sync(); $$);

-- If step 1 showed a DIFFERENT job name calling trigger_nightly_sync, run the
-- line above with THAT name instead, and unschedule any stale duplicate:
--    select cron.unschedule('<old-job-name>');
