-- ============================================================================
-- Editable, per-store SKU format with a true store-wide atomic counter.
--
-- Before: generate_next_sku() produced a fixed {prefix}{YY-MM}-{NNN} and derived
-- the running number by regex-parsing existing SKUs for the current month
-- (MAX(suffix) WHERE sku ~ period-pattern). That resets monthly and can't work
-- with a user-defined template (you can't parse a SEQ out of a format you don't
-- know in advance), and deleting the latest part would reuse its number.
--
-- After: each store has its own editable template string (sku_format_config.template)
-- and a monotonic counter (stores.sku_seq) that never reuses a number. The function
-- becomes the single authority for SKU generation across the admin form, the mobile
-- app, and the eBay import path. SECURITY DEFINER + membership check so any store
-- member (not just admins) can mint a SKU when adding a part.
--
-- Token set: {YYYY} {YY} {MM} {DD} {CAR} {MAKE} {SEQ}
--   {CAR}  = make, spaces stripped, uppercased, first 4 chars padded to 4 with X
--   {MAKE} = full make, spaces stripped, uppercased
--   {SEQ}  = the store counter, left-padded to seqPad digits (default 3)
-- Missing tokens (e.g. no car linked, or a non-auto store) render empty and any
-- resulting doubled / leading / trailing '-' separators are collapsed.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Atomic store-wide counter, seeded above each store's current max suffix
--    so freshly minted SKUs can't collide with existing ones.
-- ---------------------------------------------------------------------------
alter table public.stores
  add column if not exists sku_seq bigint not null default 0;

update public.stores s
   set sku_seq = greatest(
     s.sku_seq,
     coalesce((
       select max((regexp_match(p.sku, '\d+$'))[1]::bigint)
       from public.parts p
       where p.store_id = s.id
         and p.deleted_at is null
         and p.sku ~ '\d+$'
     ), 0)
   );

-- ---------------------------------------------------------------------------
-- 2. Ensure every store has an explicit template + seqPad the Settings UI can
--    read and edit. Default is the format the mobile capture flow already uses.
-- ---------------------------------------------------------------------------
update public.stores
   set sku_format_config = coalesce(sku_format_config, '{}'::jsonb)
     || jsonb_build_object(
          'template', coalesce(sku_format_config->>'template', '{YY}{MM}-{CAR}-{SEQ}'),
          'seqPad',   coalesce((sku_format_config->>'seqPad')::int, 3)
        );

-- ---------------------------------------------------------------------------
-- 3. Replace the generator. Old 1-arg signature is dropped first so the new
--    overload (car make optional) isn't ambiguous with it.
-- ---------------------------------------------------------------------------
drop function if exists public.generate_next_sku(uuid);

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
begin
  -- Real users must be members; service_role / internal calls (auth.uid() is
  -- null, e.g. the eBay import edge function) are trusted and skip the check.
  if auth.uid() is not null and not public.is_store_member(p_store_id) then
    raise exception 'Unauthorised';
  end if;

  -- Atomically reserve the next number (single UPDATE is race-safe)
  update public.stores
     set sku_seq = sku_seq + 1
   where id = p_store_id
  returning sku_seq, sku_format_config
       into v_seq, v_config;

  if v_seq is null then
    raise exception 'Store not found';
  end if;

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

  -- Collapse separators left behind by empty tokens
  v_result := regexp_replace(v_result, '-{2,}', '-', 'g');
  v_result := regexp_replace(v_result, '^-+|-+$', '', 'g');

  return v_result;
end;
$function$;

grant execute on function public.generate_next_sku(uuid, text) to authenticated;

commit;
