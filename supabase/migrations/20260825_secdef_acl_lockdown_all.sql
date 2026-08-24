-- ============================================================================
--  SECURITY - revoke EXECUTE on every SECURITY DEFINER function in schema
--  public that is reachable by anon and contains no internal authorization
--  check. Supersedes and consolidates:
--      20260825_ai_metering_acl_fix.sql
--      20260825_secdef_acl_lockdown.sql
--  Status at the time of writing: 20260825_ai_metering_acl_fix.sql HAS been
--  applied (re-verified live — consume_ai_credit(uuid,numeric) and
--  increment_ai_usage(uuid,text,numeric) now read postgres + service_role only,
--  and an anonymous POST to either returns 42501 permission denied).
--  20260825_secdef_acl_lockdown.sql was superseded by this file and deleted
--  unapplied. Re-revoking an already-revoked privilege is a no-op, so this file
--  is safe to run whether or not the metering fix ran first.
--
--  WHY THE GRANTEE LIST IS `public, anon, authenticated` EVERYWHERE BELOW:
--    - PUBLIC is the actual hole. A function is created with EXECUTE granted to
--      PUBLIC by default; a NULL proacl and an ACL entry of '=X/postgres' both
--      mean PUBLIC has EXECUTE. Revoking anon alone leaves PUBLIC in place and
--      changes nothing.
--    - anon and authenticated are named explicitly because a later
--      `grant ... to authenticated` elsewhere in the migration set would
--      otherwise sit on top of the revoke; naming them makes the end state
--      explicit rather than order-dependent.
--    - service_role and postgres are deliberately NOT revoked. Every verified
--      caller of every function below runs as one of those two (see the
--      per-statement notes), so this file cannot break a legitimate caller.
--
--  IDEMPOTENT: REVOKE of a privilege that is already absent is a no-op, so this
--  file can be re-run any number of times. Every target below was confirmed to
--  exist by the live pg_proc sweep, so the plain statements cannot error; the
--  optional legacy overloads at the end are guarded with to_regprocedure().
-- ============================================================================

begin;

-- == GROUP A: revoke from public, anon AND authenticated =====================
-- No function in this group has any legitimate signed-in-user caller. Verified
-- by grepping partvault-admin/src and partvault-mobile/src for .rpc with each
-- name: zero hits for all of them.

-- get_ebay_tokens returns the DECRYPTED eBay access token, refresh token and
-- cert id out of vault.decrypted_secrets for whatever store_id is passed in,
-- with no membership check. Highest-value target in the schema.
-- Caller: ebay-import/index.ts:899 - service role (client built at :704).
revoke execute on function public.get_ebay_tokens(uuid)
  from public, anon, authenticated;

-- Writes a store's eBay OAuth tokens into the vault and upserts
-- public.ebay_tokens for an arbitrary p_store_id. The ONLY ACL statement it has
-- ever had is `grant execute ... to service_role`
-- (20260607_ebay_oauth_token_store.sql:82) - the author's intent was
-- unmistakably service-role-only, but the default PUBLIC grant was never
-- revoked, so that grant changed nothing about who else could call it.
-- Caller: ebay-import/index.ts:1238 - service role.
revoke execute on function public.store_ebay_oauth_tokens(uuid, text, text, timestamptz, integer)
  from public, anon, authenticated;

-- Same credential-write class: replaces a store's access token.
-- Caller: ebay-import/index.ts:931 - service role.
revoke execute on function public.update_ebay_access_token(uuid, text, timestamptz, integer)
  from public, anon, authenticated;

-- THE ACL-RESET PATTERN #1. Revoked at 20260704_ai_credits.sql:39 for the
-- (uuid) signature; re-created at a wider arity in
-- 20260719_ai_usage_weighted.sql:31 and again at a changed type in
-- 20260726_ai_metering_fractional.sql:54, with no revoke in either file. The
-- current (uuid,numeric) signature has never been revoked. Uncapped, unaudited
-- balance debit against a caller-supplied store id.
-- Callers: ai-assess/index.ts:261 (svc = SERVICE_ROLE_KEY, built :250);
--          ebay-import/index.ts:295 (sb = SERVICE_ROLE_KEY, built :704-707,
--          passed down meterAIOp <- fillAspects <- handleRequest).
revoke execute on function public.consume_ai_credit(uuid, numeric)
  from public, anon, authenticated;

