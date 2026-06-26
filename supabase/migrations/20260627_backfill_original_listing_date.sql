-- Put the ORIGINAL listing date back on the part record.
--
-- A relisted item kept its relist's StartTime in parts.acquired_date, even though
-- it's the same physical item as the original listing. We capture every listing in
-- public.listings, so min(listed_at) is the true original listing date. This sets
-- each part's acquired_date / listed_date to the EARLIEST of what we already have
-- and that original listing date — so the Inventory list and editor show the right
-- "listed" date, not just the analytics view (20260627_insights_anchor_earliest).
--
-- Idempotent: once a part's dates are <= its first listing, re-running changes
-- nothing. least() ignores NULLs (so a null date is filled from the listing).

with firsts as (
  select part_id, min(listed_at) as first_listed
  from public.listings
  where listed_at is not null
  group by part_id
)
update public.parts p
set
  acquired_date = least(p.acquired_date, f.first_listed::date),
  listed_date   = least(coalesce(p.listed_date, f.first_listed::date), f.first_listed::date)
from firsts f
where f.part_id = p.id
  and p.deleted_at is null
  and (
       p.acquired_date is null or p.acquired_date > f.first_listed::date
    or p.listed_date  is null or p.listed_date  > f.first_listed::date
  );
