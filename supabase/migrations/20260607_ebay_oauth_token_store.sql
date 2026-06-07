-- ============================================================================
-- Store eBay OAuth tokens on connect (create-or-update).
--
-- Background: the OAuth callback (exchange_oauth_code in the edge function)
-- previously called update_ebay_access_token(), which:
--   * REQUIRES an existing ebay_tokens row (raises "No ebay_tokens row found"
--     otherwise) — the row used to be created as a side effect of saving the
--     Cert ID, but that step has been removed now that the keyset lives in
--     edge-function secrets; and
--   * only writes the ACCESS token — it silently discards the refresh token
--     eBay returns, so reconnecting never updates the long-lived refresh token.
--
-- This RPC does the complete job: upserts the ebay_tokens row and writes BOTH
-- the access and refresh tokens into Vault (creating the secrets on first
-- connect, updating them in place thereafter).
--
-- Called server-side from the edge function (service_role), so no per-user
-- authorization check is needed here.
-- ============================================================================

begin;

create or replace function public.store_ebay_oauth_tokens(
  p_store_id      uuid,
  p_access_token  text,
  p_refresh_token text,
  p_expires_at    timestamptz,
  p_expires_in    integer
)
returns void
language plpgsql
security definer
set search_path to 'public', 'vault'
as $function$
declare
  v_access_id   uuid;
  v_refresh_id  uuid;
  v_access_name  text := 'ebay_access_'  || p_store_id::text;
  v_refresh_name text := 'ebay_refresh_' || p_store_id::text;
begin
  select access_token_id, refresh_token_id
    into v_access_id, v_refresh_id
  from public.ebay_tokens
  where store_id = p_store_id;

  -- Access token. If the row's pointer is null (e.g. after a disconnect) a Vault
  -- secret with this name may still exist — reuse it rather than create a dup
  -- (vault.secrets.name is unique).
  if v_access_id is null then
    select id into v_access_id from vault.secrets where name = v_access_name;
  end if;
  if v_access_id is null then
    v_access_id := vault.create_secret(p_access_token, v_access_name);
  else
    perform vault.update_secret(v_access_id, p_access_token);
  end if;

  -- Refresh token: only touch it if eBay actually returned one
  if coalesce(p_refresh_token, '') <> '' then
    if v_refresh_id is null then
      select id into v_refresh_id from vault.secrets where name = v_refresh_name;
    end if;
    if v_refresh_id is null then
      v_refresh_id := vault.create_secret(p_refresh_token, v_refresh_name);
    else
      perform vault.update_secret(v_refresh_id, p_refresh_token);
    end if;
  end if;

  insert into public.ebay_tokens (store_id, access_token_id, refresh_token_id, expires_at, expires_in)
  values (p_store_id, v_access_id, v_refresh_id, p_expires_at, p_expires_in)
  on conflict (store_id) do update set
    access_token_id  = excluded.access_token_id,
    -- keep the existing refresh token if this exchange didn't return a new one
    refresh_token_id = coalesce(excluded.refresh_token_id, public.ebay_tokens.refresh_token_id),
    expires_at       = excluded.expires_at,
    expires_in       = excluded.expires_in,
    updated_at       = now();
end;
$function$;

grant execute on function public.store_ebay_oauth_tokens(uuid, text, text, timestamptz, integer) to service_role;

commit;
