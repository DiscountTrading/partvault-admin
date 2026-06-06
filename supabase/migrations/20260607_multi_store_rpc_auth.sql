-- ============================================================================
-- Follow-up to 20260607_multi_store.sql
--
-- Two fixes for set_ebay_cert_id:
--
-- 1. AUTH: Per-store SECURITY DEFINER RPCs were still authorizing against the
--    OLD single-store model (profiles.store_id = p_store_id AND role = 'admin').
--    That breaks for any store the user manages via membership rather than their
--    profile's home store (e.g. a newly created store where they are 'owner').
--    Switch to the membership helper is_store_admin() (recognizes owner/admin).
--
-- 2. VAULT: Raw INSERT/UPDATE on vault.secrets triggers an internal encryption
--    function (_crypto_aead_det_noncegen) the function owner can't execute,
--    producing "permission denied for function _crypto_aead_det_noncegen".
--    Use Vault's official wrappers vault.create_secret()/vault.update_secret(),
--    which run with the correct privileges.
-- ============================================================================

begin;

create or replace function public.set_ebay_cert_id(p_store_id uuid, p_cert_id text)
returns void
language plpgsql
security definer
set search_path to 'public', 'vault'
as $function$
declare
  v_existing_vault_id uuid;
  v_new_secret_id     uuid;
begin
  -- Only store admins/owners (by membership) can update credentials
  if not public.is_store_admin(p_store_id) then
    raise exception 'Unauthorised';
  end if;

  select cert_id_id into v_existing_vault_id
  from public.ebay_tokens where store_id = p_store_id;

  if v_existing_vault_id is not null then
    -- Update the existing vault secret in place (via Vault wrapper)
    perform vault.update_secret(v_existing_vault_id, p_cert_id);
  else
    -- No vault entry yet — create one (via Vault wrapper) and link it
    v_new_secret_id := vault.create_secret(p_cert_id, 'ebay_cert_' || p_store_id::text);

    insert into public.ebay_tokens (store_id, cert_id_id)
    values (p_store_id, v_new_secret_id)
    on conflict (store_id) do update set cert_id_id = excluded.cert_id_id;
  end if;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Persist the non-sensitive eBay app config (App ID + RuName).
--
-- These are NOT secrets (App ID appears in API requests; RuName is the OAuth
-- redirect name) and are identical across every store for a given developer
-- keyset. They were previously written by a direct browser upsert into
-- ebay_tokens, but the multi-store migration only granted SELECT on that table
-- to `authenticated` — so the write was silently denied by RLS and ru_name
-- stayed null, producing "RuName not configured" at connect time.
--
-- Route the write through an admin-gated SECURITY DEFINER RPC instead, so the
-- browser never needs direct write access to ebay_tokens.
-- ---------------------------------------------------------------------------
create or replace function public.set_ebay_app_config(
  p_store_id uuid,
  p_app_id   text,
  p_ru_name  text
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not public.is_store_admin(p_store_id) then
    raise exception 'Unauthorised';
  end if;

  insert into public.ebay_tokens (store_id, app_id, ru_name)
  values (p_store_id, p_app_id, p_ru_name)
  on conflict (store_id) do update
    set app_id  = excluded.app_id,
        ru_name = excluded.ru_name;
end;
$function$;

grant execute on function public.set_ebay_app_config(uuid, text, text) to authenticated;

commit;
