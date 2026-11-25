-- MS Study — Supabase schema
-- NEW Supabase project (to be created later by the user; the project does
-- not exist yet). Run once in the Supabase SQL Editor.
-- Idempotent: safe to run again. CREATE TABLE IF NOT EXISTS, DROP POLICY
-- IF EXISTS before each CREATE POLICY, and CREATE INDEX IF NOT EXISTS, so
-- re-running changes nothing that already exists.
-- RLS pattern follows ~/workspace/kiara-chat/setup-glm.sql exactly:
-- RLS enabled on every table, permissive anon + authenticated policies
-- for SELECT / INSERT / UPDATE only. No DELETE policy for anon —
-- deletes go through the server with the service-role key only.
-- No password values, keys, or secrets are in this file.

-- ------------------------------------------------------------ ms_passwords
-- Password hashes for the app gate (admin / user roles). The app checks a
-- hash here; the server (/validate) is the authority, this table is storage.
create table if not exists public.ms_passwords (
  id uuid primary key default gen_random_uuid(),
  password_hash text not null unique,
  role text not null check (role in ('admin', 'user')),
  device_id text,
  device_label text,
  active boolean default true,
  -- Device kicked out by a newer login (see server /validate). When a new
  -- device takes over a password, the old device id is recorded here so
  -- its next background revalidation returns "kicked". Last login wins:
  -- a kicked device can log back in by re-entering the password, which
  -- kicks the other device.
  kicked_device_id text,
  created_at timestamptz default now(),
  last_used_at timestamptz
);

alter table public.ms_passwords enable row level security;

drop policy if exists "ms_passwords read" on public.ms_passwords;
create policy "ms_passwords read" on public.ms_passwords
  for select to anon, authenticated using (true);

drop policy if exists "ms_passwords insert" on public.ms_passwords;
create policy "ms_passwords insert" on public.ms_passwords
  for insert to anon, authenticated with check (true);

drop policy if exists "ms_passwords update" on public.ms_passwords;
create policy "ms_passwords update" on public.ms_passwords
  for update to anon, authenticated using (true) with check (true);

grant select, insert, update on public.ms_passwords to anon, authenticated;

-- -------------------------------------------------------------- ms_folders
-- Unlimited nesting via parent_id (folder inside folder inside folder,
-- no depth limit). Top-level folders have parent_id null.
create table if not exists public.ms_folders (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  parent_id uuid references public.ms_folders (id) on delete cascade,
  created_by text,
  created_at timestamptz default now()
);

alter table public.ms_folders enable row level security;

drop policy if exists "ms_folders read" on public.ms_folders;
create policy "ms_folders read" on public.ms_folders
  for select to anon, authenticated using (true);

drop policy if exists "ms_folders insert" on public.ms_folders;
create policy "ms_folders insert" on public.ms_folders
  for insert to anon, authenticated with check (true);

drop policy if exists "ms_folders update" on public.ms_folders;
create policy "ms_folders update" on public.ms_folders
  for update to anon, authenticated using (true) with check (true);

grant select, insert, update on public.ms_folders to anon, authenticated;

-- ------------------------------------------------------------- ms_sections
-- Sections live inside a folder; items (notes/sheets) are uploaded into
-- a section. Deleting a folder deletes its sections.
create table if not exists public.ms_sections (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  folder_id uuid not null references public.ms_folders (id) on delete cascade,
  created_at timestamptz default now()
);

alter table public.ms_sections enable row level security;

drop policy if exists "ms_sections read" on public.ms_sections;
create policy "ms_sections read" on public.ms_sections
  for select to anon, authenticated using (true);

drop policy if exists "ms_sections insert" on public.ms_sections;
create policy "ms_sections insert" on public.ms_sections
  for insert to anon, authenticated with check (true);

drop policy if exists "ms_sections update" on public.ms_sections;
create policy "ms_sections update" on public.ms_sections
  for update to anon, authenticated using (true) with check (true);

grant select, insert, update on public.ms_sections to anon, authenticated;

-- ----------------------------------------------------------------- ms_items
-- Notes, sheets and videos. Files live in Google Drive (15GB account);
-- only the Drive file id / share link is stored here. An item may sit
-- directly in a folder (section_id null) or inside a section.
create table if not exists public.ms_items (
  id uuid primary key default gen_random_uuid(),
  kind text check (kind in ('note', 'sheet', 'video')),
  title text not null,
  folder_id uuid references public.ms_folders (id) on delete set null,
  section_id uuid references public.ms_sections (id) on delete set null,
  drive_file_id text,
  drive_link text,
  created_at timestamptz default now()
);

alter table public.ms_items enable row level security;

drop policy if exists "ms_items read" on public.ms_items;
create policy "ms_items read" on public.ms_items
  for select to anon, authenticated using (true);

drop policy if exists "ms_items insert" on public.ms_items;
create policy "ms_items insert" on public.ms_items
  for insert to anon, authenticated with check (true);

drop policy if exists "ms_items update" on public.ms_items;
create policy "ms_items update" on public.ms_items
  for update to anon, authenticated using (true) with check (true);

grant select, insert, update on public.ms_items to anon, authenticated;

