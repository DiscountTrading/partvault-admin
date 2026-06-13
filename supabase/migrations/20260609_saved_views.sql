-- ============================================================================
-- Saved Insights views — a user can save a named filter/sort configuration and
-- recall it later. Per-user (each person keeps their own), scoped to a store.
-- ============================================================================

begin;

create table if not exists public.saved_views (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  store_id   uuid not null references public.stores(id) on delete cascade,
  name       text not null,
  config     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists saved_views_user_store on public.saved_views (user_id, store_id);

alter table public.saved_views enable row level security;

drop policy if exists saved_views_own on public.saved_views;
create policy saved_views_own on public.saved_views
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.is_store_member(store_id));

grant select, insert, update, delete on public.saved_views to authenticated;

commit;
