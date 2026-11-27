-- MS Study: Mark as Complete (v1.0.14, user order 2026-11-25)
-- One row per (password, item). Keyed by password_hash — NOT device_id —
-- so the green tick survives logout/login AND logging in on another
-- phone with the same password. (One password = one user; the hash is
-- the per-password identity.) RLS on; service_role only (app uses the
-- Edge Function, never direct DB access).
create table if not exists public.ms_completions (
  password_hash text not null,
  item_type text not null check (item_type in ('folder','section','item','test','practice')),
  item_id text not null,
  completed_at timestamptz not null default now(),
  primary key (password_hash, item_type, item_id)
);
alter table public.ms_completions enable row level security;
create index if not exists ms_completions_password_idx on public.ms_completions (password_hash);
