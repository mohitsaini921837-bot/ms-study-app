-- MS Study: fix ms_chat_push_tokens — the token column is missing
-- (the original create ran, but the table exists without it).
-- Add it idempotently; also ensure updated_at exists.
alter table public.ms_chat_push_tokens add column if not exists token text;
alter table public.ms_chat_push_tokens add column if not exists updated_at timestamptz default now();
