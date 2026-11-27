-- MS Study: store full result detail per test attempt (per user/device).
-- Each attempt is already keyed by device_id (one password = one device),
-- so one user's attempts never show to another user.
alter table public.ms_attempts add column if not exists time_taken_sec int;
alter table public.ms_attempts add column if not exists correct_count int;
alter table public.ms_attempts add column if not exists wrong_count int;
alter table public.ms_attempts add column if not exists unattempted_count int;
