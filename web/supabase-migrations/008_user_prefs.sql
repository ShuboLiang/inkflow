-- InkFlow 008: 用户偏好（跨设备持久化的小设置，如格式工具栏隐藏状态）
-- 一行一个用户，prefs 为 JSONB，客户端按需读写自己的键，无需后续迁移加列。

create table if not exists public.user_prefs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  prefs jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_prefs enable row level security;

DO $do$ BEGIN IF NOT EXISTS (SELECT FROM pg_policies WHERE policyname = 'users manage their own prefs') THEN
  create policy "users manage their own prefs" on public.user_prefs
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
END IF; END $do$;
