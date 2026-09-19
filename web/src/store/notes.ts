import { db, type Note } from '../lib/db'

export async function listNotes(): Promise<Note[]> {
  const all = await db.notes.orderBy('updatedAt').reverse().toArray()
  return all.filter((n) => n.deletedAt === null)
}

export async function createNote(
  title = '',
  folderId: string | null = null,
  content: unknown = { type: 'doc', content: [] },
): Promise<Note> {
  const note: Note = {
    id: crypto.randomUUID(),
    title,
    content,
    folderId,
    tags: [],
    version: 1,
    dirty: 1,
    updatedAt: Date.now(),
    syncedAt: null,
    deletedAt: null,
  }
  await db.notes.add(note)
  return note
}

export async function updateNote(
  id: string,
  patch: Partial<Pick<Note, 'title' | 'content' | 'folderId' | 'tags'>>,
): Promise<void> {
  const existing = await db.notes.get(id)
  if (!existing) return
  await db.notes.update(id, {
    ...patch,
    version: existing.version + 1,
    dirty: 1,
    updatedAt: Date.now(),
  })
}

export async function softDeleteNote(id: string): Promise<void> {
  const existing = await db.notes.get(id)
  if (!existing) return
  await db.notes.update(id, {
    deletedAt: Date.now(),
    version: existing.version + 1,
    dirty: 1,
    updatedAt: Date.now(),
  })
}
