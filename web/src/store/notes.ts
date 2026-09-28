import { db, type Note } from '../lib/db'
import { supabase } from '../lib/supabase'
import { imagePathsOf, noteImageSrcs, removeImagesIfUnreferenced } from './images'

export async function listNotes(): Promise<Note[]> {
  const all = await db.notes.toArray()
  return all.filter((n) => n.deletedAt === null)
}

export async function createNote(
  title = '',
  folderId: string | null = null,
  content: unknown = { type: 'doc', content: [] },
): Promise<Note> {
  // 新建排最前：position 取全列表（笔记+文件共用数轴）当前最小值再往前挪一格
  const [noteRows, fileRows] = await Promise.all([
    db.notes.filter((n) => n.deletedAt === null && n.position !== null).toArray(),
    db.files.filter((f) => f.deletedAt === null && f.position !== null).toArray(),
  ])
  const positions = [...noteRows, ...fileRows].map((r) => r.position as number)
  const minPos = positions.length ? Math.min(...positions) : 0
  const now = Date.now()
  const note: Note = {
    id: crypto.randomUUID(),
    title,
    content,
    folderId,
    tags: [],
    version: 1,
    dirty: 1,
    updatedAt: now,
    syncedAt: null,
    deletedAt: null,
    createdAt: now,
    position: minPos - 1000,
  }
  await db.notes.add(note)
  return note
}

export async function updateNote(
  id: string,
  patch: Partial<Pick<Note, 'title' | 'content' | 'folderId' | 'tags' | 'position'>>,
): Promise<boolean> {
  const existing = await db.notes.get(id)
  if (!existing) return false

  // 高性能轻量比对：只有在实质内容或属性发生真实变化时才写 DB 并更新 updatedAt
  let hasChange = false
  if (patch.title !== undefined && patch.title !== existing.title) hasChange = true
  else if (patch.folderId !== undefined && patch.folderId !== existing.folderId) hasChange = true
  else if (patch.position !== undefined && patch.position !== existing.position) hasChange = true
  else if (patch.tags !== undefined) {
    if ((patch.tags ?? []).length !== (existing.tags ?? []).length) hasChange = true
    else if (JSON.stringify(patch.tags) !== JSON.stringify(existing.tags)) hasChange = true
  }
  else if (patch.content !== undefined) {
    if (patch.content !== existing.content) {
      if (JSON.stringify(patch.content) !== JSON.stringify(existing.content)) {
        hasChange = true
      }
    }
  }

  if (!hasChange) return false

  await db.notes.update(id, {
    ...patch,
    version: existing.version + 1,
    dirty: 1,
    updatedAt: Date.now(),
  })
  // 内容变更后 diff 图片引用：被移除且全库无其他引用的图，从 Storage 和本地缓存删除
  if (patch.content !== undefined && existing.deletedAt === null) {
    const before = new Set(imagePathsOf(noteImageSrcs(existing.content)))
    const after = new Set(imagePathsOf(noteImageSrcs(patch.content)))
    const removed = [...before].filter((p) => !after.has(p))
    if (removed.length) void removeImagesIfUnreferenced(removed)
  }
  return true
}

export async function softDeleteNote(id: string): Promise<void> {
  const existing = await db.notes.get(id)
  if (!existing) return
  await db.notes.update(id, {
    deletedAt: Date.now(),
    version: existing.version + 1,
    dirty: 1,
    updatedAt: Date.now(),
  })
}

// 从回收站恢复笔记
export async function restoreNote(id: string): Promise<void> {
  const existing = await db.notes.get(id)
  if (!existing) return
  let folderId = existing.folderId
  if (folderId) {
    const f = await db.folders.get(folderId)
    if (!f || f.deletedAt) folderId = null
  }
  await db.notes.update(id, {
    deletedAt: null,
    folderId,
    version: existing.version + 1,
    dirty: 1,
    updatedAt: Date.now(),
  })
}

// 从回收站永久删除笔记（物理清理本地、云端及图片）
export async function permanentlyDeleteNote(id: string): Promise<void> {
  const existing = await db.notes.get(id)
  if (existing) {
    void removeImagesIfUnreferenced(imagePathsOf(noteImageSrcs(existing.content)))
  }
  await db.notes.delete(id)
  const { error } = await supabase.from('notes').delete().eq('id', id)
  if (error) console.error('permanently delete note from server failed', error)
}
