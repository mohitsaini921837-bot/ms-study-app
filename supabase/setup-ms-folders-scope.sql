-- MS Study: scope folders per screen (notes / practice / classes / tests)
-- A folder created on one screen shows ONLY on that screen.
alter table public.ms_folders add column if not exists scope text;
-- Existing folders: Hindi + REASONING were created while she was on Practice
-- (REASONING holds the "Up constable set 1 blood relation" practice sheet).
-- UPSI is her main exam subject folder -> Notes (best guess; she can say if it belongs elsewhere).
update public.ms_folders set scope = 'practice' where name = 'Hindi';
update public.ms_folders set scope = 'practice' where name = 'REASONING';
update public.ms_folders set scope = 'notes' where name = 'UPSI';
