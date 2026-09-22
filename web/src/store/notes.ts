import { db, type Note } from '../lib/db'
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
): Promise<void> {
  const existing = await db.notes.get(id)
  if (!existing) return
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
  // 笔记删除后它的图片不再被引用，清理（其他笔记共用的图会被引用检查保住）
  void removeImagesIfUnreferenced(imagePathsOf(noteImageSrcs(existing.content)))
}
