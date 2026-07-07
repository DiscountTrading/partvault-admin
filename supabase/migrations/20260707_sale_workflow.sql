-- ============================================================================
-- Fulfilment workflow for a sale — OUR local pick/pack/deliver/feedback state,
-- kept in its own table so the eBay sync (which upserts ebay_sales) can never
-- clobber it. One row per sale line (ebay_sales.id is stable — the sync upserts
-- on (store_id, order_id, line_item_id), it never delete+reinserts).
--
-- Stages: Collected → Packed → Posted → Delivered → Feedback.
--   * Posted is NOT stored here — it's read live from ebay_sales.fulfillment_status
--     (= FULFILLED once marked shipped on eBay).
--   * Collected/Packed/Delivered/Feedback are ours: eBay's API exposes no delivery
--     confirmation or feedback status, so these are set in the app (admin buttons
--     + the mobile "Collect" pick-list) and are the source of truth for them.
--
-- Written to directly by the app (admin + mobile), so it needs SELECT/INSERT/
-- UPDATE policies (ebay_sales only needed SELECT because the edge fn writes it).
-- ============================================================================

begin;

create table if not exists public.sale_workflow (
  sale_id      uuid primary key references public.ebay_sales(id) on delete cascade,
  store_id     uuid not null references public.stores(id) on delete cascade,
  collected_at timestamptz,
  collected_by uuid references auth.users(id) on delete set null,
  packed_at    timestamptz,
  delivered_at timestamptz,
  feedback_at  timestamptz,   -- feedback requested from the buyer
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users(id) on delete set null
);

create index if not exists sale_workflow_store_idx on public.sale_workflow (store_id);

alter table public.sale_workflow enable row level security;

drop policy if exists sale_workflow_select on public.sale_workflow;
create policy sale_workflow_select on public.sale_workflow
  for select using (public.is_store_member(store_id));

drop policy if exists sale_workflow_insert on public.sale_workflow;
create policy sale_workflow_insert on public.sale_workflow
  for insert with check (public.is_store_member(store_id));

drop policy if exists sale_workflow_update on public.sale_workflow;
create policy sale_workflow_update on public.sale_workflow
  for update using (public.is_store_member(store_id)) with check (public.is_store_member(store_id));

-- Live-update the admin queue and the mobile pick-list as either side marks stages.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sale_workflow'
  ) then
    alter publication supabase_realtime add table public.sale_workflow;
  end if;
end $$;

commit;
