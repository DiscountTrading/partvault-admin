-- ============================================================================
--  SECURITY — close the two remaining client-reachable paths into a tenant.
--
--  (a) join_store(text) was EXECUTE-able by PUBLIC, i.e. by anon.
--      It is SECURITY DEFINER and adds the caller to a store on presentation of
--      a join code, with no throttle. Join codes are 6 uppercase hex characters
--      (~16.7M) and at least one in production was hand-set to a guessable value,
--      so an anonymous caller could grind codes with no account and no rate limit.
--      Both apps call it only while signed in — src/App.jsx:96,
--      src/components/JoinStore.jsx:65, partvault-mobile/src/App.jsx:71 — so
--      authenticated keeps EXECUTE and nothing user-facing changes.
--
--  (b) Any authenticated user could INSERT directly into public.stores via the
--      policy "Authenticated users can create stores" (WITH CHECK true), setting
--      any column the table allows — including subscription_tier, plan and
--      join_code — and bypassing whatever create_store() enforces. Both callers
--      already go through the RPC (src/App.jsx:77, src/components/JoinStore.jsx:33),
--      which is SECURITY DEFINER and therefore unaffected by the client grant.
--      This matters more once Stripe is connected: plan is a billing boundary.
--
--  Idempotent.
-- ============================================================================

revoke execute on function public.join_store(text) from public, anon;

drop policy if exists "Authenticated users can create stores" on public.stores;
revoke insert on public.stores from authenticated, anon;

-- NOT fixed here, and deliberately left for a human decision:
--   * join_code is never rotated when a member is removed, so an ex-member who
--     noted the code can rejoin (remove_member and ops_remove_member both only
--     delete the membership row). Rotating it on removal invalidates the code
--     for everyone who has it, which is a product decision.
--   * Standing codes should become single-use, expiring, email-bound invites.
--   * A removed member's refresh token is not revoked, so their existing
--     year-long session survives removal.

-- Verify:
--   select has_function_privilege('anon','public.join_store(text)','EXECUTE');       -- false
--   select has_function_privilege('authenticated','public.join_store(text)','EXECUTE'); -- true
--   select polname from pg_policy where polrelid='public.stores'::regclass;          -- no create policy
