-- Sample (demo) data support — new stores can be seeded with clearly-flagged
-- example inventory so a first-time user sees a working system before entering
-- any real data. Every seeded row carries is_sample=true so the whole set can
-- be identified at a glance and deleted in one pass at any time.
-- Idempotent: safe to re-run.

alter table public.parts      add column if not exists is_sample boolean not null default false;
alter table public.cars       add column if not exists is_sample boolean not null default false;
alter table public.listings   add column if not exists is_sample boolean not null default false;
alter table public.ebay_sales add column if not exists is_sample boolean not null default false;
