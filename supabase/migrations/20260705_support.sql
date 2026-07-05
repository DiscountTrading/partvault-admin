-- In-house support messaging (build-our-own, not Zendesk). Customers open threads
-- and message; platform admins reply from the ops panel. All writes go through the
-- `support` edge fn (service role) so it controls sender + sends email; clients
-- only READ via RLS.

create table if not exists public.support_threads (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users(id) on delete set null,
  email      text,
  store_id   uuid references public.stores(id) on delete set null,
  subject    text not null default 'Support request',
  status     text not null default 'open',       -- open | closed
  last_sender text,                              -- customer | staff (for inbox ordering/badges)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.support_messages (
  id         uuid primary key default gen_random_uuid(),
  thread_id  uuid not null references public.support_threads(id) on delete cascade,
  sender     text not null,                      -- customer | staff
  body       text not null,
  created_at timestamptz not null default now()
);
create index if not exists support_messages_thread on public.support_messages(thread_id, created_at);
create index if not exists support_threads_status on public.support_threads(status, updated_at desc);

alter table public.support_threads  enable row level security;
alter table public.support_messages enable row level security;

-- Read: your own threads, or everything if platform admin. (Writes = edge fn only.)
do $$ begin
  if not exists (select 1 from pg_policies where tablename='support_threads' and policyname='st_read') then
    create policy st_read on public.support_threads for select to authenticated
      using (user_id = auth.uid() or public.is_platform_admin());
  end if;
  if not exists (select 1 from pg_policies where tablename='support_messages' and policyname='sm_read') then
    create policy sm_read on public.support_messages for select to authenticated
      using (exists (select 1 from public.support_threads t where t.id = thread_id and (t.user_id = auth.uid() or public.is_platform_admin())));
  end if;
end $$;
