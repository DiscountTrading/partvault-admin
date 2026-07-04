-- Subscription plans (per docs/SUBSCRIPTIONS_AND_MULTI_COUNTRY.md).
-- Plan lives on the STORE (billable unit). Trial is per ACCOUNT, used once.
-- Stripe wiring comes later — this is the plan/limits/metering foundation.

-- 1) Plan on the store. jsonb: { tier, trial_ends_at, paid_through, cadence, founder }
alter table public.stores add column if not exists plan jsonb not null default '{}'::jsonb;

-- Existing stores predate billing — grandfather them as founder/business so
-- nothing is ever gated for the original operator.
update public.stores set plan = jsonb_build_object('tier', 'business', 'founder', true)
where coalesce(plan->>'tier', '') = '';

-- Only the service role (Stripe webhooks / admin tooling) may change a store's
-- plan — otherwise any store owner could self-upgrade via a row update.
create or replace function public.protect_plan_column() returns trigger
language plpgsql as $$
begin
  if new.plan is distinct from old.plan
     and coalesce(auth.jwt()->>'role', current_setting('request.jwt.claims', true)::jsonb->>'role', '') <> 'service_role' then
    raise exception 'Plan changes are managed by billing — contact support.';
  end if;
  return new;
end $$;
drop trigger if exists trg_protect_plan on public.stores;
create trigger trg_protect_plan before update on public.stores
  for each row execute function public.protect_plan_column();

-- 2) Per-account flags (trial used once per account, ever).
create table if not exists public.user_flags (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  trial_used_at timestamptz
);
alter table public.user_flags enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='user_flags' and policyname='user_flags_own') then
    create policy user_flags_own on public.user_flags for select to authenticated using (user_id = auth.uid());
  end if;
end $$;

-- 3) create_store: new stores start a 14-day full trial if the account hasn't
-- used one; otherwise they start unpaid-basic (subscribe to activate — Stripe
-- later; until then support can set plans via service role).
create or replace function public.create_store(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
  v_trial_used timestamptz;
begin
  if coalesce(trim(p_name), '') = '' then
    raise exception 'Store name is required';
  end if;

  select trial_used_at into v_trial_used from public.user_flags where user_id = auth.uid();

  insert into public.stores (name, join_code, plan)
  values (
    p_name,
    upper(substr(md5(random()::text), 1, 6)),
    case when v_trial_used is null
      then jsonb_build_object('tier', 'trial', 'trial_ends_at', (now() + interval '14 days'))
      else jsonb_build_object('tier', 'basic')
    end
  )
  returning id into new_id;

  if v_trial_used is null then
    insert into public.user_flags (user_id, trial_used_at) values (auth.uid(), now())
    on conflict (user_id) do update set trial_used_at = coalesce(public.user_flags.trial_used_at, now());
  end if;

  insert into public.store_members (user_id, store_id, role)
  values (auth.uid(), new_id, 'owner');

  return new_id;
end $$;

-- 4) AI usage metering: one row per store per month. Only the edge functions
-- (service role) write; store members can read their own usage.
create table if not exists public.ai_usage (
  store_id   uuid not null references public.stores(id) on delete cascade,
  month      text not null,            -- 'YYYY-MM' (UTC)
  full_count int  not null default 0,  -- Sonnet assessments/descriptions (the real cost)
  light_count int not null default 0,  -- Haiku naming etc (near-free, tracked for visibility)
  updated_at timestamptz not null default now(),
  primary key (store_id, month)
);
alter table public.ai_usage enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='ai_usage' and policyname='ai_usage_member_read') then
    create policy ai_usage_member_read on public.ai_usage for select to authenticated
      using (exists (select 1 from public.store_members m where m.store_id = ai_usage.store_id and m.user_id = auth.uid()));
  end if;
end $$;

-- Atomic increment, returns the new count for the month (service role only).
create or replace function public.increment_ai_usage(p_store_id uuid, p_kind text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month text := to_char(now() at time zone 'utc', 'YYYY-MM');
  v_count int;
begin
  insert into public.ai_usage (store_id, month, full_count, light_count)
  values (p_store_id, v_month, case when p_kind = 'full' then 1 else 0 end, case when p_kind = 'full' then 0 else 1 end)
  on conflict (store_id, month) do update set
    full_count  = public.ai_usage.full_count  + (case when p_kind = 'full' then 1 else 0 end),
    light_count = public.ai_usage.light_count + (case when p_kind = 'full' then 0 else 1 end),
    updated_at  = now();
  select (case when p_kind = 'full' then full_count else light_count end) into v_count
  from public.ai_usage where store_id = p_store_id and month = v_month;
  return v_count;
end $$;
revoke execute on function public.increment_ai_usage(uuid, text) from public, anon, authenticated;
