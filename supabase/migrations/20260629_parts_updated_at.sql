-- Optimistic concurrency for part edits: an updated_at stamp that bumps on every
-- UPDATE. The app saves with `where id = ? and updated_at = <value when opened>`,
-- so if someone else changed the row in the meantime the save matches 0 rows and is
-- rejected (instead of silently overwriting their change). No held locks.

alter table public.parts add column if not exists updated_at timestamptz not null default now();

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists parts_set_updated_at on public.parts;
create trigger parts_set_updated_at
  before update on public.parts
  for each row execute function public.set_updated_at();
