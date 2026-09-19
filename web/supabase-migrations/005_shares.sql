-- InkFlow 005: 分享外链（笔记 + PDF，实时最新）
-- shares 表只存映射与撤销状态；内容通过 security definer RPC 按 token 读取，
-- 匿名无 shares/notes/files 表直读权限，攻击面最小。
-- PDF 字节不可变：分享时复制到公共桶 shares（路径 = token），文件名/删除状态实时查 files 表。

create table if not exists public.shares (
  token text primary key,
  user_id uuid not null references auth.users(id),
  kind text not null check (kind in ('note', 'file')),
  note_id uuid references public.notes(id),
  file_id uuid references public.files(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- 一个对象最多一条有效分享（部分唯一索引）
create unique index if not exists shares_one_active_note_idx
  on public.shares (note_id) where note_id is not null and revoked_at is null;
create unique index if not exists shares_one_active_file_idx
  on public.shares (file_id) where file_id is not null and revoked_at is null;

alter table public.shares enable row level security;

create policy "users manage their own shares" on public.shares
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 匿名/登录用户均可按 token 读取当前内容（revoked 或源被删则返回空）
create or replace function public.get_shared_note(p_token text)
returns table (title text, content jsonb)
language sql stable security definer set search_path = public
as $$
  select n.title, n.content
  from public.shares s
  join public.notes n on n.id = s.note_id
  where s.token = p_token
    and s.kind = 'note'
    and s.revoked_at is null
    and n.deleted_at is null
$$;

create or replace function public.get_shared_file(p_token text)
returns table (filename text, mime_type text, size bigint, storage_path text)
language sql stable security definer set search_path = public
as $$
  select f.filename, f.mime_type, f.size, f.storage_path
  from public.shares s
  join public.files f on f.id = s.file_id
  where s.token = p_token
    and s.kind = 'file'
    and s.revoked_at is null
    and f.deleted_at is null
$$;

-- 公共桶：分享出去的 PDF 字节，知道 token 即可读
insert into storage.buckets (id, name, public)
values ('shares', 'shares', true)
on conflict (id) do nothing;
