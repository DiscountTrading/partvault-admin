-- ============================================================================
--  SECURITY (corruption) — stop any signed-up user from deleting or overwriting
--  ANOTHER store's photos.
--
--  storage.objects carried two sets of policies at once. The scoped set checks
--  the folder against the caller's store; the older loose set checks only
--  `auth.uid() IS NOT NULL`. Postgres OR's permissive policies together, so the
--  loosest one wins and the scoped ones were decorative:
--
--    "Store members can manage their photos"  DELETE  auth.uid() IS NOT NULL
--    "Store members can upload photos"        INSERT  auth.uid() IS NOT NULL
--    "Store members can access their CSVs"    SELECT  auth.uid() IS NOT NULL
--    "Store members can upload CSVs"          INSERT  auth.uid() IS NOT NULL
--
--  Effect: anyone who signed up — and signup is open with email auto-confirm,
--  so that is anyone at all — could delete every object in part-photos (532 at
--  the time of writing) or write into any store's folder. Photos are not in the
--  database backup, so a mass delete is unrecoverable.
--
--  WHY THE SCOPED POLICIES COULD NOT SIMPLY BE LEFT TO DO THE JOB: they resolve
--  the store as (storage.foldername(name))[1] and compare it to profiles.store_id.
--  Both halves are wrong for this codebase:
--    1. Paths are not all one shape. Live counts by first folder:
--         <storeId>/…            476 objects   (field app: AddPart.jsx:85, Home.jsx:66)
--         car-photos/<storeId>/…  56 objects   (admin: inventoryShared.jsx:225)
--         marketing/<storeId>/…                (admin: Settings.jsx:673)
--       So [1] is a literal prefix, not a store id, for the admin uploads.
--    2. profiles.store_id is a single-store field in a multi-store product; the
--       owner belongs to two stores via store_members but has one profile row.
--  Scoping on that basis would have blocked legitimate uploads — which is very
--  likely why the loose policies were added on top in the first place.
--
--  This migration replaces BOTH sets with one correct rule per operation, using
--  a helper that finds the store id wherever it sits in the path and checks it
--  against store_members (the same membership source the rest of the schema
--  uses).
--
--  PUBLIC READ IS DELIBERATELY LEFT ALONE. part-photos is a public bucket and
--  both apps persist getPublicUrl() results as the stored photo URL
--  (inventoryShared.jsx:228, AddPart.jsx:90, Home.jsx:69, Settings.jsx:676);
--  eBay also fetches listing images from those URLs. Making the bucket private
--  would break every stored URL and every live listing image, so that is a
--  product decision, not a migration. Flagged separately.
--
--  Idempotent: drop policy if exists / create policy after a drop.
-- ============================================================================

-- Find the store id in a storage path, whatever shape the path takes:
-- '<uuid>/file.jpg' -> the uuid; 'car-photos/<uuid>/file.jpg' -> the uuid.
-- Returns NULL when there is no uuid segment, and is_store_member(NULL) is
-- false, so an unrecognised path is denied rather than erroring.
create or replace function public.storage_store_id(p_name text)
returns uuid
language sql
immutable
as $$
  select (
    select seg::uuid
      from unnest(storage.foldername(p_name)) as seg
     where seg ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     limit 1
  );
$$;

-- ── part-photos ────────────────────────────────────────────────────────────
drop policy if exists "Store members can manage their photos" on storage.objects;
drop policy if exists "Store members can upload photos"       on storage.objects;
drop policy if exists "store_members_read_photos"             on storage.objects;
drop policy if exists "store_members_upload_photos"           on storage.objects;
drop policy if exists "store_admins_delete_photos"            on storage.objects;

drop policy if exists pv_photos_read   on storage.objects;
drop policy if exists pv_photos_insert on storage.objects;
drop policy if exists pv_photos_update on storage.objects;
drop policy if exists pv_photos_delete on storage.objects;

-- Signed-in members read their own store's objects through the authenticated
-- path. (Anonymous reads still work via the public-bucket URL — see the note
-- above; this policy governs the RLS path only.)
create policy pv_photos_read on storage.objects for select to authenticated
  using (bucket_id = 'part-photos' and public.is_store_member(public.storage_store_id(name)));

create policy pv_photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'part-photos' and public.is_store_member(public.storage_store_id(name)));

create policy pv_photos_update on storage.objects for update to authenticated
  using      (bucket_id = 'part-photos' and public.is_store_member(public.storage_store_id(name)))
  with check (bucket_id = 'part-photos' and public.is_store_member(public.storage_store_id(name)));

create policy pv_photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'part-photos' and public.is_store_member(public.storage_store_id(name)));

-- ── part-csvs ──────────────────────────────────────────────────────────────
-- No app code references this bucket (grep across both apps and all edge
-- functions returns nothing) and it holds 0 objects, so it goes to service-role
-- only: dropping the loose policies leaves no client policy, which is deny-all.
drop policy if exists "Store members can access their CSVs" on storage.objects;
drop policy if exists "Store members can upload CSVs"       on storage.objects;

-- Verify:
--   select polname, polcmd, pg_get_expr(polqual, polrelid)
--     from pg_policy where polrelid = 'storage.objects'::regclass order by polname;
-- Expect: the four pv_photos_* policies plus "Photos are publicly readable".
