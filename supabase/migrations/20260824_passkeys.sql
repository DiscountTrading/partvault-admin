-- ═══════════════════════════════════════════════════════════════════════════
--  Passkeys (WebAuthn) — Face ID / Touch ID as REAL sign-in, not a local lock.
--
--  Until now "Face ID" in the field app was a convenience app-lock: the phone
--  unlocked a session that was already there, and nothing was verified by a
--  server. These tables back a proper passkey: the authenticator signs a
--  server-issued challenge, the edge function verifies the signature against
--  the stored public key, and only then is a session minted (via the same
--  one-time magic-link token the phone-approve flow already uses).
--
--  Both tables are written ONLY by the auth-passkey edge function under the
--  service role. Users may read and delete their own credentials (so the
--  Settings screen can list and remove devices); nobody can insert or update
--  a credential from the client, which would otherwise let an attacker
--  register a key against someone else's account.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.user_passkeys (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  credential_id text not null unique,            -- base64url, as sent by the browser
  public_key    text not null,                   -- base64url COSE key bytes
  counter       bigint not null default 0,       -- signature counter (0 = not supported)
  transports    text[],                          -- 'internal', 'hybrid', …
  device_label  text,                            -- "Paul's iPhone" — user-facing
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

create index if not exists user_passkeys_user_idx on public.user_passkeys(user_id);

alter table public.user_passkeys enable row level security;

drop policy if exists user_passkeys_select_own on public.user_passkeys;
create policy user_passkeys_select_own on public.user_passkeys
  for select using (auth.uid() = user_id);

drop policy if exists user_passkeys_delete_own on public.user_passkeys;
create policy user_passkeys_delete_own on public.user_passkeys
  for delete using (auth.uid() = user_id);

-- Server-issued challenges. A challenge is single-use and short-lived: the
-- verify step deletes the row, so a captured assertion can't be replayed.
create table if not exists public.webauthn_challenges (
  id         uuid primary key default gen_random_uuid(),
  challenge  text not null unique,               -- base64url, 32 random bytes
  kind       text not null check (kind in ('register', 'auth')),
  user_id    uuid references auth.users(id) on delete cascade,  -- register only
  created_at timestamptz not null default now()
);

create index if not exists webauthn_challenges_created_idx on public.webauthn_challenges(created_at);

alter table public.webauthn_challenges enable row level security;
-- No policies: service role only. The client never reads or writes this table.
