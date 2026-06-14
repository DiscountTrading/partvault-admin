-- ============================================================================
-- Per-photo thumbnail URL. We now upload a small (~320px) thumbnail alongside
-- the compressed (~1600px) main image, so lists/grids render fast without
-- downloading full-size photos. Existing rows keep thumb_url null and fall back
-- to the main url.
-- ============================================================================

begin;

alter table public.photos add column if not exists thumb_url text;

-- Recreate parts_for_listing so its thumbnail prefers the small thumb_url.
drop view if exists public.parts_for_listing;
create view public.parts_for_listing
with (security_invoker = true)
as
select
  p.*,
  (
    select coalesce(ph.thumb_url, ph.url, ph.ebay_url)
    from public.photos ph
    where ph.parent_type = 'part' and ph.parent_id = p.id
    order by ph.is_primary desc nulls last, ph.display_order asc nulls last
    limit 1
  ) as primary_photo
from public.parts p;

grant select on public.parts_for_listing to authenticated;

commit;
