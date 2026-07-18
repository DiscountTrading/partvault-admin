-- ============================================================================
-- Backstop: a real unique constraint on (store_id, sku).
--
-- generate_next_sku is collision-proof, but it's only ONE path to a SKU — manual
-- entry in the part form and empty-string SKUs can still bypass it. This index is
-- the database-level guarantee that two parts in a store can never share a SKU,
-- so a duplicate fails LOUD at insert instead of silently landing in the data.
--
-- Only apply this if diagnostics/sku_health_check.sql query #2 returns ZERO rows
-- (i.e. no such index yet). Idempotent. Apply via the Supabase SQL editor.
--
-- IMPORTANT: run query #1 of the health check FIRST and resolve any existing
-- duplicates — this script will abort with a clear message if dupes remain,
-- rather than half-applying.
-- ============================================================================

-- Step 1: normalise empty-string SKUs to NULL so they don't count as duplicates
-- of each other and don't get locked by the unique index. Matches the intent of
-- "no SKU yet" (NULLs are distinct in a unique index; empty strings are not).
update public.parts set sku = null where sku = '';

-- Step 2: refuse to proceed if real duplicates still exist — naming them so
-- they're easy to fix (keep one, renumber the rest via generate_next_sku).
do $$
declare
  v_dupes text;
begin
  select string_agg(format('store %s / sku %L (%s copies)', store_id, sku, cnt), '; ')
    into v_dupes
    from (
      select store_id, sku, count(*) as cnt
        from public.parts
       where sku is not null
       group by store_id, sku
      having count(*) > 1
    ) d;

  if v_dupes is not null then
    raise exception
      'Cannot add unique SKU index — duplicates still exist: %. Resolve them (see sku_health_check.sql query #1) then re-run.',
      v_dupes;
  end if;
end $$;

-- Step 3: the backstop. Partial (excludes NULL SKUs — a part may legitimately
-- have none yet) and store-scoped. Includes soft-deleted rows on purpose, so a
-- deleted part's SKU is never silently reused — matching generate_next_sku,
-- which also refuses to reuse soft-deleted SKUs.
create unique index if not exists parts_store_sku_unique
  on public.parts (store_id, sku)
  where sku is not null;
