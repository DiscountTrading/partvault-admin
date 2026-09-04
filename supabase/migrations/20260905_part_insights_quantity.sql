-- ============================================================================
-- part_insights learns about multi-quantity stock lines (v3.39.0).
--
-- Since v3.39.0 a part row can be a STOCK LINE: `quantity` units acquired,
-- `quantity_sold` gone, and on a multi-unit line `sold_price` is the PER-UNIT
-- price (line totals live in ebay_sales). This view still valued such a line
-- as one unit: a closed 10-unit line showed one unit of revenue against the
-- whole lot's cost, and an open one showed the full lot cost against one
-- unit's asking price.
--
-- Changes, all guarded by `coalesce(p.quantity,1) > 1` so every quantity-1
-- row (the entire current dataset) keeps the EXACT existing expressions:
--   • realized_profit / sold margin: units × per-unit price, lot cost once
--   • potential_profit / unsold margin: remaining units at asking price
--     against the remaining share of the lot cost (per-unit margin)
--   • quantity / quantity_sold appended as columns (new columns must come
--     last for CREATE OR REPLACE VIEW)
--
-- ⚠ The body below is the LIVE definition read back with pg_get_viewdef on
-- 2026-09-05, edited only where marked with "-- multi-quantity". Do not
-- regenerate it from older migrations.
--
-- Idempotent (CREATE OR REPLACE, column list only appended). Apply via the
-- Supabase SQL editor or the management API.
-- ============================================================================

create or replace view public.part_insights as
 SELECT p.id AS part_id,
    p.store_id,
    p.sku,
    p.title,
    p.make,
    p.model,
    p.year,
    p.status,
    p.list_price,
    p.sold_price,
    p.shipping_charged,
    p.acquired_date,
    p.created_at,
    p.sold_date,
    p.market_price,
    p.market_count,
    p.market_checked_at,
        CASE
            WHEN p.market_price > 0::numeric AND p.list_price > 0::numeric THEN round((p.list_price - p.market_price) / p.market_price * 100::numeric, 1)
            ELSE NULL::numeric
        END AS price_variance_pct,
    c.total_cost,
    COALESCE(li.listing_count, 0::bigint) AS listing_count,
    li.first_listed_at,
    COALESCE(li.total_days_listed, 0::numeric)::integer AS total_days_listed,
        CASE
            WHEN COALESCE(p.sold_date::timestamp with time zone, now()) >= LEAST(p.acquired_date::timestamp with time zone, li.first_listed_at, p.created_at) THEN floor(EXTRACT(epoch FROM COALESCE(p.sold_date::timestamp with time zone, now()) - LEAST(p.acquired_date::timestamp with time zone, li.first_listed_at, p.created_at)) / 86400::numeric)::integer
            ELSE NULL::integer
        END AS days_on_shelf,
        CASE
            WHEN p.status = 'sold'::text AND p.sold_date IS NOT NULL AND p.sold_date::timestamp with time zone >= LEAST(p.acquired_date::timestamp with time zone, li.first_listed_at, p.created_at) THEN floor(EXTRACT(epoch FROM p.sold_date::timestamp with time zone - LEAST(p.acquired_date::timestamp with time zone, li.first_listed_at, p.created_at)) / 86400::numeric)::integer
            ELSE NULL::integer
        END AS days_to_sell,
        CASE
            WHEN p.acquired_date IS NOT NULL AND (li.first_listed_at IS NULL OR p.acquired_date::timestamp with time zone <= li.first_listed_at) THEN 'acquired'::text
            WHEN li.first_listed_at IS NOT NULL THEN 'listed'::text
            ELSE 'created'::text
        END AS date_source,
    p.acquired_date IS NOT NULL OR li.first_listed_at IS NOT NULL AS date_reliable,
        CASE
            -- multi-quantity: units × per-unit price, the lot's cost once
            WHEN p.status = 'sold'::text AND COALESCE(p.quantity, 1) > 1 THEN GREATEST(COALESCE(p.quantity_sold, 0), 1)::numeric * p.sold_price + COALESCE(p.shipping_charged, 0::numeric) - c.total_cost
            WHEN p.status = 'sold'::text THEN p.sold_price + COALESCE(p.shipping_charged, 0::numeric) - c.total_cost
            ELSE NULL::numeric
        END AS realized_profit,
        CASE
            -- multi-quantity: remaining units at asking price, against the
            -- remaining share of the lot cost
            WHEN p.status <> 'sold'::text AND COALESCE(p.quantity, 1) > 1 THEN (COALESCE(p.quantity, 1) - LEAST(COALESCE(p.quantity_sold, 0), COALESCE(p.quantity, 1)))::numeric * p.list_price - c.total_cost * (COALESCE(p.quantity, 1) - LEAST(COALESCE(p.quantity_sold, 0), COALESCE(p.quantity, 1)))::numeric / COALESCE(p.quantity, 1)::numeric
            WHEN p.status <> 'sold'::text THEN p.list_price - c.total_cost
            ELSE NULL::numeric
        END AS potential_profit,
        CASE
            -- multi-quantity sold: same ratio, in units
            WHEN p.status = 'sold'::text AND COALESCE(p.quantity, 1) > 1 AND (GREATEST(COALESCE(p.quantity_sold, 0), 1)::numeric * p.sold_price + COALESCE(p.shipping_charged, 0::numeric)) > 0::numeric THEN round((GREATEST(COALESCE(p.quantity_sold, 0), 1)::numeric * p.sold_price + COALESCE(p.shipping_charged, 0::numeric) - c.total_cost) / (GREATEST(COALESCE(p.quantity_sold, 0), 1)::numeric * p.sold_price + COALESCE(p.shipping_charged, 0::numeric)) * 100::numeric, 1)
            WHEN p.status = 'sold'::text AND (p.sold_price + COALESCE(p.shipping_charged, 0::numeric)) > 0::numeric THEN round((p.sold_price + COALESCE(p.shipping_charged, 0::numeric) - c.total_cost) / (p.sold_price + COALESCE(p.shipping_charged, 0::numeric)) * 100::numeric, 1)
            -- multi-quantity unsold: per-unit margin (lot cost / units)
            WHEN p.status <> 'sold'::text AND COALESCE(p.quantity, 1) > 1 AND p.list_price > 0::numeric THEN round((p.list_price - c.total_cost / COALESCE(p.quantity, 1)::numeric) / p.list_price * 100::numeric, 1)
            WHEN p.status <> 'sold'::text AND p.list_price > 0::numeric THEN round((p.list_price - c.total_cost) / p.list_price * 100::numeric, 1)
            ELSE NULL::numeric
        END AS margin_pct,
    COALESCE(p.quantity, 1) AS quantity,
    COALESCE(p.quantity_sold, 0) AS quantity_sold
   FROM parts p
     CROSS JOIN LATERAL ( SELECT COALESCE(sum(jsonb_each_text.value::numeric), 0::numeric) AS total_cost
           FROM jsonb_each_text(COALESCE(p.costs, '{}'::jsonb)) jsonb_each_text(key, value)
          WHERE jsonb_each_text.value ~ '^-?[0-9.]+$'::text) c
     LEFT JOIN LATERAL ( SELECT count(*) AS listing_count,
            min(l.listed_at) AS first_listed_at,
            sum(EXTRACT(epoch FROM COALESCE(l.sold_at, l.ended_at, now()) - l.listed_at) / 86400::numeric) AS total_days_listed
           FROM listings l
          WHERE l.part_id = p.id AND l.listed_at IS NOT NULL) li ON true
  WHERE p.deleted_at IS NULL;
