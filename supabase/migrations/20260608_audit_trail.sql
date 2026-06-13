-- ============================================================================
-- Audit trail: who did what, when. Populated by database triggers so it can't
-- be bypassed or forgotten by application code. Captures auth.uid() (the acting
-- user) on every cars/parts/store_members change. Soft-deletes (deleted_at) and
-- restores are recorded as their real intent, not as generic updates.
--
-- Visible to users with the manage_users capability (and owners). Rows are never
-- updated/deleted by app code — append-only.
-- ============================================================================

begin;

create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  store_id    uuid not null references public.stores(id) on delete cascade,
  user_id     uuid references auth.users(id),
  action      text not null,        -- insert | update | delete | restore | member_added | member_removed | member_updated
  entity_type text not null,        -- cars | parts | member
  entity_id   uuid,
  summary     text,
  created_at  timestamptz not null default now()
);

create index if not exists audit_log_store_time on public.audit_log (store_id, created_at desc);

alter table public.audit_log enable row level security;

drop policy if exists audit_log_select on public.audit_log;
create policy audit_log_select on public.audit_log
  for select using (public.has_permission(store_id, 'manage_users'));
-- No insert/update/delete policies: only the SECURITY DEFINER triggers write here.

-- ---------------------------------------------------------------------------
-- Trigger: cars & parts
-- ---------------------------------------------------------------------------
create or replace function public.audit_cars_parts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid; v_id uuid; v_action text; v_summary text;
begin
  if TG_OP = 'DELETE' then
    v_store := OLD.store_id; v_id := OLD.id; v_action := 'delete';
  else
    v_store := NEW.store_id; v_id := NEW.id; v_action := lower(TG_OP);
  end if;

  if TG_OP = 'UPDATE' then
    if NEW.deleted_at is not null and OLD.deleted_at is null then v_action := 'delete';
    elsif NEW.deleted_at is null and OLD.deleted_at is not null then v_action := 'restore';
    end if;
  end if;

  if TG_TABLE_NAME = 'cars' then
    v_summary := 'car ' || coalesce((case when TG_OP='DELETE' then OLD.make else NEW.make end), '')
              || ' ' || coalesce((case when TG_OP='DELETE' then OLD.model else NEW.model end), '');
  else
    v_summary := 'part ' || coalesce((case when TG_OP='DELETE' then OLD.title else NEW.title end), '');
    if TG_OP = 'UPDATE' and NEW.status is distinct from OLD.status then
      v_summary := v_summary || ' (' || coalesce(OLD.status,'') || ' → ' || coalesce(NEW.status,'') || ')';
    end if;
  end if;

  insert into public.audit_log (store_id, user_id, action, entity_type, entity_id, summary)
  values (v_store, auth.uid(), v_action, TG_TABLE_NAME, v_id, v_summary);
  return null;
end;
$$;

drop trigger if exists trg_audit_parts on public.parts;
create trigger trg_audit_parts after insert or update or delete on public.parts
  for each row execute function public.audit_cars_parts();

drop trigger if exists trg_audit_cars on public.cars;
create trigger trg_audit_cars after insert or update or delete on public.cars
  for each row execute function public.audit_cars_parts();

-- ---------------------------------------------------------------------------
-- Trigger: store_members (access changes)
-- ---------------------------------------------------------------------------
create or replace function public.audit_members()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid; v_user uuid; v_action text; v_summary text;
begin
  if TG_OP = 'DELETE' then
    v_store := OLD.store_id; v_user := OLD.user_id; v_action := 'member_removed'; v_summary := 'Removed a member';
  elsif TG_OP = 'INSERT' then
    v_store := NEW.store_id; v_user := NEW.user_id; v_action := 'member_added'; v_summary := 'Added a member (' || NEW.role || ')';
  else
    v_store := NEW.store_id; v_user := NEW.user_id; v_action := 'member_updated'; v_summary := 'Updated member access';
  end if;

  insert into public.audit_log (store_id, user_id, action, entity_type, entity_id, summary)
  values (v_store, auth.uid(), v_action, 'member', v_user, v_summary);
  return null;
end;
$$;

drop trigger if exists trg_audit_members on public.store_members;
create trigger trg_audit_members after insert or update or delete on public.store_members
  for each row execute function public.audit_members();

-- ---------------------------------------------------------------------------
-- Read RPC for the Activity view (joins the actor's email; manage_users only)
-- ---------------------------------------------------------------------------
create or replace function public.get_audit_log(p_store_id uuid, p_limit int default 200)
returns table (id bigint, created_at timestamptz, user_email text, action text, entity_type text, summary text)
language sql security definer stable set search_path = public
as $$
  select a.id, a.created_at, u.email, a.action, a.entity_type, a.summary
  from public.audit_log a
  left join auth.users u on u.id = a.user_id
  where a.store_id = p_store_id
    and public.has_permission(p_store_id, 'manage_users')
  order by a.created_at desc
  limit greatest(1, least(p_limit, 1000));
$$;

grant execute on function public.get_audit_log(uuid, int) to authenticated;

commit;
