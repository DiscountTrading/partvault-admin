-- Multi-quantity parts. A dismantled part is always one unique item (quantity 1),
-- but a buy-in reseller stocks N identical units (e.g. 10 window switches) as one
-- line. `quantity` = units acquired; `quantity_sold` = units sold so far
-- (maintained by the eBay sales sync). Available = quantity - quantity_sold.
-- Idempotent; existing rows default to 1 unit so nothing changes for them.
alter table public.parts add column if not exists quantity      integer not null default 1;
alter table public.parts add column if not exists quantity_sold integer not null default 0;

-- Guard against nonsense values.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'parts_quantity_positive') then
    alter table public.parts add constraint parts_quantity_positive check (quantity >= 1);
  end if;
end $$;
