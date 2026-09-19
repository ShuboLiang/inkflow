-- InkFlow 004: 文件（PDF 等二进制）上云同步
-- 元数据走 public.files 表 LWW 同步；二进制内容走 Supabase Storage 私有桶 files，
-- 对象路径约定 {user_id}/{file_id}，靠 storage.objects RLS 限定只能访问自己前缀。

alter table public.files add column if not exists folder_id uuid;
alter table public.files add column if not exists updated_at timestamptz not null default now();
alter table public.files add column if not exists deleted_at timestamptz;

create index if not exists files_updated_at_idx on public.files (updated_at desc);

DO $do$ BEGIN IF NOT EXISTS (SELECT FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'files') THEN
  alter publication supabase_realtime add table public.files;
END IF; END $do$;

-- 私有桶：pdf 等文件对象
insert into storage.buckets (id, name, public)
values ('files', 'files', false)
on conflict (id) do nothing;

-- 用户只能读写自己前缀下的对象（(storage.foldername(name))[1] = user_id）
DO $do$ BEGIN IF NOT EXISTS (SELECT FROM pg_policies WHERE policyname = 'users manage their own file objects') THEN
  create policy "users manage their own file objects" on storage.objects
    for all using (
      bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text
    ) with check (
      bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text
    );
END IF; END $do$;
