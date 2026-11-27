-- MS Study hidden-chat push tokens (v1.0.10, FCM).
-- One FCM device token per (room, device). Run once in the Supabase
-- SQL editor (project byulsopangzovpwywgzf) BEFORE deploying the
-- updated ms-api Edge Function, or the /chat/join push-token upsert
-- and the /chat/send push lookup will fail (the message send itself
-- still succeeds — push errors are logged, never fatal).
-- The Edge Function needs these secrets too (set via CLI, see the
-- v1.0.10 handover notes): FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL,
-- FIREBASE_PRIVATE_KEY (or FIREBASE_SERVICE_ACCOUNT_JSON).

create table if not exists public.ms_chat_push_tokens (
  room_id text not null references public.ms_chat_rooms (id) on delete cascade,
  device_id text not null,
  token text not null,
  updated_at timestamptz default now(),
  primary key (room_id, device_id)
);

alter table public.ms_chat_push_tokens enable row level security;

-- No anon/authenticated access: only the Edge Function (service_role)
-- touches this table, same as the other ms_chat_* tables.
grant select, insert, update, delete on public.ms_chat_push_tokens to service_role;
