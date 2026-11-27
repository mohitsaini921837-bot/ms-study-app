-- MS Study: no-password completions migration.
--
-- Re-keys ms_completions ("Mark as Complete" ticks) from password_hash to
-- device_id, to match the no-password Edge Function (ms-api), which now
-- upserts with onConflict "device_id,item_type,item_id".
--
-- Run ONCE in the Supabase SQL Editor. Do NOT run from the app.
-- Safe to re-run: every step below is idempotent.
--
-- Known schema (verified against setup-ms-completions.sql and
-- setup-ms-study.sql):
--   ms_completions (password_hash text NOT NULL,
--                   item_type text NOT NULL, item_id text NOT NULL,
--                   completed_at timestamptz,
--                   PRIMARY KEY (password_hash, item_type, item_id))
--   ms_passwords   (password_hash text NOT NULL UNIQUE,
--                   device_id text, role text, active boolean, ...)
--
-- Known live state at write time (2026-11-27): ms_passwords holds ONLY
-- the admin row (password_hash a2e200d9, device_id
-- ms-c5e9ae52-e829-4835-abd5-38fcd89168e7). The user row is gone, so that
-- user's completion rows are deleted by step (c) below — intended.
-- The password_hash column is NOT dropped (kept as dead data) and the
-- old primary key is left in place.

-- (a) Add the device_id column (nullable first, so existing rows survive).
alter table public.ms_completions
  add column if not exists device_id text;

-- (b) Backfill device_id from the matching ms_passwords row.
-- password_hash is UNIQUE in ms_passwords, so each completion row maps
-- to at most one device. Only rows not yet backfilled are touched.
update public.ms_completions c
  set device_id = p.device_id
  from public.ms_passwords p
  where c.device_id is null
    and c.password_hash = p.password_hash
    and p.device_id is not null;

-- (c) Delete orphan completion rows: any row whose password_hash matches
-- NO ms_passwords row (owner gone — e.g. the deleted user row), plus any
-- row that still has no device_id after the backfill (its password row
-- never had a device bound). Both kinds have no device to belong to
-- under the no-password model.
delete from public.ms_completions c
  where c.device_id is null
     or not exists (
       select 1 from public.ms_passwords p
        where p.password_hash = c.password_hash
     );

-- (d) Make device_id NOT NULL and add the unique index the server's
-- upsert needs: onConflict "device_id,item_type,item_id" requires a
-- unique index on exactly those columns.
alter table public.ms_completions
  alter column device_id set not null;

create unique index if not exists ms_completions_device_id_idx
  on public.ms_completions (device_id, item_type, item_id);

-- (e) Allow 'test' and 'practice' item_type values in the live check
-- constraint. The live table was created from the v1.0.14 setup file,
-- whose check only allowed ('folder','section','item'); the v1.0.23 app
-- marks test/practice cards complete with item_type 'test'/'practice'.
-- This drops whatever item_type check exists (looked up by name, so it
-- is safe to re-run) and adds the full one.
do $$
declare
  cname text;
begin
  select conname into cname
    from pg_constraint
   where conrelid = 'public.ms_completions'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) like '%item_type%';
  if cname is not null then
    execute 'alter table public.ms_completions drop constraint ' || quote_ident(cname);
  end if;
end $$;

alter table public.ms_completions
  add constraint ms_completions_item_type_check
  check (item_type in ('folder','section','item','test','practice'));

-- Verification (run separately after the migration, or uncomment):
--   select count(*) as total_rows,
--          count(*) filter (where device_id is null) as null_device_rows
--     from public.ms_completions;
--   select device_id, count(*) as ticks
--     from public.ms_completions
--    group by device_id;
-- Expected: null_device_rows = 0, and one group per surviving device
-- (the admin device ms-c5e9ae52-e829-4835-abd5-38fcd89168e7 if its ticks
-- existed; the deleted user's ticks are gone).
