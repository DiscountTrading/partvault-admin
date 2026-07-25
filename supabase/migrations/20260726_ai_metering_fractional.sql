-- ============================================================================
-- Fractional AI metering — "ALL AI is metered" (Paul, 2026-07-26).
-- Every AI operation now debits credits, with fractional weights (min 0.1 credit
-- = 1¢ at the 10¢/credit retail price): help question 0.1, quick-name 0.1,
-- parse-title 0.1, mobile stage-1 capture 0.2, eBay specifics fill 0.2,
-- vehicle-ID 0.3, description 0.5, description options 1.0, full assessment
-- 1 / 2 / 4 by model (Gemini-Haiku / Sonnet / Opus).
--
-- Changes:
--   1. ai_usage counts + ai_credits balance become numeric (were int).
--   2. The amount-parameter RPCs are REPLACED with numeric versions (the int
--      overloads are DROPPED — PostgREST cannot disambiguate two 3-arg overloads
--      with identical parameter names, so numeric must replace int, not join it).
--      Integer callers (weights 1/2/4) keep working — ints are valid numerics.
--   3. ai_usage_log gains a `credits` column so every logged op records what it
--      charged (margin auditing + the future per-op usage breakdown / Stripe).
--
-- Until this runs, fractional charges fail-open (uncounted — the edge fns catch
-- the RPC error), and integer charges keep metering via the old int functions.
-- Idempotent. Apply via the Supabase SQL editor.
-- ============================================================================

-- 1. Numeric columns (usage counts + credit balance can now hold tenths).
alter table public.ai_usage
  alter column full_count  type numeric using full_count::numeric,
  alter column light_count type numeric using light_count::numeric;
alter table public.ai_credits
  alter column balance type numeric using balance::numeric;
alter table public.ai_usage_log add column if not exists credits numeric;

-- 2. Replace the int-amount RPCs with numeric-amount versions.
drop function if exists public.increment_ai_usage(uuid, text, int);
create or replace function public.increment_ai_usage(p_store_id uuid, p_kind text, p_amount numeric)
returns numeric language plpgsql security definer set search_path to 'public' as $function$
declare
  v_month text := to_char(now() at time zone 'utc', 'YYYY-MM');
  v_count numeric;
  v_amt   numeric := greatest(0.1, coalesce(p_amount, 1));
begin
  insert into public.ai_usage (store_id, month, full_count, light_count)
  values (p_store_id, v_month,
          case when p_kind = 'full' then v_amt else 0 end,
          case when p_kind = 'full' then 0 else v_amt end)
  on conflict (store_id, month) do update set
    full_count  = public.ai_usage.full_count  + (case when p_kind = 'full' then v_amt else 0 end),
    light_count = public.ai_usage.light_count + (case when p_kind = 'full' then 0 else v_amt end),
    updated_at  = now();
  select (case when p_kind = 'full' then full_count else light_count end) into v_count
  from public.ai_usage where store_id = p_store_id and month = v_month;
  return v_count;
end $function$;

drop function if exists public.consume_ai_credit(uuid, int);
create or replace function public.consume_ai_credit(p_store_id uuid, p_amount numeric)
returns boolean language plpgsql security definer set search_path to 'public' as $function$
declare ok boolean; v_amt numeric := greatest(0.1, coalesce(p_amount, 1));
begin
  update public.ai_credits
     set balance = balance - v_amt, updated_at = now()
   where store_id = p_store_id and balance >= v_amt
  returning true into ok;
  return coalesce(ok, false);
end $function$;
