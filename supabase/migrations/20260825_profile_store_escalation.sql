-- ============================================================================
--  SECURITY (critical) — a signed-up user could grant themselves another
--  store's data by editing their OWN profile row.
--
--  The policy "Own profile full access" is ALL, using/check (user_id = auth.uid()).
--  It constrains WHOSE row you may touch. It says nothing about what you may put
--  IN it — so a user could set profiles.store_id to any store id they liked.
--
--  That matters because four tables resolve tenancy through profiles.store_id
--  rather than through store_members, which is the source of truth everywhere
--  else in this schema:
--      audit_log.audit_log_select
--      field_mappings.field_mappings_select / _write   (_write also trusts profiles.role)
--      jobs.jobs_select / _insert / _update
--      ai_usage_log."Users see own store usage"        (via get_my_store_id())
--
--  REPRODUCED ON PRODUCTION before this fix, as a real account with zero
--  memberships, inside a rolled-back transaction:
--      audit_log visible before ............ 0
--      UPDATE profiles SET store_id = <victim> ... 1 row
--      audit_log visible after ............. 26,958
--      jobs visible after .................. 193
--      parts visible after ................. 0   <- control: parts uses store_members
--  audit_log rows carry old_data/new_data snapshots — part titles, SKUs, COSTS
--  and prices. That is the whole pricing and margin history of the business.
--
--  Signup is open with mailer_autoconfirm on, so "a signed-up user" is anyone.
--
--  TWO LAYERS, because either alone would leave the shape of the bug in place:
--
--  1. Take write access to profiles away from clients entirely. Neither app
--     writes this table (no from('profiles') in partvault-admin/src or
--     partvault-mobile/src); every legitimate write goes through a SECURITY
--     DEFINER RPC (handle_new_user, switch_active_store, ops_*), and those run
--     as the function owner, so table grants do not apply to them.
--  2. Point the four policies at store_members, the same membership source the
--     rest of the schema uses. This is also a BUG FIX for multi-store users:
--     profiles.store_id holds one store, so a member of two stores could only
--     ever see audit_log and jobs for whichever one their profile pointed at.
--
--  Idempotent.
-- ============================================================================

-- ── Layer 1: clients get no write path to profiles ─────────────────────────
revoke insert, update, delete on public.profiles from authenticated;
revoke insert, update, delete on public.profiles from anon;

-- ── Layer 2: tenancy from store_members, not from a row the caller owns ────
drop policy if exists audit_log_select on public.audit_log;
create policy audit_log_select on public.audit_log
  for select using (public.is_store_member(store_id));

drop policy if exists field_mappings_select on public.field_mappings;
create policy field_mappings_select on public.field_mappings
  for select using (public.is_store_member(store_id));

-- _write kept admin-only, but resolved through store_members + the store role
-- rather than profiles.role (which the caller could also have rewritten).
drop policy if exists field_mappings_write on public.field_mappings;
create policy field_mappings_write on public.field_mappings
  for all
  using      (public.has_permission(store_id, 'settings'))
  with check (public.has_permission(store_id, 'settings'));

drop policy if exists jobs_select on public.jobs;
create policy jobs_select on public.jobs
  for select using (public.is_store_member(store_id));

drop policy if exists jobs_insert on public.jobs;
create policy jobs_insert on public.jobs
  for insert with check (public.is_store_member(store_id));

drop policy if exists jobs_update on public.jobs;
create policy jobs_update on public.jobs
  for update using (public.is_store_member(store_id))
              with check (public.is_store_member(store_id));

drop policy if exists "Users see own store usage" on public.ai_usage_log;
create policy ai_usage_log_select on public.ai_usage_log
  for select using (public.is_store_member(store_id));

-- Verify — re-run the reproduction above and expect audit_log AFTER = 0, and
-- the UPDATE itself to affect 0 rows / raise permission denied.
