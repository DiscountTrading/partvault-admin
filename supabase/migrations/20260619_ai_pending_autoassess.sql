-- Server-side auto-assessment for mobile captures.
-- The mobile app sets parts.ai_pending = true when "Assess with AI" is on; this
-- trigger calls the ai-assess edge function server-side, so the assessment runs
-- reliably even if the phone drops off the network or the app is closed.
--
-- The shared secret lives in Vault (not in code). Create it once with the same
-- value as the ASSESS_TRIGGER_SECRET edge-function secret:
--   select vault.create_secret('<secret>', 'assess_trigger_secret', 'ai-assess trigger auth');

-- 1. Opt-in flag the mobile capture sets.
alter table public.parts add column if not exists ai_pending boolean not null default false;

-- 2. Async HTTP from Postgres.
create extension if not exists pg_net;

-- 3. Trigger function: fire the ai-assess edge function for the new part.
create or replace function public.trigger_ai_assess()
returns trigger
language plpgsql
security definer
set search_path = public, net, vault, extensions
as $$
declare s text;
begin
  select decrypted_secret into s from vault.decrypted_secrets where name = 'assess_trigger_secret' limit 1;
  perform net.http_post(
    url := 'https://mtpektsxaklhedknincs.supabase.co/functions/v1/ai-assess',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object('mode', 'assess', 'partId', new.id, 'triggerSecret', s)
  );
  return new;
end $$;

-- 4. Fire only for captures that opted into AI.
drop trigger if exists parts_ai_assess on public.parts;
create trigger parts_ai_assess
after insert on public.parts
for each row
when (new.ai_pending is true)
execute function public.trigger_ai_assess();
