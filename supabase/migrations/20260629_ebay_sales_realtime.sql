-- Let the admin app auto-refresh after a sync / fee backfill writes sales, instead
-- of needing a manual reload. useSales already subscribes to ebay_sales changes; it
-- just needs the table in Supabase's realtime publication.
-- (Safe/idempotent: only adds if not already a member.)

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'ebay_sales'
  ) then
    alter publication supabase_realtime add table public.ebay_sales;
  end if;
end $$;
