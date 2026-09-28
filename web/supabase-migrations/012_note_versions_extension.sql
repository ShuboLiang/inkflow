-- 012_note_versions_extension.sql
-- 扩充 note_versions 表结构，支持标题快照、版本分类（自动/手动命名）、版本名称与字数统计

alter table public.note_versions
  add column if not exists title text not null default '',
  add column if not exists source text not null default 'auto',
  add column if not exists name text,
  add column if not exists char_count bigint not null default 0;

create index if not exists note_versions_note_id_created_idx
  on public.note_versions (note_id, created_at desc);

-- 确保 RLS 启用并允许用户按 note 归属读写自己的版本记录
alter table public.note_versions enable row level security;

DO $do$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE policyname = 'users own versions of their notes') THEN
    create policy "users own versions of their notes" on public.note_versions
      for all using (
        exists (select 1 from public.notes n where n.id = note_id and n.user_id = auth.uid())
      ) with check (
        exists (select 1 from public.notes n where n.id = note_id and n.user_id = auth.uid())
      );
  END IF;
END $do$;
