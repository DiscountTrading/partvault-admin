-- Bulk-apply the historical cost MODEL to every imported sale in one statement.
--
-- The model has value-scaling rates (% of sale: purchase, eBay listing, promotion)
-- and fixed flats ($/item: postage, storage, admin, labour). Each CSV row's cost is
-- price-dependent, so we compute per row from sold_price here rather than writing the
-- same blob to every row. Called by the ebay-import edge function (service role).

create or replace function public.apply_historical_costs(
  p_store        uuid,
  p_purchase_pct numeric,
  p_listing_pct  numeric,
  p_promo_pct    numeric,
  p_postage      numeric,
  p_storage      numeric,
  p_admin        numeric,
  p_labour       numeric
) returns integer
language sql security definer set search_path = public as $$
  with upd as (
    update public.ebay_sales set
      costs = jsonb_build_object(
        'purchase',     round((coalesce(sold_price, 0) * p_purchase_pct)::numeric, 2),
        'ebay_listing', round((coalesce(sold_price, 0) * p_listing_pct)::numeric, 2),
        'promotion',    round((coalesce(sold_price, 0) * p_promo_pct)::numeric, 2),
        'postage',      round(p_postage::numeric, 2),
        'storage',      round(p_storage::numeric, 2),
        'admin',        round(p_admin::numeric, 2),
        'labour',       round(p_labour::numeric, 2)
      ),
      updated_at = now()
    where store_id = p_store and source = 'csv_orders_report'
    returning 1
  )
  select count(*)::int from upd;
$$;

revoke all on function public.apply_historical_costs(uuid,numeric,numeric,numeric,numeric,numeric,numeric,numeric) from public;
grant execute on function public.apply_historical_costs(uuid,numeric,numeric,numeric,numeric,numeric,numeric,numeric) to service_role;
