-- MS Study: chat read receipts (seen indicator).
-- Each member's last_read_at records when they last opened/read the chat.
-- A message counts as "seen" by the other person when their last_read_at
-- is at or after that message's created_at.
alter table public.ms_chat_presence add column if not exists last_read_at timestamptz;
