-- Dispatch workflow on the Sales tab: store shipping state + buyer + ship-to
-- from eBay getOrders so "sold → pick, pack, ship" is visible in PartVault.
-- Populated/refreshed by import_sold_orders (incl. the 5-min live check, so a
-- sale marked shipped on eBay clears from the To-send queue within minutes).
alter table public.ebay_sales add column if not exists fulfillment_status text;
alter table public.ebay_sales add column if not exists buyer text;
alter table public.ebay_sales add column if not exists ship_to jsonb;
