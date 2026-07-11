-- ============================================================================
-- Structured warehouse-grid location for parts (Row / Bay / Shelf).
--
-- Builds on the free-text `parts.location` (20260708_part_location.sql), which
-- stays as a fallback/notes field. These optional numeric coordinates map a
-- part onto the store's configured warehouse grid (stores.settings.warehouse =
-- { enabled, rows, bays, shelves, ...labels }) so the mobile Collect pick-list
-- can draw a mini-map and point a picker straight to the cell.
--
-- Optional & configurable per store — PartVault serves many verticals, so the
-- grid is off by default and stores that don't use it are unaffected.
--
-- Idempotent (apply via the Supabase SQL editor — see reference_db_migrations).
-- ============================================================================

begin;

alter table public.parts add column if not exists loc_row   smallint;
alter table public.parts add column if not exists loc_bay   smallint;
alter table public.parts add column if not exists loc_shelf smallint;

commit;
