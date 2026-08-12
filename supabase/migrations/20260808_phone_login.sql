-- "Sign in with your phone": the computer creates a login request and shows a
-- QR + code; the signed-in (Face-ID-gated) phone app approves it; the computer
-- polls and receives a one-time magic-link token to mint its own session.
-- The table is service-role only — clients only touch it through the edge
-- function, which enforces expiry and single use. Idempotent.

create table if not exists public.login_requests (
  id          uuid primary key default gen_random_uuid(),  -- polling secret (QR/desktop only)
  code        text not null unique,                        -- human code, also the manual-entry lookup
  status      text not null default 'pending',             -- pending | approved | claimed | cancelled
  user_id     uuid,
  token_hash  text,                                        -- one-time magiclink hash, cleared on claim
  created_at  timestamptz not null default now(),
  approved_at timestamptz
);

alter table public.login_requests enable row level security;
-- no policies: anon/authenticated get nothing directly; only service role reads it.

-- Housekeeping: requests are worthless after minutes — prune on each create via
-- the edge fn, so no cron needed.
create index if not exists login_requests_created_idx on public.login_requests (created_at);
