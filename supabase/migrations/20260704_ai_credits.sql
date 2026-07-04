-- AI credit packs: top-up assessments used AFTER the monthly plan allowance is
-- exhausted (1 credit = 1 full Sonnet assessment). Balance is store-level and
-- writable ONLY via the security-definer RPCs below — never a plain column
-- update — so an owner can't grant themselves credits. Purchases (Stripe, step 6)
-- call grant_ai_credits from the webhook; support can call it manually now.

create table if not exists public.ai_credits (
  store_id   uuid primary key references public.stores(id) on delete cascade,
  balance    int  not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.ai_credits enable row level security;

-- Members can SEE their store's balance; nobody can write it directly.
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='ai_credits' and policyname='ai_credits_member_read') then
    create policy ai_credits_member_read on public.ai_credits for select to authenticated
      using (exists (select 1 from public.store_members m where m.store_id = ai_credits.store_id and m.user_id = auth.uid()));
  end if;
end $$;

-- Atomically consume one credit. Returns true if a credit was available and
-- decremented, false otherwise. Called by ai-assess (service role) when the
-- monthly plan allowance is exhausted.
create or replace function public.consume_ai_credit(p_store_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare ok boolean;
begin
  update public.ai_credits
     set balance = balance - 1, updated_at = now()
   where store_id = p_store_id and balance > 0
  returning true into ok;
  return coalesce(ok, false);
end $$;
revoke execute on function public.consume_ai_credit(uuid) from public, anon, authenticated;

-- Add credits (purchase / support grant). Returns the new balance.
create or replace function public.grant_ai_credits(p_store_id uuid, p_amount int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_balance int;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'amount must be positive'; end if;
  insert into public.ai_credits (store_id, balance) values (p_store_id, p_amount)
  on conflict (store_id) do update set balance = public.ai_credits.balance + p_amount, updated_at = now()
  returning balance into v_balance;
  return v_balance;
end $$;
revoke execute on function public.grant_ai_credits(uuid, int) from public, anon, authenticated;