-- THE ACL-RESET PATTERN #2, identical shape, same two migrations. Revoked at
-- 20260704_plans.sql:120 for (uuid,text) - the line above the original create
-- literally comments "(service role only)". Re-created at (uuid,text,int)
-- 20260719_ai_usage_weighted.sql:10 and (uuid,text,numeric)
-- 20260726_ai_metering_fractional.sql:33, neither with a revoke.
-- Callers: ai-assess/index.ts:253,262,265,274 and ebay-import/index.ts:287 -
--          all service role.
revoke execute on function public.increment_ai_usage(uuid, text, numeric)
  from public, anon, authenticated;

-- Loops every store with eBay tokens and fires one HTTP POST per store at the
-- sync edge function. Returns void, so PostgREST DOES expose it as RPC. No
-- migration has ever issued a grant or revoke for it across its five
-- re-creations. Caller: pg_cron job 'partvault-nightly-sync', runs as postgres.
revoke execute on function public.trigger_nightly_sync()
  from public, anon, authenticated;

-- Mutates public.jobs (times out stuck jobs). Defined outside the migrations
-- directory entirely, in the legacy pre-migration SQL, which carries no ACL
-- statements at all. Caller: pg_cron job 'tick-jobs', runs as postgres.
revoke execute on function public.tick_jobs()
  from public, anon, authenticated;

-- Discloses whether a given store has an eBay cert id configured. Low value on
-- its own, but it is an oracle for confirming store ids. NOTE: its definition
-- does not exist in version control - the only migration that mentions it
-- DROPS it (20260607_drop_per_store_cert_rpcs.sql:23) and nothing re-creates
-- it, so it survives from the pre-migration schema. No verified caller.
revoke execute on function public.has_ebay_cert_id(uuid)
  from public, anon, authenticated;

-- == GROUP A (hygiene only - these two are NOT exposed) ======================
-- Both RETURN trigger. PostgREST does not publish trigger-returning functions
-- (probed: POST /rpc/handle_new_user returns 404 PGRST202 while a control call
-- to another function with the same key returns 200), and Postgres itself
-- rejects a direct SQL call with "trigger functions can only be called as
-- triggers" before the body executes. Revoked anyway for two reasons: the
-- PUBLIC EXECUTE grant is exactly the privilege CREATE TRIGGER checks, so a
-- role able to create its own table could attach these and fire the SECURITY
-- DEFINER body (closed here only because anon/authenticated hold no CREATE on
-- any schema); and a future change of return type would otherwise open them
-- silently.
-- SAFE: EXECUTE is checked at CREATE TRIGGER time, never when a trigger fires,
-- so the existing triggers (parts_ai_assess on public.parts, the auth.users
-- signup hook) keep working for user-JWT inserts after this revoke.
revoke execute on function public.trigger_ai_assess() from public, anon, authenticated;
revoke execute on function public.handle_new_user()   from public, anon, authenticated;

-- == GROUP B: revoke from public and anon ONLY (keep authenticated) ==========
-- Reserved for SECURITY DEFINER functions that legitimately serve signed-in
-- users and enforce membership internally - the shape used correctly by the
-- ops_* block (20260806_ops_platform_management.sql:103-108 revoke from public,
-- anon; :109-114 grant to authenticated).
-- THIS GROUP IS EMPTY IN THIS MIGRATION. None of the ten no-auth-check
-- functions found by the live sweep has a browser-side caller, so every one of
-- them belongs in Group A. Do not move anything into Group B without first
-- grepping both src trees for an .rpc call to it.

-- == Legacy overloads, if this database predates 20260726 ====================
-- Guarded so the file runs against either schema state.
do $$
declare sig text;
begin
  foreach sig in array array[
    'public.consume_ai_credit(uuid,integer)',
    'public.increment_ai_usage(uuid,text,integer)'
  ] loop
    if to_regprocedure(sig) is not null then
      execute format('revoke execute on function %s from public, anon, authenticated', sig);
    end if;
  end loop;
end $$;

commit;

-- == VERIFY (run after committing; expect ZERO rows) =========================
-- A NULL proacl also means PUBLIC has EXECUTE, which is why the `is null` arm
-- is part of the predicate. Do not read a null ACL as a pass.
--
--   select p.oid::regprocedure::text,
--          coalesce(array_to_string(p.proacl,' | '), '<null = PUBLIC>')
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.prosecdef
--      and (p.proacl is null or exists (
--            select 1 from aclexplode(p.proacl) a
--             where a.privilege_type = 'EXECUTE'
--               and (a.grantee = 0 or a.grantee::regrole::text in ('anon','authenticated'))))
--      and not (p.prosrc ~* 'auth\.uid|is_store_member|has_permission|is_platform_admin|is_store_admin|auth\.jwt')
--    order by 1;
