import { db, type Folder } from '../lib/db'

export async function listFolders(): Promise<Folder[]> {
  const all = await db.folders.toArray()
  return all
    .filter((f) => f.deletedAt === null)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

export async function createFolder(name: string): Promise<Folder> {
  const folder: Folder = {
    id: crypto.randomUUID(),
    name,
    parentId: null,
    dirty: 1,
    updatedAt: Date.now(),
    syncedAt: null,
    deletedAt: null,
  }
  await db.folders.add(folder)
  return folder
}

export async function renameFolder(id: string, name: string): Promise<void> {
  const existing = await db.folders.get(id)
  if (!existing) return
  await db.folders.update(id, { name, dirty: 1, updatedAt: Date.now() })
}

// 软删除文件夹，并把其中的笔记移回未归档（逐个 bump version 走正常同步）。
// 笔记不跟随删除，避免误删内容。
export async function deleteFolder(id: string): Promise<void> {
  const existing = await db.folders.get(id)
  if (!existing) return
  await db.folders.update(id, { deletedAt: Date.now(), dirty: 1, updatedAt: Date.now() })
  const notes = await db.notes.where('folderId').equals(id).toArray()
  for (const note of notes) {
    if (note.deletedAt !== null) continue
    await db.notes.update(note.id, {
      folderId: null,
      version: note.version + 1,
      dirty: 1,
      updatedAt: Date.now(),
    })
  }
}
