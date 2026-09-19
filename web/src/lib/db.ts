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
  // 文件归属的文件夹（与笔记的 folderId 同规则，null = 未归档）
  folderId: string | null
  filename: string
  mimeType: string | null
  size: number | null
  storagePath: string | null
  // 本地以 data URL 内联存放（未接 Supabase Storage），不上云同步
  dataUrl: string | null
  dirty: 0 | 1
  updatedAt: number
  syncedAt: number | null
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
