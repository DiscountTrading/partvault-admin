-- ============================================================================
-- eBay sales mirror — a 1:1, idempotent copy of eBay order line items.
--
-- WHY: sales were previously recorded by stamping a `parts` row (status='sold',
-- one sold_price, one ebay_order_id). A part can only hold ONE sale, so relists
-- / repeat sales of the same SKU or item id overwrote each other and the totals
-- drifted from eBay. This table fixes that by construction: every eBay line item
-- becomes exactly one row, keyed on eBay's own unique key (order_id, line_item_id).
-- Re-imports upsert on that key, so a sale can never be overwritten or duplicated.
--
-- The Dashboard P&L and the Sales-match check read sales + fees FROM THIS TABLE,
-- so they equal eBay's getOrders to the cent. `part_id` is a best-effort link to
-- inventory (for COGS/margin) and may be null when no matching part exists — the
-- sale is still recorded.
-- ============================================================================

begin;

create table if not exists public.ebay_sales (
  id             uuid primary key default gen_random_uuid(),
  store_id       uuid not null references public.stores(id) on delete cascade,
  order_id       text not null,
  line_item_id   text not null,
  legacy_item_id text,
  sku            text,
  title          text,
  quantity       int          not null default 1,
  sold_price     numeric(12,2) not null default 0,  -- line item total (incl. qty)
  shipping       numeric(12,2) not null default 0,  -- shipping apportioned to this line
  fees           numeric(12,2) not null default 0,  -- eBay fees apportioned to this line
  sold_at        timestamptz,
  cancelled      boolean      not null default false,
  part_id        uuid references public.parts(id) on delete set null,
  created_at     timestamptz  not null default now(),
  updated_at     timestamptz  not null default now(),
  unique (store_id, order_id, line_item_id)
);

create index if not exists ebay_sales_store_sold_idx on public.ebay_sales (store_id, sold_at);
create index if not exists ebay_sales_order_idx       on public.ebay_sales (store_id, order_id);
create index if not exists ebay_sales_part_idx        on public.ebay_sales (part_id);

alter table public.ebay_sales enable row level security;

-- Store members can read their store's sales; writes happen via the edge function
-- (service role bypasses RLS), so only a SELECT policy is needed for the app.
drop policy if exists ebay_sales_select on public.ebay_sales;
create policy ebay_sales_select on public.ebay_sales
  for select using (public.is_store_member(store_id));

commit;
