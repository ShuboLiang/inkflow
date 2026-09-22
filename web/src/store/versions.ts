import { db, type Note, type NoteVersion } from '../lib/db'
import { supabase } from '../lib/supabase'
import { plainTextOf } from '../lib/search'
import { createNote } from './notes'

const MAX_AUTO_VERSIONS_PER_NOTE = 50
const PENDING_DELETIONS_KEY = 'inkflow:pending_version_deletions'

export function getPendingVersionDeletions(): string[] {
  try {
    const raw = localStorage.getItem(PENDING_DELETIONS_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

export function recordPendingVersionDeletion(id: string): void {
  try {
    const list = getPendingVersionDeletions()
    if (!list.includes(id)) {
      list.push(id)
      localStorage.setItem(PENDING_DELETIONS_KEY, JSON.stringify(list))
    }
  } catch {}
}

export function clearPendingVersionDeletions(ids: string[]): void {
  try {
    const idSet = new Set(ids)
    const list = getPendingVersionDeletions().filter((id) => !idSet.has(id))
    if (list.length > 0) {
      localStorage.setItem(PENDING_DELETIONS_KEY, JSON.stringify(list))
    } else {
      localStorage.removeItem(PENDING_DELETIONS_KEY)
    }
  } catch {}
}

export async function flushPendingVersionDeletions(): Promise<void> {
  const pending = getPendingVersionDeletions()
  if (pending.length === 0) return
  try {
    const { error } = await supabase.from('note_versions').delete().in('id', pending)
    if (!error) {
      clearPendingVersionDeletions(pending)
    }
  } catch (err) {
    console.error('flushPendingVersionDeletions failed:', err)
  }
}

/**
 * 获取本地存储的笔记版本列表（按时间倒序）
 */
export async function listNoteVersions(noteId: string): Promise<NoteVersion[]> {
  const pendingDeletes = new Set(getPendingVersionDeletions())
  const all = await db.noteVersions.where('noteId').equals(noteId).sortBy('createdAt')
  return all.filter((v) => !pendingDeletes.has(v.id)).reverse()
}

/**
 * 从云端按需拉取指定笔记的历史版本并合并到本地 IndexedDB
 */
export async function fetchRemoteVersions(noteId: string): Promise<NoteVersion[]> {
  try {
    // 1. 先尝试将本地待删除队列同步至云端
    await flushPendingVersionDeletions()

    // 2. 从云端拉取该笔记的最新版本记录
    const { data, error } = await supabase
      .from('note_versions')
      .select('id, note_id, title, content, version, source, name, created_at, char_count')
      .eq('note_id', noteId)
      .order('created_at', { ascending: false })

    if (error || !data) {
      return await listNoteVersions(noteId)
    }

    const pendingDeletes = new Set(getPendingVersionDeletions())

    const remoteRows: NoteVersion[] = data
      .filter((r) => !pendingDeletes.has(r.id))
      .map((r: {
        id: string
        note_id: string
        title?: string
        content: unknown
        version: number
        source?: string
        name?: string | null
        created_at: string
        char_count?: number
      }) => {
        const charCount = typeof r.char_count === 'number' ? r.char_count : plainTextOf(r.content).length
        return {
          id: r.id,
          noteId: r.note_id,
          title: r.title ?? '',
          content: r.content,
          version: r.version,
          source: (r.source === 'manual' ? 'manual' : 'auto') as 'auto' | 'manual',
          name: r.name ?? undefined,
          createdAt: new Date(r.created_at).getTime(),
          charCount,
          dirty: 0,
          syncedAt: Date.now(),
        }
      })

    const remoteIdSet = new Set(remoteRows.map((r) => r.id))

    // 批量写入本地，并双向对齐删除：
    // 本地已同步 (dirty: 0) 但在远程已经被删除的版本，从本地数据库中清除！
    await db.transaction('rw', db.noteVersions, async () => {
      const locals = await db.noteVersions.where('noteId').equals(noteId).toArray()
      const toDeleteLocally = locals
        .filter((l) => pendingDeletes.has(l.id) || (l.dirty === 0 && !remoteIdSet.has(l.id)))
        .map((l) => l.id)

      if (toDeleteLocally.length > 0) {
        await db.noteVersions.bulkDelete(toDeleteLocally)
      }

      for (const row of remoteRows) {
        const local = await db.noteVersions.get(row.id)
        if (!local || local.dirty === 0) {
          await db.noteVersions.put(row)
        }
      }
    })
  } catch (err) {
    console.error('fetchRemoteVersions failed:', err)
  }

  return await listNoteVersions(noteId)
}

/**
 * 为笔记创建版本快照
 */
export async function createVersionSnapshot(
  note: Note,
  source: 'auto' | 'manual' = 'auto',
  name?: string,
): Promise<NoteVersion> {
  const now = Date.now()
  const plain = plainTextOf(note.content)
  const charCount = plain.length

  const versionEntry: NoteVersion = {
    id: crypto.randomUUID(),
    noteId: note.id,
    title: note.title ?? '',
    content: JSON.parse(JSON.stringify(note.content ?? { type: 'doc', content: [] })),
    version: note.version,
    source,
    name: name?.trim() || undefined,
    createdAt: now,
    charCount,
    dirty: 1,
    syncedAt: null,
  }

  await db.noteVersions.add(versionEntry)

  // 若为自动快照，触发数量上限淘汰（手动命名版本永不自动淘汰）
  if (source === 'auto') {
    void pruneOldAutoVersions(note.id)
  }

  return versionEntry
}

/**
 * 智能自动快照策略：
 * 1. 若当前内容与上一版本完全一致，绝不重复生成快照。
 * 2. 距离上一个快照间隔超过 minIntervalMs (默认 5 分钟)，或者正文字数变动达到阈值 (默认 200 字)，生成自动快照。
 * 3. 切换离开当前笔记、手动点击保存、或发生重大编辑停顿时触发。
 */
export async function maybeCreateAutoSnapshot(
  note: Note,
  options?: { minIntervalMs?: number; minCharDiff?: number; force?: boolean },
): Promise<NoteVersion | null> {
  const minInterval = options?.minIntervalMs ?? 5 * 60 * 1000 // 5 分钟
  const minCharDiff = options?.minCharDiff ?? 200
  const force = options?.force ?? false

  const versions = await listNoteVersions(note.id)
  const latest = versions[0]

  const currentPlain = plainTextOf(note.content)
  const currentCharCount = currentPlain.length

  if (latest) {
    const latestPlain = plainTextOf(latest.content)
    // 内容和标题均完全没变，不创建
    if (latest.title === (note.title ?? '') && latestPlain === currentPlain) {
      return null
    }

    if (!force) {
      const elapsed = Date.now() - latest.createdAt
      const charDiff = Math.abs(currentCharCount - latest.charCount)
      if (elapsed < minInterval && charDiff < minCharDiff) {
        return null
      }
    }
  }

  return await createVersionSnapshot(note, 'auto')
}

/**
 * 自动淘汰超出配额的旧自动版本
 */
async function pruneOldAutoVersions(noteId: string): Promise<void> {
  try {
    const autoVersions = await db.noteVersions
      .where('noteId')
      .equals(noteId)
      .filter((v) => v.source === 'auto' && !v.name)
      .sortBy('createdAt')

    if (autoVersions.length > MAX_AUTO_VERSIONS_PER_NOTE) {
      const toDelete = autoVersions.slice(0, autoVersions.length - MAX_AUTO_VERSIONS_PER_NOTE)
      const ids = toDelete.map((v) => v.id)
      await db.noteVersions.bulkDelete(ids)
      // 云端对应清理
      await supabase.from('note_versions').delete().in('id', ids)
    }
  } catch {
    // 忽略清理异常
  }
}

/**
 * 恢复至指定历史版本
 * 执行前自动将当前笔记状态备份为一个安全快照
 */
export async function restoreVersion(
  noteId: string,
  versionId: string,
): Promise<{ success: boolean; error?: string }> {
  const current = await db.notes.get(noteId)
  if (!current) return { success: false, error: '笔记不存在' }

  const target = await db.noteVersions.get(versionId)
  if (!target) return { success: false, error: '目标版本不存在' }

  // 1. 安全前置：当前状态备份为快照
  await createVersionSnapshot(current, 'auto', '恢复前自动备份')

  // 2. 覆盖替换笔记内容
  const now = Date.now()
  await db.notes.update(noteId, {
    title: target.title,
    content: target.content,
    version: current.version + 1,
    dirty: 1,
    updatedAt: now,
  })

  return { success: true }
}

/**
 * 将指定历史版本另存为一篇全新的独立笔记
 */
export async function copyVersionAsNewNote(
  versionId: string,
  folderId: string | null = null,
): Promise<Note | null> {
  const ver = await db.noteVersions.get(versionId)
  if (!ver) return null

  const titlePrefix = ver.title ? `${ver.title} (历史副本)` : '历史版本副本'
  return await createNote(titlePrefix, folderId, ver.content)
}

/**
 * 重命名指定版本
 */
export async function renameVersion(versionId: string, name: string): Promise<void> {
  const trimmed = name.trim()
  await db.noteVersions.update(versionId, {
    name: trimmed || undefined,
    dirty: 1,
  })
}

/**
 * 删除指定版本（支持离线队列、真等待云端确认，杜绝刷新复活）
 */
export async function deleteVersion(versionId: string): Promise<void> {
  // 1. 本地立即清除，并登记待删除队列以防止远程拉取再次复活
  await db.noteVersions.delete(versionId)
  recordPendingVersionDeletion(versionId)

  // 2. 发起云端删除请求并真正等待完成
  try {
    const { error } = await supabase.from('note_versions').delete().eq('id', versionId)
    if (!error) {
      clearPendingVersionDeletions([versionId])
    }
  } catch (err) {
    console.error('Remote deleteVersion failed:', err)
  }
}
