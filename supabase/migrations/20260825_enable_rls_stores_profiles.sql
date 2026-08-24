-- ============================================================================
--  SECURITY (critical) — turn ON row-level security for public.stores and
--  public.profiles.
--
--  Both tables carry correct policies and have done for months, but RLS was
--  never enabled at the TABLE level, which makes every policy inert. Combined
--  with the Supabase default grant of ALL privileges to anon and authenticated,
--  that left both tables readable AND writable by anyone holding the publishable
--  key — which ships inside the browser bundle.
--
--  Proven against production before this change, with no session at all:
--      GET /rest/v1/stores?select=id    -> HTTP 200, returned store ids
--      GET /rest/v1/profiles?select=id  -> HTTP 200, returned rows
--      GET /rest/v1/parts?select=id     -> [] (control: its RLS works)
--
--  What was exposed: stores.settings.ebayOAuth + ebayCreds (eBay OAuth tokens),
--  stores.github_token, stores.byok_anthropic_key, stores.join_code, stores.abn,
--  stores.settings.shipAddress, and profiles.anthropic_key.
--
--  Existing policies that become effective (unchanged by this migration):
--    stores    stores_select  SELECT using is_store_member(id)
--              stores_update  UPDATE using/check has_permission(id,'settings')
--              "Authenticated users can create stores" INSERT check true
--    profiles  "Own profile full access"     ALL    using/check user_id = auth.uid()
--              "View profiles in same store" SELECT using is_store_member(store_id)
--
--  VERIFIED SAFE before applying, by running this same ALTER inside a
--  transaction, impersonating a real user (set local role authenticated +
--  request.jwt.claims) and rolling back: the owner still saw his 2 of 4 stores
--  and 2 profiles. The Ops console is unaffected — it reads exclusively through
--  SECURITY DEFINER RPCs (ops_list_stores / ops_list_users / ops_store_members),
--  which bypass RLS. Every app read of stores is .eq('id', storeId) under a user
--  session, and neither app reads profiles directly (useAuth goes via an RPC).
--
--  anon keeps no path to either table: REVOKE below removes the blanket grant,
--  and with RLS on there is no anon policy anyway. Defence in depth.
--
--  Idempotent: enabling RLS twice is a no-op, as is revoking an absent grant.
-- ============================================================================

alter table public.stores   enable row level security;
alter table public.profiles enable row level security;

revoke all on public.stores   from anon;
revoke all on public.profiles from anon;

-- Verify (expect relrowsecurity = true for both):
--   select relname, relrowsecurity from pg_class
--    where oid in ('public.stores'::regclass, 'public.profiles'::regclass);
-- And from the internet, both of these must now return [] rather than rows:
--   curl "$SUPABASE_URL/rest/v1/stores?select=id"   -H "apikey: <publishable>"
--   curl "$SUPABASE_URL/rest/v1/profiles?select=id" -H "apikey: <publishable>"
