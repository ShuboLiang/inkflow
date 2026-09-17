-- InkFlow initial schema
-- Run this in Supabase Studio SQL editor (http://localhost:8000) after starting the stack.

create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  title text not null default '',
  content jsonb not null default '{}',
  folder_id uuid,
  version bigint not null default 1,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.note_versions (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references public.notes(id) on delete cascade,
  content jsonb not null default '{}',
  version bigint not null,
  created_at timestamptz not null default now()
);

create table if not exists public.folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  name text not null,
  parent_id uuid references public.folders(id)
);

create table if not exists public.tags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  name text not null
);

create table if not exists public.note_tags (
  note_id uuid not null references public.notes(id) on delete cascade,
  tag_id uuid not null references public.tags(id) on delete cascade,
  primary key (note_id, tag_id)
);

create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  note_id uuid references public.notes(id),
  filename text not null default '',
  mime_type text,
  size bigint,
  storage_path text
);

create index if not exists notes_updated_at_idx on public.notes (updated_at desc);
create index if not exists notes_user_deleted_idx on public.notes (user_id, deleted_at);

alter table public.notes enable row level security;
alter table public.note_versions enable row level security;
alter table public.folders enable row level security;
alter table public.tags enable row level security;
alter table public.note_tags enable row level security;
alter table public.files enable row level security;

create policy "users own their notes" on public.notes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "users own versions of their notes" on public.note_versions
  for all using (
    exists (select 1 from public.notes n where n.id = note_id and n.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.notes n where n.id = note_id and n.user_id = auth.uid())
  );

create policy "users own their folders" on public.folders
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "users own their tags" on public.tags
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "users own note_tags of their notes" on public.note_tags
  for all using (
    exists (select 1 from public.notes n where n.id = note_id and n.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.notes n where n.id = note_id and n.user_id = auth.uid())
  );

create policy "users own their files" on public.files
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
