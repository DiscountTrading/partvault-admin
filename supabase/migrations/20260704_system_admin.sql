-- Platform administration: system-wide settings (NOT per-store/subscription),
-- gated to platform admins. Home for the purge-confirmation email/mobile and any
-- other global config.

-- Who can administer the platform. Seeded with the founder by email.
create table if not exists public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.platform_admins enable row level security; -- no policies → not client-readable; the definer fn below is the only path
insert into public.platform_admins (user_id)
  select id from auth.users where lower(email) = 'leap00@gmail.com'
  on conflict do nothing;

create or replace function public.is_platform_admin() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;
grant execute on function public.is_platform_admin() to authenticated;

-- Single-row system settings (jsonb). Only platform admins can read/write.
create table if not exists public.system_settings (
  id         int primary key default 1,
  settings   jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint system_settings_singleton check (id = 1)
);
insert into public.system_settings (id, settings)
  values (1, jsonb_build_object('purgeAlertEmail','leap00@gmail.com'))
  on conflict (id) do nothing;

alter table public.system_settings enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='system_settings' and policyname='sys_read') then
    create policy sys_read on public.system_settings for select to authenticated using (public.is_platform_admin());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='system_settings' and policyname='sys_write') then
    create policy sys_write on public.system_settings for update to authenticated
      using (public.is_platform_admin()) with check (public.is_platform_admin());
  end if;
end $$;

-- keep updated_at fresh
create or replace function public.touch_system_settings() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
drop trigger if exists trg_touch_system_settings on public.system_settings;
create trigger trg_touch_system_settings before update on public.system_settings
  for each row execute function public.touch_system_settings();
