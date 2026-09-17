import { db, type Note } from '../lib/db'
import { supabase } from '../lib/supabase'

export interface SyncResult {
  pushed: number
  pulled: number
  conflicts: number
}

/**
 * Sync engine strategy: Last-Write-Wins (LWW).
 * - pushChanges: upload every local row with dirty=1, then mark syncedAt and dirty=0.
 * - pullChanges: fetch server rows changed since the last pull; a server row wins
 *   over a local row when its updated_at is newer. On equal/newer local timestamps
 *   the local row is kept and stays dirty so the next push overwrites the server.
 * - handleConflict: resolves a single pair by comparing timestamps (LWW); the
 *   loser is discarded. Monotonic version numbers are kept for optimistic
 *   concurrency and history, not for conflict resolution.
 */
export const syncEngine = {
  async pushChanges(userId: string): Promise<SyncResult> {
    const dirtyNotes = await db.notes.where('dirty').equals(1).toArray()
    let pushed = 0
    for (const note of dirtyNotes) {
      const { error } = await supabase.from('notes').upsert({
        id: note.id,
        user_id: userId,
        title: note.title,
        content: note.content,
        folder_id: note.folderId,
        version: note.version,
        updated_at: new Date(note.updatedAt).toISOString(),
        deleted_at: note.deletedAt ? new Date(note.deletedAt).toISOString() : null,
      })
      if (error) throw error
      await db.notes.update(note.id, { dirty: 0, syncedAt: Date.now() })
      pushed++
    }
    return { pushed, pulled: 0, conflicts: 0 }
  },

  async pullChanges(userId: string, since: number): Promise<SyncResult> {
    const { data, error } = await supabase
      .from('notes')
      .select('*')
      .eq('user_id', userId)
      .gt('updated_at', new Date(since).toISOString())
    if (error) throw error

    let pulled = 0
    let conflicts = 0
    for (const row of data ?? []) {
      const local = await db.notes.get(row.id as string)
      const remoteUpdated = new Date(row.updated_at as string).getTime()
      const remote: Note = {
        id: row.id as string,
        title: (row.title as string) ?? '',
        content: row.content,
        folderId: (row.folder_id as string | null) ?? null,
        version: row.version as number,
        dirty: 0,
        updatedAt: remoteUpdated,
        syncedAt: Date.now(),
        deletedAt: row.deleted_at ? new Date(row.deleted_at as string).getTime() : null,
      }
      if (local && local.dirty === 1) {
        const winner = this.handleConflict(local, remote)
        if (winner.id === local.id && winner.dirty === 1) {
          conflicts++
          continue
        }
        conflicts++
      }
      await db.notes.put({ ...remote, dirty: 0 })
      pulled++
    }
    return { pushed: 0, pulled, conflicts }
  },

  handleConflict(local: Note, remote: Note): Note {
    return local.updatedAt >= remote.updatedAt ? local : remote
  },
}
