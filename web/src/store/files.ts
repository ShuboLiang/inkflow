import { db, type FileEntry } from '../lib/db'

// 文件存 Dexie files 表，内容以 data URL 内联（未接 Supabase Storage，不同步上云）。
// 文件是文件夹的内容：folderId 与笔记同规则（null = 未归档），可拖到侧栏文件夹间移动。

export async function saveFile(file: File, folderId: string | null): Promise<FileEntry> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('read file failed'))
    reader.readAsDataURL(file)
  })
  const entry: FileEntry = {
    id: crypto.randomUUID(),
    folderId,
    filename: file.name,
    mimeType: file.type || null,
    size: file.size,
    storagePath: null,
    dataUrl,
    dirty: 0,
    updatedAt: Date.now(),
    syncedAt: null,
  }
  await db.files.add(entry)
  return entry
}

export async function deleteFile(id: string): Promise<void> {
  await db.files.delete(id)
}

export async function moveFile(id: string, folderId: string | null): Promise<void> {
  const existing = await db.files.get(id)
  if (!existing) return
  await db.files.update(id, { folderId, updatedAt: Date.now() })
}
