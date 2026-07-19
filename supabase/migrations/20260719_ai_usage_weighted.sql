-- ============================================================================
-- Weighted AI metering — lets a per-store model choice consume the monthly
-- assessment allowance / credit packs at different rates (Economy 1 / Standard 2
-- / Premium 4 credits per part). Adds amount-parameter OVERLOADS of the existing
-- RPCs; the original 1-step signatures stay, so nothing that calls them breaks.
-- Idempotent. Apply via the Supabase SQL editor.
-- ============================================================================

-- Increment full/light usage by an arbitrary amount (weight).
create or replace function public.increment_ai_usage(p_store_id uuid, p_kind text, p_amount int)
returns integer language plpgsql security definer set search_path to 'public' as $function$
declare
  v_month text := to_char(now() at time zone 'utc', 'YYYY-MM');
  v_count int;
  v_amt   int := greatest(1, coalesce(p_amount, 1));
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

-- Consume N credits atomically; true only if the balance covered the full amount.
create or replace function public.consume_ai_credit(p_store_id uuid, p_amount int)
returns boolean language plpgsql security definer set search_path to 'public' as $function$
declare ok boolean; v_amt int := greatest(1, coalesce(p_amount, 1));
begin
  update public.ai_credits
     set balance = balance - v_amt, updated_at = now()
   where store_id = p_store_id and balance >= v_amt
  returning true into ok;
  return coalesce(ok, false);
end $function$;
