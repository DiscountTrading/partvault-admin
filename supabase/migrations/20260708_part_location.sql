-- ============================================================================
-- Part storage location / bin.
-- A free-text field recording WHERE a part physically lives (shelf, bin, rack,
-- pallet, aisle — whatever the store uses). Optional and configurable: PartVault
-- serves many verticals, so we don't impose a rigid location scheme.
--
-- Surfaced on the mobile "Collect" pick-list and the admin Fulfilment queue so a
-- picker is pointed straight to the shelf instead of hunting by photo/SKU/car.
--
-- Idempotent (apply via the Supabase SQL editor — see reference_db_migrations).
-- ============================================================================

begin;

alter table public.parts add column if not exists location text;

commit;