-- ----------------------------------------------------------------- ms_tests
-- Test definitions: from her notes (same questions, changed values),
-- PYQs, mixed notes + target exam, or an uploaded practice sheet.
-- Live schema as of v1.0.21 (2026-11-25): exam/category/chapter split
-- the tests into subjects/chapters; 'practice' kind holds the UPSI
-- Reasoning book sets. NOTE: live ms_tests.id has NO default — upload
-- agents generate the UUID client-side.
create table if not exists public.ms_tests (
  id uuid primary key,
  title text not null,
  kind text check (kind in ('notes', 'pyq', 'mixed', 'sheet', 'practice')),
  source_ref text,
  language text check (language in ('hi', 'en')) default 'hi',
  question_count int,
  duration_min int,
  exam text,
  category text,
  chapter text,
  total_marks int,
  created_by text,
  created_at timestamptz default now()
);

alter table public.ms_tests enable row level security;

drop policy if exists "ms_tests read" on public.ms_tests;
create policy "ms_tests read" on public.ms_tests
  for select to anon, authenticated using (true);

drop policy if exists "ms_tests insert" on public.ms_tests;
create policy "ms_tests insert" on public.ms_tests
  for insert to anon, authenticated with check (true);

drop policy if exists "ms_tests update" on public.ms_tests;
create policy "ms_tests update" on public.ms_tests
  for update to anon, authenticated using (true) with check (true);

grant select, insert, update on public.ms_tests to anon, authenticated;

-- ------------------------------------------------------------- ms_questions
-- One row per question. Every question has 4 options (stored as a JSON
-- array); answer_index is the 0-based index of the correct option.
-- seq orders the questions as on the site (v1.0.19). The three image
-- columns (v1.0.22) hold public question-images bucket URLs, or null
-- for text-only questions; option_image_urls is a 4-entry array with
-- null per text-only option.
create table if not exists public.ms_questions (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references public.ms_tests (id) on delete cascade,
  question text not null,
  options jsonb not null,
  answer_index int not null,
  explanation text,
  seq int,
  question_image_url text,
  option_image_urls jsonb,
  solution_image_url text
);

alter table public.ms_questions enable row level security;

drop policy if exists "ms_questions read" on public.ms_questions;
create policy "ms_questions read" on public.ms_questions
  for select to anon, authenticated using (true);

drop policy if exists "ms_questions insert" on public.ms_questions;
create policy "ms_questions insert" on public.ms_questions
  for insert to anon, authenticated with check (true);

drop policy if exists "ms_questions update" on public.ms_questions;
create policy "ms_questions update" on public.ms_questions
  for update to anon, authenticated using (true) with check (true);

grant select, insert, update on public.ms_questions to anon, authenticated;

-- -------------------------------------------------------------- ms_attempts
-- One row per test attempt, keyed by device (no user accounts in the app).
create table if not exists public.ms_attempts (
  id uuid primary key default gen_random_uuid(),
  test_id uuid references public.ms_tests (id) on delete cascade,
  device_id text,
  score int,
  total int,
  answers jsonb,
  started_at timestamptz default now(),
  finished_at timestamptz
);

alter table public.ms_attempts enable row level security;

drop policy if exists "ms_attempts read" on public.ms_attempts;
create policy "ms_attempts read" on public.ms_attempts
  for select to anon, authenticated using (true);

drop policy if exists "ms_attempts insert" on public.ms_attempts;
create policy "ms_attempts insert" on public.ms_attempts
  for insert to anon, authenticated with check (true);

drop policy if exists "ms_attempts update" on public.ms_attempts;
create policy "ms_attempts update" on public.ms_attempts
  for update to anon, authenticated using (true) with check (true);

grant select, insert, update on public.ms_attempts to anon, authenticated;

-- -------------------------------------------------------------- ms_classes
-- Class videos (e.g. Dheeraj Sir / batch classes). Files live in Google
-- Drive; only the Drive file id / share link is stored here.
create table if not exists public.ms_classes (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  subject text,
  drive_file_id text,
  drive_link text,
  duration text,
  created_at timestamptz default now()
);

alter table public.ms_classes enable row level security;

drop policy if exists "ms_classes read" on public.ms_classes;
create policy "ms_classes read" on public.ms_classes
  for select to anon, authenticated using (true);

drop policy if exists "ms_classes insert" on public.ms_classes;
create policy "ms_classes insert" on public.ms_classes
  for insert to anon, authenticated with check (true);

drop policy if exists "ms_classes update" on public.ms_classes;
create policy "ms_classes update" on public.ms_classes
  for update to anon, authenticated using (true) with check (true);

grant select, insert, update on public.ms_classes to anon, authenticated;

-- ------------------------------------------------------------------ indexes
create index if not exists ms_questions_test_id_idx on public.ms_questions (test_id);
create index if not exists ms_items_folder_id_idx on public.ms_items (folder_id);
create index if not exists ms_items_section_id_idx on public.ms_items (section_id);
create index if not exists ms_sections_folder_id_idx on public.ms_sections (folder_id);
create index if not exists ms_folders_parent_id_idx on public.ms_folders (parent_id);
create index if not exists ms_passwords_device_id_idx on public.ms_passwords (device_id);

-- Service-role grants (added 2026-11-24): the server / Edge Function uses
-- the service_role key and must be able to read/write every ms_* table.
-- The anon/authenticated grants above do NOT cover service_role, so
-- without this the server gets "permission denied for table ms_passwords".
grant select, insert, update, delete on public.ms_passwords, public.ms_folders, public.ms_sections, public.ms_items, public.ms_tests, public.ms_questions, public.ms_attempts, public.ms_classes to service_role;
