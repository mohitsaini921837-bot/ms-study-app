-- v1.0.15 (2026-11-25): Vidyagram-like test structure + negative marking.
-- Adds category/chapter/total_marks to ms_tests so tests group like
-- Vidyagram (Chapter Test -> category -> chapter -> sets). Also widens
-- ms_attempts.score from int to numeric so negative-marking scores
-- (e.g. 18.5) store exactly.
alter table public.ms_tests add column if not exists category text;
alter table public.ms_tests add column if not exists chapter text;
alter table public.ms_tests add column if not exists total_marks numeric;
alter table public.ms_attempts alter column score type numeric using score::numeric;
