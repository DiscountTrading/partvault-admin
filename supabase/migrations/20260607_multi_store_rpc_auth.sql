-- ============================================================================
-- Follow-up to 20260607_multi_store.sql
--
-- Per-store SECURITY DEFINER RPCs were still authorizing against the OLD
-- single-store model (profiles.store_id = p_store_id AND role = 'admin').
-- That breaks for any store the user manages via membership rather than their
-- profile's home store (e.g. a newly created store where they are 'owner').
--
-- Switch the authorization check to the membership helper is_store_admin(),
-- which recognizes 'owner' and 'admin' members.
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
    -- Update the existing vault secret in place
    update vault.secrets set secret = p_cert_id where id = v_existing_vault_id;
  else
    -- No vault entry yet — create one and link it
    insert into vault.secrets (secret, name)
    values (p_cert_id, 'ebay_cert_' || p_store_id::text)
    returning id into v_new_secret_id;

    insert into public.ebay_tokens (store_id, cert_id_id)
    values (p_store_id, v_new_secret_id)
    on conflict (store_id) do update set cert_id_id = excluded.cert_id_id;
  end if;
end;
$function$;

commit;
