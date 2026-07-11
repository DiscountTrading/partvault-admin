-- ============================================================================
-- Storage containers — tubs / buckets / bins that hold parts.
--
-- The Row/Bay/Shelf grid (20260711_part_grid_location) covers fixed shelving,
-- but a lot of stock lives in movable tubs. A container is a labelled bin with:
--   * a short `code` (unique per store) that its printable QR encodes, so the
--     mobile scanner can look it up;
--   * an OPTIONAL grid home (loc_row/bay/shelf) — where the tub is parked. When
--     a part is scanned into a container the app copies that home onto the part,
--     so a tub with a home behaves like a shelf cell and a tub without one just
--     "floats" and is found by scanning.
--
-- parts.container_id points a part at its container (null = loose / on a shelf).
-- Optional & per-store: enabled via stores.settings.warehouse.containers.
--
-- Idempotent (apply via the Supabase SQL editor — see reference_db_migrations).
-- ============================================================================

begin;

create table if not exists public.containers (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.stores(id) on delete cascade,
  code       text not null,                 -- short human/QR code, e.g. TUB-014
  name       text,                           -- optional label, e.g. "Corolla fronts"
  kind       text not null default 'bucket', -- bucket | tub | bin | …
  loc_row    smallint,
  loc_bay    smallint,
  loc_shelf  smallint,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  deleted_at timestamptz,
  unique (store_id, code)
);

create index if not exists containers_store_idx on public.containers (store_id) where deleted_at is null;

alter table public.parts add column if not exists container_id uuid references public.containers(id) on delete set null;
create index if not exists parts_container_idx on public.parts (container_id) where container_id is not null;

alter table public.containers enable row level security;

drop policy if exists containers_select on public.containers;
create policy containers_select on public.containers
  for select using (public.is_store_member(store_id));

drop policy if exists containers_insert on public.containers;
create policy containers_insert on public.containers
  for insert with check (public.is_store_member(store_id));

drop policy if exists containers_update on public.containers;
create policy containers_update on public.containers
  for update using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));

drop policy if exists containers_delete on public.containers;
create policy containers_delete on public.containers
  for delete using (public.is_store_member(store_id));

-- Live-update the admin manager + mobile scanner as containers change.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'containers'
  ) then
    alter publication supabase_realtime add table public.containers;
  end if;
end $$;

commit;
