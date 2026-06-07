-- ============================================================================
-- Proper eBay disconnect.
--
-- disconnectEbay() in the frontend did a direct `update` on ebay_tokens, but
-- that table only has a SELECT policy for `authenticated` — so RLS silently
-- blocked the write (0 rows changed, no error returned). The row was never
-- actually modified, so on reload the store still looked connected (and, for
-- stores carrying a leftover token from the pre-multi-store era, showed the
-- wrong eBay account).
--
-- Route disconnect through an admin-gated SECURITY DEFINER RPC that genuinely
-- clears the connection: null out the expiry and the token pointers so the
-- store reads as not-connected and no stale token can be refreshed.
-- ============================================================================

begin;

create or replace function public.disconnect_ebay(p_store_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not public.is_store_admin(p_store_id) then
    raise exception 'Unauthorised';
  end if;

  update public.ebay_tokens
     set expires_at       = null,
         expires_in       = null,
         access_token_id  = null,
         refresh_token_id = null,
         updated_at       = now()
   where store_id = p_store_id;
end;
$function$;

grant execute on function public.disconnect_ebay(uuid) to authenticated;

commit;
