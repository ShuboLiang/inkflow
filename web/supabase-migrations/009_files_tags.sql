-- InkFlow 009: 文件（PDF/HTML）支持标签
-- 与 notes.tags 同款内嵌 JSONB 数组，同步/改名/删除逻辑一致。

alter table public.files add column if not exists tags jsonb not null default '[]';
