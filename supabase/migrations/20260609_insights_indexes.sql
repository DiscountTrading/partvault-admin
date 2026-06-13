-- ============================================================================
-- Performance for the Stock Insights view. The part_insights view aggregates
-- listings per part (relist count, days listed); without an index on
-- listings.part_id that's a sequential scan per part. Postgres does NOT auto-
-- index foreign keys, so add it. Also help the store-scoped parts scan.
-- ============================================================================

begin;

create index if not exists listings_part_id_idx on public.listings (part_id);
create index if not exists parts_store_active_idx on public.parts (store_id) where deleted_at is null;

commit;
