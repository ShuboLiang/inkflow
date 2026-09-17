import { db, type Note } from '../lib/db'
import { supabase } from '../lib/supabase'

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
  version: number
  updated_at: string
  deleted_at: string | null
}

const lastSyncKey = (userId: string) => `inkflow:lastSyncAt:${userId}`

export function getLastSyncAt(userId: string): number {
  const raw = localStorage.getItem(lastSyncKey(userId))
  return raw ? Number(raw) : 0
}

function setLastSyncAt(userId: string, ts: number): void {
  localStorage.setItem(lastSyncKey(userId), String(ts))
}

// 正在编辑的笔记 id：pull/realtime 回声永远不覆盖它，push 冲突时本地优先。
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
    version: row.version,
    dirty: 0,
    updatedAt: new Date(row.updated_at).getTime(),
    syncedAt: Date.now(),
    deletedAt: row.deleted_at ? new Date(row.deleted_at).getTime() : null,
  }
}

function noteToRow(note: Note, userId: string) {
  return {
    id: note.id,
    user_id: userId,
    title: note.title,
    content: note.content,
    folder_id: note.folderId,
    version: note.version,
    updated_at: new Date(note.updatedAt).toISOString(),
    deleted_at: note.deletedAt ? new Date(note.deletedAt).toISOString() : null,
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
 *   stored in localStorage). It skips the actively edited note, skips locally
 *   dirty rows, and skips own push echoes (clean local row already at the same
 *   version). Rows with deleted_at set are removed from Dexie entirely.
 * - handleConflict: pure LWW by updatedAt; the loser is discarded.
 */
export const syncEngine = {
  async pushChanges(userId: string): Promise<SyncResult> {
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
            content: server.content,
            version: server.version,
          })
          await db.notes.update(note.id, { version: server.version as number })
          note.version = server.version as number
        } else {
          await supabase.from('note_versions').insert({
            note_id: note.id,
            content: note.content,
            version: note.version,
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
    return { pushed, pulled: 0, conflicts }
  },

  async pullChanges(userId: string, since?: number): Promise<SyncResult> {
    const from = since ?? getLastSyncAt(userId)
    const startedAt = Date.now()
    const { data, error } = await supabase
      .from('notes')
      .select('*')
      .eq('user_id', userId)
      .gt('updated_at', new Date(from).toISOString())
    if (error) throw error

    let pulled = 0
    for (const row of (data ?? []) as NoteRow[]) {
      if (row.id === activeEditId) continue
      const local = await db.notes.get(row.id)
      if (local?.dirty === 1) continue
      if (local && local.version === row.version) continue
      if (row.deleted_at) {
        if (local) await db.notes.delete(row.id)
        pulled++
        continue
      }
      await db.notes.put(rowToNote(row))
      pulled++
    }
    setLastSyncAt(userId, startedAt)
    return { pushed: 0, pulled, conflicts: 0 }
  },

  handleConflict(local: Note, remote: Note): Note {
    return local.updatedAt >= remote.updatedAt ? local : remote
  },

  subscribeNotes(userId: string, onRemoteChange: () => void): () => void {
    const channel = supabase
      .channel(`notes-sync-${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'notes', filter: `user_id=eq.${userId}` },
        () => onRemoteChange(),
      )
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  },
}
