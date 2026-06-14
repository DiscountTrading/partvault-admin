-- ============================================================================
-- parts_for_listing: parts plus their primary photo resolved from the
-- normalized photos table (not the legacy parts.photos column), so the
-- List-to-eBay screen shows thumbnails for imported parts too. security_invoker
-- so the caller's RLS on parts/photos still applies (store-scoped).
-- ============================================================================

begin;

drop view if exists public.parts_for_listing;

create view public.parts_for_listing
with (security_invoker = true)
as
select
  p.*,
  (
    select coalesce(ph.url, ph.ebay_url)
    from public.photos ph
    where ph.parent_type = 'part' and ph.parent_id = p.id
    order by ph.is_primary desc nulls last, ph.display_order asc nulls last
    limit 1
  ) as primary_photo
from public.parts p;

grant select on public.parts_for_listing to authenticated;

commit;
