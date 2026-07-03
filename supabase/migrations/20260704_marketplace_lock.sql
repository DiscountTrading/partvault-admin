-- Marketplace lock: a store's marketplace (settings->>'marketplace') is chosen at
-- store creation and becomes IMMUTABLE once the store has any parts — prices,
-- categories and currency are committed to that country from the first part.
-- A different country = a new store. Enforced here so no client can bypass it.
-- Absent value = EBAY_AU (legacy default), so explicitly setting EBAY_AU on an
-- older store is not treated as a change.
create or replace function public.enforce_marketplace_lock() returns trigger
language plpgsql as $$
begin
  if coalesce(old.settings->>'marketplace', 'EBAY_AU') is distinct from coalesce(new.settings->>'marketplace', 'EBAY_AU')
     and exists (select 1 from public.parts where store_id = new.id limit 1) then
    raise exception 'Marketplace is locked once the store has parts. Create a new store for a different country.';
  end if;
  return new;
end $$;

drop trigger if exists trg_marketplace_lock on public.stores;
create trigger trg_marketplace_lock
  before update on public.stores
  for each row execute function public.enforce_marketplace_lock();
