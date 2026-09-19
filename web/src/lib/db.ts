import Dexie, { type EntityTable } from 'dexie'

export interface Note {
  id: string
  title: string
  content: unknown
  folderId: string | null
  tags: string[]
  version: number
  dirty: 0 | 1
  updatedAt: number
  syncedAt: number | null
  deletedAt: number | null
}

export interface Folder {
  id: string
  name: string
  parentId: string | null
  dirty: 0 | 1
  updatedAt: number
  syncedAt: number | null
  deletedAt: number | null
}

export interface Tag {
  id: string
  name: string
  dirty: 0 | 1
  updatedAt: number
  syncedAt: number | null
}

export interface FileEntry {
  id: string
  // 文件归属的文件夹（与笔记的 folderId 同规则，null = 无文件夹）
  folderId: string | null
  filename: string
  mimeType: string | null
  size: number | null
  storagePath: string | null
  // 本地以 data URL 内联存放（同步后仍保留，离线可预览；新设备按需从 Storage 拉取）
  dataUrl: string | null
  dirty: 0 | 1
  updatedAt: number
  syncedAt: number | null
  deletedAt: number | null
}

export const db = new Dexie('inkflow') as Dexie & {
  notes: EntityTable<Note, 'id'>
  folders: EntityTable<Folder, 'id'>
  tags: EntityTable<Tag, 'id'>
  files: EntityTable<FileEntry, 'id'>
}

db.version(1).stores({
  notes: 'id, folderId, dirty, updatedAt',
  folders: 'id, parentId, dirty',
  tags: 'id, name, dirty',
  files: 'id, noteId, dirty',
})

// v2: files 表改挂 folderId（文件是文件夹的内容，与笔记同规则）
db.version(2).stores({
  files: 'id, folderId, dirty',
})

// v3: 文件上云同步——老的本地文件（syncedAt 为空）补 dirty=1 让下一轮 push 带上；
// 老的硬删除已物理清除，无需处理 deletedAt 回填以外的字段
db.version(3)
  .stores({
    files: 'id, folderId, dirty',
  })
  .upgrade((tx) =>
    tx
      .table('files')
      .toCollection()
      .modify((f: Partial<FileEntry>) => {
        if (f.deletedAt === undefined) f.deletedAt = null
        if (f.deletedAt === null && f.syncedAt === null && f.dirty === 0) f.dirty = 1
      }),
  )
