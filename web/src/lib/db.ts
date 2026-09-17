import Dexie, { type EntityTable } from 'dexie'

export interface Note {
  id: string
  title: string
  content: unknown
  folderId: string | null
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
  noteId: string | null
  filename: string
  mimeType: string | null
  size: number | null
  storagePath: string | null
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
