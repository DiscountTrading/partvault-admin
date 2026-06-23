-- Refund + real shipping-cost capture on the eBay sales mirror.
--
-- A sale that ships then gets refunded is a genuine LOSS: revenue reverses to $0
-- but the shipping label (and any non-refunded ad fees) are real sunk costs. eBay
-- exposes these in the Finances API as REFUND and SHIPPING_LABEL transactions,
-- linked by order id. We store them per sale row so the Dashboard P&L can net
-- revenue (sale − refund) while keeping the shipping cost as an expense.

begin;

alter table public.ebay_sales add column if not exists refund     numeric(12,2) not null default 0; -- money returned to buyer
alter table public.ebay_sales add column if not exists ship_cost  numeric(12,2) not null default 0; -- eBay shipping label cost we paid
alter table public.ebay_sales add column if not exists refunded   boolean       not null default false;

commit;
