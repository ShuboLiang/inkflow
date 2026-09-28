-- InkFlow 010: 笔记排序——创建时间 + 手动排序位置
-- created_at：创建时间（回填取 note_versions 最早记录时间，无版本记录的用 updated_at 兜底；此后不可变）
-- position：手动排序位置（回填按 created_at 顺序生成间隔 1000 的序列；之后拖拽取中点插入）
-- 回填行同时 bump version/updated_at：增量拉取守卫是 updated_at > lastSyncAt 且 version 不同，
-- 不 bump 的话存量设备永远拉不到这两列的回填值
-- 语句全部幂等（entrypoint 逐条自动提交，失败会重跑整个文件）：
--   created_at 两段回填都有「值有变化才写」守卫；position 只覆盖空值行，重跑时全非空即空转

alter table public.notes add column if not exists created_at timestamptz not null default now();
alter table public.notes add column if not exists position double precision;

-- created_at 回填（有版本历史的行）：取最早版本时间
update public.notes n
set created_at = v.first_seen
from (
  select note_id, min(created_at) as first_seen
  from public.note_versions
  group by note_id
) v
where n.id = v.note_id
  and n.created_at <> v.first_seen;

-- created_at 回填（无版本历史的行）：加列默认值是迁移运行时刻，晚于真实更新时间才需要兜底
update public.notes n
set created_at = n.updated_at
where n.created_at > n.updated_at
  and not exists (select 1 from public.note_versions v where v.note_id = n.id);

-- position 回填：按 created_at 顺序（旧→新）编号 × 1000，仅覆盖空值行；随行 bump 让设备拉到
with ordered as (
  select id, row_number() over (order by created_at asc, id) as rn
  from public.notes
)
update public.notes n
set position = o.rn * 1000,
    version = n.version + 1,
    updated_at = now()
from ordered o
where n.id = o.id
  and n.position is null;

create index if not exists notes_position_idx on public.notes (position asc);
