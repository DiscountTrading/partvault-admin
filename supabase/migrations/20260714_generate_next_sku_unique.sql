-- ============================================================================
-- Make generate_next_sku collision-proof.
--
-- Two ways it could return a duplicate SKU before:
--   1. If the store's SKU template omits {SEQ}, every part with the same car/date
--      got the IDENTICAL SKU (e.g. a 2nd part from the same car → duplicate).
--   2. If sku_seq is behind the real max (e.g. after an eBay import seeded SKUs),
--      the formatted SKU could match one already in use.
--
-- Fix: always fold the sequence into the SKU (append it when the template has no
-- {SEQ}), and loop past any SKU that already exists in the store. The counter
-- fast-forwards and persists, so later calls are instant. Idempotent (create or
-- replace); apply via the Supabase SQL editor.
-- ============================================================================

create or replace function public.generate_next_sku(p_store_id uuid, p_car_make text default null)
returns text
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_config   jsonb;
  v_template text;
  v_pad      int;
  v_seq      bigint;
  v_make     text;
  v_car      text;
  v_result   text;
  v_tries    int := 0;
begin
  -- Real users must be members; service_role / internal calls (auth.uid() null,
  -- e.g. the eBay import edge fn) are trusted and skip the check.
  if auth.uid() is not null and not public.is_store_member(p_store_id) then
    raise exception 'Unauthorised';
  end if;

  loop
    v_tries := v_tries + 1;

    -- Atomically reserve the next number (single UPDATE is race-safe; the row
    -- lock is held for the whole function so concurrent calls serialise).
    update public.stores
       set sku_seq = sku_seq + 1
     where id = p_store_id
    returning sku_seq, sku_format_config
         into v_seq, v_config;
    if v_seq is null then raise exception 'Store not found'; end if;

    v_template := coalesce(v_config->>'template', '{YY}{MM}-{CAR}-{SEQ}');
    v_pad      := coalesce((v_config->>'seqPad')::int, 3);

    v_make := regexp_replace(upper(coalesce(p_car_make, '')), '\s+', '', 'g');
    v_car  := case when v_make = '' then '' else rpad(left(v_make, 4), 4, 'X') end;

    v_result := v_template;
    v_result := replace(v_result, '{YYYY}', to_char(now(), 'YYYY'));
    v_result := replace(v_result, '{YY}',   to_char(now(), 'YY'));
    v_result := replace(v_result, '{MM}',   to_char(now(), 'MM'));
    v_result := replace(v_result, '{DD}',   to_char(now(), 'DD'));
    v_result := replace(v_result, '{CAR}',  v_car);
    v_result := replace(v_result, '{MAKE}', v_make);
    v_result := replace(v_result, '{SEQ}',  lpad(v_seq::text, v_pad, '0'));

    -- Guarantee the sequence is present even if the template forgot {SEQ} — the
    -- unique part of every SKU — so two parts can never collide by design.
    if position('{SEQ}' in v_template) = 0 then
      v_result := v_result || '-' || lpad(v_seq::text, v_pad, '0');
    end if;

    -- Collapse separators left behind by empty tokens.
    v_result := regexp_replace(v_result, '-{2,}', '-', 'g');
    v_result := regexp_replace(v_result, '^-+|-+$', '', 'g');

    -- Unique within the store (check ALL parts incl. soft-deleted, to match the
    -- unique constraint). If taken, the loop bumps the counter and tries again.
    exit when not exists (
      select 1 from public.parts where store_id = p_store_id and sku = v_result
    );

    -- Safety valve so a misconfigured template can never spin forever.
    if v_tries >= 1000 then
      v_result := v_result || '-' || v_seq::text;
      exit;
    end if;
  end loop;

  return v_result;
end;
$function$;

grant execute on function public.generate_next_sku(uuid, text) to authenticated;
