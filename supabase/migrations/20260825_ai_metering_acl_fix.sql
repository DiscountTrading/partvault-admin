-- ============================================================================
--  SECURITY — restore the EXECUTE revoke that a signature change silently lost.
--
--  20260704_ai_credits.sql:39 revoked EXECUTE on consume_ai_credit(uuid) from
--  public, anon and authenticated. 20260726_ai_metering_fractional.sql then
--  DROPPED the int-amount RPCs and created numeric-amount ones:
--
--      consume_ai_credit(uuid, numeric)          -- 20260726:59
--      increment_ai_usage(uuid, text, numeric)   -- 20260726:36
--
--  A changed signature is a NEW function object in Postgres, and a new function
--  is created with EXECUTE granted to PUBLIC by default. The earlier revoke
--  applied to the OLD signature and did not carry over, so both functions have
--  been callable by anon and authenticated ever since. Confirmed on the live
--  database (proacl = '=X/postgres | ... | anon=X/postgres | authenticated=X/postgres').
--
--  Both are SECURITY DEFINER, take p_store_id as a caller-supplied argument and
--  contain NO auth.uid()/membership check, so any caller holding the publishable
--  anon key could POST to /rest/v1/rpc/consume_ai_credit with someone else's
--  store_id to drain that store's purchased credit balance, or call
--  increment_ai_usage to inflate a store's metered usage past its plan.
--
--  Safe to revoke from ALL three roles: the only callers are edge functions
--  using the service-role key, which is unaffected by these revokes —
--    ai-assess/index.ts:253,262,265,274  (svc = SERVICE_ROLE_KEY, :82)
--    ebay-import/index.ts:295            (sb  = SERVICE_ROLE_KEY, :704)
--  No browser-side .rpc() call to either function exists in partvault-admin/src
--  or partvault-mobile/src.
--
--  Idempotent: REVOKE on a privilege that is already absent is a no-op, so this
--  can be re-run safely.
-- ============================================================================

revoke execute on function public.consume_ai_credit(uuid, numeric)
  from public, anon, authenticated;

revoke execute on function public.increment_ai_usage(uuid, text, numeric)
  from public, anon, authenticated;

-- Belt and braces: the same revoke on any int overload still present on a
-- database where 20260726 has not been applied yet. `if exists` keeps this file
-- runnable against either state.
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.oid::regprocedure::text = 'consume_ai_credit(uuid,integer)') then
    execute 'revoke execute on function public.consume_ai_credit(uuid, integer) from public, anon, authenticated';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.oid::regprocedure::text = 'increment_ai_usage(uuid,text,integer)') then
    execute 'revoke execute on function public.increment_ai_usage(uuid, text, integer) from public, anon, authenticated';
  end if;
end $$;

-- Verify (expect postgres + service_role only, no PUBLIC '=X/', no anon, no authenticated):
--   select p.oid::regprocedure::text, array_to_string(p.proacl, ' | ')
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.oid::regprocedure::text in ('consume_ai_credit(uuid,numeric)',
--                                        'increment_ai_usage(uuid,text,numeric)');
