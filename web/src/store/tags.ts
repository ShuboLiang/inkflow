import { db } from '../lib/db'

// 标签内嵌在行上（notes.tags 与 files.tags，同一命名空间），没有独立的标签实体：
// 标签列表是全部笔记+文件 tags 的聚合，改名/删除 = 批量重写相关行（各自 bump version/updatedAt 走同步）。

export async function renameTag(oldName: string, newName: string): Promise<number> {
  const notes = await db.notes.filter((n) => n.deletedAt === null && (n.tags ?? []).includes(oldName)).toArray()
  let changed = 0
  for (const note of notes) {
    const tags = (note.tags ?? [])
      .map((t) => (t === oldName ? newName : t))
      .filter((t, i, arr) => arr.findIndex((x) => x.toLowerCase() === t.toLowerCase()) === i)
    await db.notes.update(note.id, {
      tags,
      version: note.version + 1,
      dirty: 1,
      updatedAt: Date.now(),
    })
    changed++
  }
  // 文件没有 version 列，LWW 只看 updated_at
  const files = await db.files.filter((f) => f.deletedAt === null && (f.tags ?? []).includes(oldName)).toArray()
  for (const file of files) {
    const tags = (file.tags ?? [])
      .map((t) => (t === oldName ? newName : t))
      .filter((t, i, arr) => arr.findIndex((x) => x.toLowerCase() === t.toLowerCase()) === i)
    await db.files.update(file.id, { tags, dirty: 1, updatedAt: Date.now() })
    changed++
  }
  return changed
}

export async function deleteTag(name: string): Promise<number> {
  const notes = await db.notes.filter((n) => n.deletedAt === null && (n.tags ?? []).includes(name)).toArray()
  let changed = 0
  for (const note of notes) {
    await db.notes.update(note.id, {
      tags: (note.tags ?? []).filter((t) => t !== name),
      version: note.version + 1,
      dirty: 1,
      updatedAt: Date.now(),
    })
    changed++
  }
  const files = await db.files.filter((f) => f.deletedAt === null && (f.tags ?? []).includes(name)).toArray()
  for (const file of files) {
    await db.files.update(file.id, {
      tags: (file.tags ?? []).filter((t) => t !== name),
      dirty: 1,
      updatedAt: Date.now(),
    })
    changed++
  }
  return changed
}

export async function addTagToNote(noteId: string, name: string): Promise<boolean> {
  const note = await db.notes.get(noteId)
  if (!note || note.deletedAt !== null) return false
  const tags = note.tags ?? []
  if (tags.some((t) => t.toLowerCase() === name.toLowerCase())) return false
  await db.notes.update(noteId, {
    tags: [...tags, name],
    version: note.version + 1,
    dirty: 1,
    updatedAt: Date.now(),
  })
  return true
}
