-- MS Study: tests are per-user. Each user sees only the tests THEY created;
-- no one's test ever shows on another user's ID.
alter table public.ms_tests add column if not exists created_by text;
-- The existing "Upsi reasoning" test was created by Kiara (admin device).
update public.ms_tests set created_by = 'ms-26565c39-2814-4940-a609-9131c242a4e9' where created_by is null;
