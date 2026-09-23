-- InkFlow 013: 修复删除外键约束与级联删除
-- 1. shares 表中的 note_id / file_id 改为 ON DELETE CASCADE
--    笔记或文件被物理删除时，分享外链映射自动清理，不再阻断删除操作。
alter table public.shares
  drop constraint if exists shares_note_id_fkey,
  add constraint shares_note_id_fkey
    foreign key (note_id) references public.notes(id) on delete cascade;

alter table public.shares
  drop constraint if exists shares_file_id_fkey,
  add constraint shares_file_id_fkey
    foreign key (file_id) references public.files(id) on delete cascade;

-- 2. files 表关联的 note_id 在笔记物理删除时自动置空（ON DELETE SET NULL），不阻断删除
alter table public.files
  drop constraint if exists files_note_id_fkey,
  add constraint files_note_id_fkey
    foreign key (note_id) references public.notes(id) on delete set null;

-- 3. folders 表关联的 parent_id 在父文件夹物理删除时自动置空，避免阻断
alter table public.folders
  drop constraint if exists folders_parent_id_fkey,
  add constraint folders_parent_id_fkey
    foreign key (parent_id) references public.folders(id) on delete set null;
