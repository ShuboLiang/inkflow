-- InkFlow 002: folders 表补充同步字段（updated_at / deleted_at）并纳入 Realtime
-- 在 Supabase Studio SQL editor 或 psql 中执行（001 之后）

alter table public.folders add column if not exists updated_at timestamptz not null default now();
alter table public.folders add column if not exists deleted_at timestamptz;

create index if not exists folders_updated_at_idx on public.folders (updated_at desc);

alter publication supabase_realtime add table public.folders;
