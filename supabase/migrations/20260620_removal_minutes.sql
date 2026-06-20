-- AI-estimated labour minutes to remove a part from the vehicle. Feeds the
-- part cost basis (removal_minutes / 60 * labour rate). Generic, not exact.
alter table public.parts add column if not exists removal_minutes integer;
