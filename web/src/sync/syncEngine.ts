import { db, type Folder, type Note, type FileEntry } from '../lib/db'
import { supabase } from '../lib/supabase'
import { dataUrlToBlob, revokeFileUrl } from '../store/files'
import { uploadPendingImages, imagePathsOf, noteImageSrcs, removeImagesIfUnreferenced } from '../store/images'
import { flushPendingVersionDeletions } from '../store/versions'

export interface SyncResult {
  pushed: number
  pulled: number
  conflicts: number
}

interface NoteRow {
  id: string
  user_id: string
  title: string
  content: unknown
  folder_id: string | null
  tags: string[] | null
  version: number
  updated_at: string
  deleted_at: string | null
  created_at?: string | null
  position?: number | null
}

interface FolderRow {
  id: string
  user_id: string
  name: string
  parent_id: string | null
  updated_at: string
  deleted_at: string | null
}

interface FileRow {
  id: string
  user_id: string
  folder_id: string | null
  filename: string
  mime_type: string | null
  size: number | null
  storage_path: string | null
  tags: string[] | null
  updated_at: string
  deleted_at: string | null
  created_at?: string | null
  position?: number | null
}

const lastSyncKey = (userId: string) => `inkflow:lastSyncAt:${userId}`

// 增量拉取的回看窗口：设备间时钟偏差会让「updated_at > lastSyncAt」永久漏掉
// 别端刚写的行（lastSyncAt 只增不减）。每次多回看几分钟，行级守卫
// （version / updatedAt 比较）保证重复应用是幂等的。
const PULL_OVERLAP_MS = 5 * 60 * 1000

export function getLastSyncAt(userId: string): number {
  const raw = localStorage.getItem(lastSyncKey(userId))
  return raw ? Number(raw) : 0
}

function setLastSyncAt(userId: string, ts: number): void {
  localStorage.setItem(lastSyncKey(userId), String(ts))
}

// 当前打开的笔记 id：push 冲突时本地优先（正在编辑的内容不能被服务器行覆盖）。
// pull 不再跳过它——本地有未保存修改时 dirty 位已足以保护，干净行允许被
// 远端更新刷新（编辑器自身也会避开聚焦/未保存输入状态再覆盖内容）。
// 由 App 在选中笔记变化时登记。
let activeEditId: string | null = null

export function setActiveEdit(id: string | null): void {
  activeEditId = id
}

function rowToNote(row: NoteRow): Note {
  return {
    id: row.id,
    title: row.title ?? '',
    content: row.content,
    folderId: row.folder_id ?? null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    version: row.version,
    dirty: 0,
    updatedAt: new Date(row.updated_at).getTime(),
    syncedAt: Date.now(),
    deletedAt: row.deleted_at ? new Date(row.deleted_at).getTime() : null,
    // created_at/position 是 010 迁移后新增列：老服务器（迁移未跑）或极端竞态下可能缺省
    createdAt: row.created_at ? new Date(row.created_at).getTime() : new Date(row.updated_at).getTime(),
    position: row.position ?? null,
  }
}

function noteToRow(note: Note, userId: string) {
  return {
    id: note.id,
    user_id: userId,
    title: note.title,
    content: note.content,
    folder_id: note.folderId,
    tags: note.tags ?? [],
    version: note.version,
    updated_at: new Date(note.updatedAt).toISOString(),
    deleted_at: note.deletedAt ? new Date(note.deletedAt).toISOString() : null,
    // created_at 仅创建时写入，此后不再变；position 随手动排序更新
    created_at: new Date(note.createdAt).toISOString(),
    position: note.position ?? null,
  }
}

function rowToFolder(row: FolderRow): Folder {
  return {
    id: row.id,
    name: row.name ?? '',
    parentId: row.parent_id ?? null,
    dirty: 0,
    updatedAt: new Date(row.updated_at).getTime(),
    syncedAt: Date.now(),
    deletedAt: row.deleted_at ? new Date(row.deleted_at).getTime() : null,
  }
}

function folderToRow(folder: Folder, userId: string) {
  return {
    id: folder.id,
    user_id: userId,
    name: folder.name,
    parent_id: folder.parentId,
    updated_at: new Date(folder.updatedAt).toISOString(),
    deleted_at: folder.deletedAt ? new Date(folder.deletedAt).toISOString() : null,
  }
}

