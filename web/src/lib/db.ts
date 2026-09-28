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
  // 创建时间（不可变，创建时写一次；排序用）
  createdAt: number
  // 手动排序位置（升序；null = 未参与手动排序，按 createdAt 兜底）
  position: number | null
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
  tags: string[]
  // 文件内容纯云端流式按需加载，不再持久化在本地 IndexedDB
  dataUrl?: string | null
  dirty: 0 | 1
  updatedAt: number
  syncedAt: number | null
  deletedAt: number | null
  // 创建时间（不可变）与统一列表的手动排序位置（与 notes 同一数轴，升序）
  createdAt: number
  position: number | null
}

export interface NoteVersion {
  id: string
  noteId: string
  title: string
  content: unknown
  version: number
  source: 'auto' | 'manual'
  name?: string
  createdAt: number
  charCount: number
  dirty: 0 | 1
  syncedAt: number | null
}

export const db = new Dexie('inkflow') as Dexie & {
  notes: EntityTable<Note, 'id'>
  folders: EntityTable<Folder, 'id'>
  tags: EntityTable<Tag, 'id'>
  files: EntityTable<FileEntry, 'id'>
  images: EntityTable<ImageCache, 'path'>
  noteVersions: EntityTable<NoteVersion, 'id'>
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

// v4: 图片本地缓存（图片本体在 Storage 公共桶 images，这里缓存 data URL 供离线/未下载时显示）
export interface ImageCache {
  // 桶内路径：{uuid}.{ext}
  path: string
  dataUrl: string
  // 1 = 待上传（离线粘贴等场景），0 = 已上传
  dirty: 0 | 1
  createdAt: number
}

db.version(4).stores({
  images: 'path, dirty',
})

// v5: 文件内容改为纯云端按需加载，本地 Dexie 只存元数据，清除存量 dataUrl 释放磁盘
db.version(5)
  .stores({
    files: 'id, folderId, dirty',
  })
  .upgrade((tx) =>
    tx
      .table('files')
      .toCollection()
      .modify((f: Partial<FileEntry>) => {
        delete f.dataUrl
      }),
  )

// v6: 笔记排序——createdAt/position 字段落地（云端 010 迁移的本地对应）。
// 老行回填：createdAt 无本地来源，用 updatedAt 近似；position 按 updatedAt 顺序
// 生成间隔 1000 的序列（之后 pull 会用服务器值覆盖）
db.version(6)
  .stores({
    notes: 'id, folderId, dirty, updatedAt',
  })
  .upgrade(async (tx) => {
    const rows = await tx.table('notes').toArray()
    const sorted = [...rows].sort((a, b) => (a.updatedAt as number) - (b.updatedAt as number))
    const positionById = new Map(sorted.map((r, i) => [r.id as string, (i + 1) * 1000]))
    await Promise.all(
      rows.map((r) =>
        tx.table('notes').update(r.id, {
          createdAt: r.updatedAt ?? Date.now(),
          position: positionById.get(r.id) ?? null,
        }),
      ),
    )
  })

// v7: 统一排序（云端 011 的本地对应）——
// notes position 反转为「新→旧」编号；files 补 createdAt/position（与笔记同一数轴）
db.version(7)
  .stores({
    notes: 'id, folderId, dirty, updatedAt',
    files: 'id, folderId, dirty',
  })
  .upgrade(async (tx) => {
    const notes = await tx.table('notes').toArray()
    const liveNotes = notes
      .filter((n) => !n.deletedAt)
      .sort((a, b) => (b.createdAt ?? b.updatedAt ?? 0) - (a.createdAt ?? a.updatedAt ?? 0))
    const notePos = new Map(liveNotes.map((n, i) => [n.id as string, (i + 1) * 1000]))
    for (const n of notes) {
      const p = notePos.get(n.id as string)
      if (p !== undefined && n.position !== p) {
        await tx.table('notes').update(n.id, { position: p })
      }
    }
    const files = await tx.table('files').toArray()
    const liveFiles = files.filter((f) => !f.deletedAt).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    const filePos = new Map(liveFiles.map((f, i) => [f.id as string, (i + 1) * 1000]))
    for (const f of files) {
      await tx.table('files').update(f.id, {
        createdAt: f.createdAt ?? f.updatedAt ?? Date.now(),
        position: f.position ?? filePos.get(f.id as string) ?? null,
      })
    }
  })

// v8: 笔记版本控制（快照历史）
db.version(8).stores({
  noteVersions: 'id, noteId, createdAt, dirty',
})
