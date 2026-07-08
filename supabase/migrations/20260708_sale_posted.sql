-- ============================================================================
-- Manual "Posted" override for the fulfilment pipeline.
-- Posted is normally read live from ebay_sales.fulfillment_status (= FULFILLED
-- once the order is marked shipped on eBay). But sometimes a part is physically
-- posted BEFORE eBay recognises it — so we let the app mark it shipped locally.
-- The queue treats Posted as done when EITHER eBay says FULFILLED OR posted_at is
-- set; once eBay confirms, its status is authoritative (the pill locks).
--
-- Idempotent (apply via the Supabase SQL editor — see reference_db_migrations).
-- ============================================================================

begin;

alter table public.sale_workflow add column if not exists posted_at timestamptz;
alter table public.sale_workflow add column if not exists posted_by uuid references auth.users(id) on delete set null;

commit;
