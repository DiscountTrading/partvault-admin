-- ============================================================================
-- Cleanup: drop the now-dead per-store eBay credential RPCs.
--
-- The eBay developer keyset (App ID / Cert ID / RuName) now lives in
-- edge-function secrets, not per-store rows, so these functions are unused:
--   * set_ebay_cert_id(uuid, text)        — wrote the cert into per-store Vault
--   * set_ebay_app_config(uuid, text, text) — wrote app_id / ru_name per store
--   * has_ebay_cert_id(uuid)              — reported whether a per-store cert existed
--
-- The frontend no longer references any of them (verified). Token storage and
-- the OAuth flow are handled by store_ebay_oauth_tokens() / update_ebay_access_
-- token() / disconnect_ebay(), which remain.
--
-- Note: the legacy ebay_tokens.cert_id_id column and any leftover per-store
-- 'ebay_cert_<store>' Vault secrets are left in place (harmless). They can be
-- dropped in a later migration once we're confident nothing reads them.
-- ============================================================================

begin;

drop function if exists public.set_ebay_cert_id(uuid, text);
drop function if exists public.set_ebay_app_config(uuid, text, text);
drop function if exists public.has_ebay_cert_id(uuid);

commit;
