-- InkFlow 011: 统一列表排序
-- 1) notes 的 position 语义统一为「最新在最前」：010 回填按 created_at 升序编号（旧→新），
--    这里按 created_at desc 重排（新→旧 = 1000,2000,…），已手动拖过的位置会被这次语义切换重置一次
-- 2) files 加入排序：加 created_at/position 并回填，笔记与附件合并进同一个列表按 position 排
-- 幂等：notes 重排有「值有变化才写」守卫（迁移只执行一次，重跑仅发生在中断重放场景）；
-- files 的 created_at/position 只回填空值行；files 表没有 version 列，靠 bump updated_at 触发各端重拉

alter table public.files add column if not exists created_at timestamptz not null default now();
alter table public.files add column if not exists position double precision;

-- files created_at 回填：加列默认值是迁移运行时刻，晚于真实更新时间才需要兜底
update public.files f
set created_at = f.updated_at
where f.created_at > f.updated_at;

-- notes：按 created_at desc 重排 position（最新 = 1000 在最前）
with ranked as (
  select id, row_number() over (order by created_at desc, id) as rn
  from public.notes
  where deleted_at is null
)
update public.notes n
set position = r.rn * 1000,
    version = n.version + 1,
    updated_at = now()
from ranked r
where n.id = r.id
  and n.position is distinct from r.rn * 1000;

-- files：按 created_at desc 编号 position（仅覆盖空值行）
with ranked as (
  select id, row_number() over (order by created_at desc, id) as rn
  from public.files
  where deleted_at is null
)
update public.files f
set position = r.rn * 1000,
    updated_at = now()
from ranked r
where f.id = r.id
  and f.position is null;

create index if not exists files_position_idx on public.files (position asc);
