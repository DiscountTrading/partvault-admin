-- Store the eBay order id on each sold part so eBay fees (from the Finances API,
-- which are per-order) can be attributed back to the right part(s). eBay fees are
-- recorded in costs->>'ebay_fees' (no schema change needed for that).
alter table public.parts add column if not exists ebay_order_id text;
create index if not exists parts_ebay_order_id_idx on public.parts (store_id, ebay_order_id);