function rowToFile(row: FileRow): FileEntry {
  return {
    id: row.id,
    folderId: row.folder_id ?? null,
    filename: row.filename ?? '',
    mimeType: row.mime_type,
    size: row.size,
    storagePath: row.storage_path,
    tags: Array.isArray(row.tags) ? row.tags : [],
    dirty: 0,
    updatedAt: new Date(row.updated_at).getTime(),
    syncedAt: Date.now(),
    deletedAt: row.deleted_at ? new Date(row.deleted_at).getTime() : null,
    // 011 迁移新增列：老服务器/竞态下可能缺省
    createdAt: row.created_at ? new Date(row.created_at).getTime() : new Date(row.updated_at).getTime(),
    position: row.position ?? null,
  }
}

function fileToRow(file: FileEntry, userId: string) {
  return {
    id: file.id,
    user_id: userId,
    folder_id: file.folderId,
    filename: file.filename,
    mime_type: file.mimeType,
    size: file.size,
    storage_path: file.storagePath,
    tags: file.tags ?? [],
    updated_at: new Date(file.updatedAt).toISOString(),
    deleted_at: file.deletedAt ? new Date(file.deletedAt).toISOString() : null,
    // created_at 仅创建时写入；position 与笔记共用数轴（统一列表手动排序）
    created_at: new Date(file.createdAt).toISOString(),
    position: file.position ?? null,
  }
}

/**
 * Sync engine strategy: Last-Write-Wins (LWW).
 * - pushChanges: re-reads each dirty note to push the freshest content, and
 *   clears dirty only when the note's updatedAt is unchanged since that read
 *   (a newer save during the network round-trip keeps dirty=1 for the next
 *   cycle). If the server version is newer, the server row wins — except for
 *   the note currently being edited, where local wins: the server row is
 *   archived to note_versions and the local version is raised to the server
 *   version so the next push overwrites the server.
 * - pullChanges: fetches server rows with updated_at > lastSyncAt (per user,
 *   stored in localStorage), minus a small overlap window that absorbs clock
 *   skew between devices. It skips locally dirty rows and own push echoes
 *   (clean local row already at the same version). The currently open note is
 *   no longer skipped: a clean row is safe to refresh from the server (the
 *   editor refuses to overwrite focused/unsaved input anyway). Rows with
 *   deleted_at set are removed from Dexie entirely.
 * - handleConflict: pure LWW by updatedAt; the loser is discarded.
 * - folders: 同样按 updated_at 做 LWW，但无版本号和历史归档——纯元数据，
 *   冲突时服务器较新一方直接获胜；删除是软删除（deleted_at），pull 到后
 *   从本地 Dexie 物理清除。
 */
