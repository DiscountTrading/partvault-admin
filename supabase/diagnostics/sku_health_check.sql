-- ============================================================================
-- SKU health check — paste into the Supabase SQL editor and run each block.
-- Answers three questions: (1) any duplicates RIGHT NOW? (2) does a unique
-- constraint exist? (3) is generate_next_sku the collision-proof version, and
-- is sku_seq ahead of the real max? Read-only. Safe to run any time.
-- ============================================================================

-- 1. ACTUAL DUPLICATES (the real "is it broken" test). Groups live + soft-deleted
--    separately so you can see whether dupes are among active parts or old rows.
--    Empty-string SKUs are treated as dupes too (they shouldn't repeat).
select store_id,
       sku,
       count(*)                                   as copies,
       count(*) filter (where deleted_at is null) as live_copies,
       array_agg(id order by created_at)          as part_ids
  from public.parts
 where sku is not null and sku <> ''
 group by store_id, sku
having count(*) > 1
 order by copies desc, sku;
-- Expected result: ZERO rows. Any row = real duplicate SKUs to resolve.

-- 2. Does a unique constraint / index on (store_id, sku) exist?
select indexname, indexdef
  from pg_indexes
 where schemaname = 'public'
   and tablename  = 'parts'
   and indexdef ilike '%unique%'
   and indexdef ilike '%sku%';
-- Expected: at least one row. ZERO rows = NO backstop; dupes can slip in via
-- manual SKU entry. Apply 20260718_parts_sku_unique.sql (see sibling file).

-- 3. Is generate_next_sku the new collision-proof version? (looks for the
--    "loop past any SKU that already exists" behaviour by checking source).
select case
         when pg_get_functiondef(oid) ilike '%v_tries%'
          and pg_get_functiondef(oid) ilike '%position(''{SEQ}''%'
         then 'NEW (collision-proof) ✓'
         else 'OLD — apply 20260714_generate_next_sku_unique.sql'
       end as generate_next_sku_status
  from pg_proc
 where proname = 'generate_next_sku'
   and pronamespace = 'public'::regnamespace;

-- 4. Is each store's sku_seq ahead of the highest numeric SKU suffix in use?
--    If sku_seq <= max_suffix, the next generated SKU could collide (the new
--    function self-heals by looping, but this shows whether the counter drifted,
--    usually after an eBay import seeded high-numbered SKUs).
select s.id,
       s.name,
       s.sku_seq,
       max((regexp_match(p.sku, '(\d+)$'))[1]::bigint) as max_numeric_suffix
  from public.stores s
  left join public.parts p
    on p.store_id = s.id and p.sku ~ '\d+$'
 group by s.id, s.name, s.sku_seq
 order by s.name;
-- Healthy: sku_seq >= max_numeric_suffix for every store.
