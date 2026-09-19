-- InkFlow 003: 标签内嵌进 notes 行（jsonb 数组），跟随笔记 LWW 同步
-- tags / note_tags 正规化表保留但未启用（关联表同步成本高于收益，个人笔记规模下内嵌足够）

alter table public.notes add column if not exists tags jsonb not null default '[]';