export const syncEngine = {
  async pushChanges(userId: string): Promise<SyncResult> {
    // 先补齐待传的图片：笔记内容里引用的公共 URL 需要对象真实存在
    await uploadPendingImages()

    const dirtyNotes = await db.notes.where('dirty').equals(1).toArray()
    let pushed = 0
    let conflicts = 0
    for (const snapshot of dirtyNotes) {
      const note = await db.notes.get(snapshot.id)
      if (!note || note.dirty === 0) continue

      const { data: server, error: readErr } = await supabase
        .from('notes')
        .select('*')
        .eq('id', note.id)
        .maybeSingle()
      if (readErr) throw readErr

      if (server && (server.version as number) > note.version) {
        conflicts++
        if (note.id === activeEditId) {
          await supabase.from('note_versions').insert({
            note_id: server.id as string,
            title: (server.title as string) ?? '',
            content: server.content,
            version: server.version,
            source: 'auto',
            name: '冲突自动备份 (云端版本)',
          })
          // 本地胜出覆盖服务器时把 updatedAt 刷新到当下：离线期间写入的旧时间戳
          // 会让其他端的增量拉取（updated_at > lastSyncAt）永远看不到这次覆盖
          const now = Date.now()
          await db.notes.update(note.id, { version: server.version as number, updatedAt: now })
          note.version = server.version as number
          note.updatedAt = now
        } else {
          await supabase.from('note_versions').insert({
            note_id: note.id,
            title: note.title ?? '',
            content: note.content,
            version: note.version,
            source: 'auto',
            name: '冲突自动备份 (本地版本)',
          })
          await db.notes.put({ ...rowToNote(server as NoteRow), dirty: 0, syncedAt: Date.now() })
          continue
        }
      }

      const { error } = await supabase.from('notes').upsert(noteToRow(note, userId))
      if (error) throw error
      const cur = await db.notes.get(note.id)
      if (cur && cur.updatedAt === note.updatedAt) {
        await db.notes.update(note.id, { dirty: 0, syncedAt: Date.now() })
      }
      pushed++
    }

    const dirtyFolders = await db.folders.where('dirty').equals(1).toArray()
    for (const snapshot of dirtyFolders) {
      const folder = await db.folders.get(snapshot.id)
      if (!folder || folder.dirty === 0) continue

      const { data: server, error: readErr } = await supabase
        .from('folders')
        .select('*')
        .eq('id', folder.id)
        .maybeSingle()
      if (readErr) throw readErr

      if (server && new Date((server as FolderRow).updated_at).getTime() > folder.updatedAt) {
        // 冲突：服务器较新直接获胜（文件夹无历史版本可归档）
        await db.folders.put({ ...rowToFolder(server as FolderRow), dirty: 0, syncedAt: Date.now() })
        continue
      }
      if (folder.deletedAt && !server) {
        // 本地已删、服务器从未有过：无需同步，直接清掉本地记录
        await db.folders.delete(folder.id)
        continue
      }
      const { error } = await supabase.from('folders').upsert(folderToRow(folder, userId))
      if (error) throw error
      const cur = await db.folders.get(folder.id)
      if (cur && cur.updatedAt === folder.updatedAt) {
        await db.folders.update(folder.id, { dirty: 0, syncedAt: Date.now() })
      }
      pushed++
    }

    // 文件：先按需把本地内容上传到 Storage，再同步元数据行（软删除仅同步 deleted_at 元数据，保留在回收站）
    const dirtyFiles = await db.files.where('dirty').equals(1).toArray()
    for (const snapshot of dirtyFiles) {
      const file = await db.files.get(snapshot.id)
      if (!file || file.dirty === 0) continue

      if (file.dataUrl && !file.storagePath) {
        const path = `${userId}/${file.id}`
        const { error: upErr } = await supabase.storage
          .from('files')
          .upload(path, dataUrlToBlob(file.dataUrl, file.mimeType), {
            contentType: file.mimeType ?? 'application/octet-stream',
            upsert: true,
          })
        if (upErr) throw upErr
        await db.files.update(file.id, { storagePath: path })
        file.storagePath = path
      }

      const { data: server } = await supabase
        .from('files')
        .select('*')
        .eq('id', file.id)
        .maybeSingle()

      if (server) {
        file.storagePath = (server as FileRow).storage_path
      }
      if (
        server &&
        !file.storagePath &&
        new Date((server as FileRow).updated_at).getTime() > file.updatedAt
      ) {
        // 本地还没上传内容、服务器元数据又更新过：以服务器为准，下轮 pull 拉详情
        await db.files.put(rowToFile(server as FileRow))
        continue
      }

      const { error } = await supabase.from('files').upsert(fileToRow(file, userId))
      if (error) throw error
      const cur = await db.files.get(file.id)
      if (cur && cur.updatedAt === file.updatedAt) {
        await db.files.update(file.id, { dirty: 0, syncedAt: Date.now() })
      }
      pushed++
    }

    // 笔记历史版本：同步删除并推送新增/重命名的快照
    await flushPendingVersionDeletions()
    const dirtyVersions = await db.noteVersions.where('dirty').equals(1).toArray()
    for (const v of dirtyVersions) {
      const { error: vErr } = await supabase.from('note_versions').upsert({
        id: v.id,
        note_id: v.noteId,
        title: v.title ?? '',
        content: v.content,
        version: v.version,
        source: v.source,
        name: v.name ?? null,
        char_count: v.charCount,
        created_at: new Date(v.createdAt).toISOString(),
      })
      if (!vErr) {
        await db.noteVersions.update(v.id, { dirty: 0, syncedAt: Date.now() })
        pushed++
      }
    }

    return { pushed, pulled: 0, conflicts }
  },

  async pullChanges(userId: string, since?: number): Promise<SyncResult> {
    const from = Math.max(0, (since ?? getLastSyncAt(userId)) - PULL_OVERLAP_MS)
    const startedAt = Date.now()
    const { data, error } = await supabase
      .from('notes')
      .select('*')
      .eq('user_id', userId)
      .gt('updated_at', new Date(from).toISOString())
    if (error) throw error

    let pulled = 0
    for (const row of (data ?? []) as NoteRow[]) {
      const local = await db.notes.get(row.id)
      if (local?.dirty === 1) continue
      if (local && local.version === row.version) continue
      await db.notes.put(rowToNote(row))
      pulled++
    }

    const { data: folderData, error: folderErr } = await supabase
      .from('folders')
      .select('*')
      .eq('user_id', userId)
      .gt('updated_at', new Date(from).toISOString())
    if (folderErr) throw folderErr

    for (const row of (folderData ?? []) as FolderRow[]) {
      const local = await db.folders.get(row.id)
      if (local?.dirty === 1) continue
      const remoteTs = new Date(row.updated_at).getTime()
      if (local && local.updatedAt >= remoteTs) continue
      if (row.deleted_at) {
        if (local) await db.folders.delete(row.id)
        pulled++
        continue
      }
      await db.folders.put(rowToFolder(row))
      pulled++
    }

    const { data: fileData, error: fileErr } = await supabase
      .from('files')
      .select('*')
      .eq('user_id', userId)
      .gt('updated_at', new Date(from).toISOString())
    if (fileErr) throw fileErr

    for (const row of (fileData ?? []) as FileRow[]) {
      const local = await db.files.get(row.id)
      if (local?.dirty === 1) continue
      const remoteTs = new Date(row.updated_at).getTime()
      if (local && local.updatedAt >= remoteTs) continue
      // 纯元数据同步：不存 dataUrl，软删除记录存入回收站
      await db.files.put(rowToFile(row))
      pulled++
    }

    // 孤儿文件与笔记对齐清理：解决云端已物理永久删除的历史项目在本地残留的问题
    const { data: serverFiles, error: sfErr } = await supabase
      .from('files')
      .select('id')
      .eq('user_id', userId)
    if (!sfErr && serverFiles) {
      const serverIds = new Set(serverFiles.map((s) => s.id as string))
      const localFiles = await db.files.toArray()
      for (const lf of localFiles) {
        if (lf.dirty === 0 && lf.syncedAt !== null && !serverIds.has(lf.id)) {
          await db.files.delete(lf.id)
          revokeFileUrl(lf.id)
          pulled++
        }
      }
    }

    const { data: serverNotes, error: snErr } = await supabase
      .from('notes')
      .select('id')
      .eq('user_id', userId)
    if (!snErr && serverNotes) {
      const serverNoteIds = new Set(serverNotes.map((s) => s.id as string))
      const localNotes = await db.notes.toArray()
      for (const ln of localNotes) {
        if (ln.dirty === 0 && ln.syncedAt !== null && !serverNoteIds.has(ln.id)) {
          const paths = imagePathsOf(noteImageSrcs(ln.content))
          await db.notes.delete(ln.id)
          if (paths.length) void removeImagesIfUnreferenced(paths)
          pulled++
        }
      }
    }
    setLastSyncAt(userId, startedAt)
    return { pushed: 0, pulled, conflicts: 0 }
  },

  handleConflict(local: Note, remote: Note): Note {
    return local.updatedAt >= remote.updatedAt ? local : remote
  },

  subscribeChanges(userId: string, onRemoteChange: () => void): () => void {
    const channel = supabase
      .channel(`notes-sync-${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'notes', filter: `user_id=eq.${userId}` },
        () => onRemoteChange(),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'folders', filter: `user_id=eq.${userId}` },
        () => onRemoteChange(),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'files', filter: `user_id=eq.${userId}` },
        () => onRemoteChange(),
      )
      .subscribe((status) => {
        // 订阅成功（含断线重连后的重新订阅）即回拉一次：断线期间错过的
        // 变更事件不会重放，只能靠增量 pull 补齐
        if (status === 'SUBSCRIBED') onRemoteChange()
      })
    return () => {
      void supabase.removeChannel(channel)
    }
  },
}
