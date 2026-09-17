import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './lib/db'
import { Auth } from './components/Auth'
import { Editor } from './components/Editor'
import { EmptyState } from './components/EmptyState'
import { NoteList } from './components/NoteList'
import { Sidebar } from './components/Sidebar'
import { SyncIndicator } from './components/SyncIndicator'
import { useAuth } from './hooks/useAuth'
import { useSync } from './hooks/useSync'
import { createNote, softDeleteNote, updateNote } from './store/notes'
import { setActiveEdit } from './sync/syncEngine'
import './App.css'

export default function App() {
  const { user, loading, signOut } = useAuth()
  const { status: syncStatus, requestPush } = useSync(user)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [mobileView, setMobileView] = useState<'list' | 'editor'>('list')
  const titleRef = useRef<HTMLInputElement>(null)
  const focusTitleOn = useRef<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSave = useRef<{ id: string; patch: { title?: string; content?: unknown } } | null>(null)

  const notes = useLiveQuery(
    () => db.notes.orderBy('updatedAt').reverse().filter((n) => n.deletedAt === null).toArray(),
    [],
  )

  const visibleNotes = useMemo(() => {
    const all = notes ?? []
    const q = search.trim().toLowerCase()
    if (!q) return all
    return all.filter((n) => n.title.toLowerCase().includes(q))
  }, [notes, search])

  const active = notes?.find((n) => n.id === activeId) ?? null

  useEffect(() => {
    setActiveEdit(activeId)
    return () => setActiveEdit(null)
  }, [activeId])

  useEffect(() => {
    if (activeId && focusTitleOn.current === activeId) {
      focusTitleOn.current = null
      titleRef.current?.focus()
    }
  }, [activeId, active])

  useEffect(() => {
    const el = titleRef.current
    if (el && active && el.value !== active.title) {
      el.value = active.title
    }
  }, [active])

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [])

  const scheduleSave = (id: string, patch: { title?: string; content?: unknown }) => {
    pendingSave.current =
      pendingSave.current && pendingSave.current.id === id
        ? { id, patch: { ...pendingSave.current.patch, ...patch } }
        : { id, patch }
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      const pending = pendingSave.current
      pendingSave.current = null
      if (pending) void updateNote(pending.id, pending.patch).then(requestPush)
    }, 500)
  }

  const flushSave = () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const pending = pendingSave.current
    pendingSave.current = null
    if (pending) void updateNote(pending.id, pending.patch).then(requestPush)
  }

  const handleCreate = async () => {
    flushSave()
    const note = await createNote('')
    focusTitleOn.current = note.id
    setActiveId(note.id)
    setMobileView('editor')
  }

  const handleSelect = (id: string) => {
    flushSave()
    setActiveId(id)
    setMobileView('editor')
  }

  const handleDelete = async () => {
    if (!active) return
    if (!window.confirm('删除这篇笔记？')) return
    flushSave()
    await softDeleteNote(active.id)
    requestPush()
    setActiveId(null)
    setMobileView('list')
  }

  if (loading) {
    return <div className="app-shell" style={{ alignItems: 'center', justifyContent: 'center' }}>载入中…</div>
  }

  if (!user) return <Auth />

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <button
          type="button"
          className="app-menu"
          aria-label="打开侧栏"
          onClick={() => setSidebarOpen((v) => !v)}
        >
          ☰
        </button>
        <span />
        <SyncIndicator status={syncStatus} />
      </header>
      <div className={mobileView === 'editor' ? 'app-main view-editor' : 'app-main'}>
        <Sidebar
          email={user.email ?? ''}
          collapsed={!sidebarOpen}
          onSignOut={() => void signOut()}
        />
        <NoteList
          notes={visibleNotes}
          activeId={activeId}
          search={search}
          onSearch={setSearch}
          onSelect={handleSelect}
          onCreate={() => void handleCreate()}
        />
        <main className="editor-pane">
          {active ? (
            <>
              <div className="editor-toolbar">
                <button type="button" className="editor-back" onClick={() => setMobileView('list')}>
                  ← 返回列表
                </button>
                <button type="button" className="editor-delete" onClick={() => void handleDelete()}>
                  删除
                </button>
              </div>
              <div className="editor-scroll">
                <input
                  key={`title-${active.id}`}
                  ref={titleRef}
                  className="editor-title"
                  defaultValue={active.title}
                  placeholder="无标题"
                  aria-label="笔记标题"
                  onChange={(e) => scheduleSave(active.id, { title: e.target.value })}
                />
                <Editor
                  key={active.id}
                  content={active.content}
                  onUpdate={(content) => scheduleSave(active.id, { content })}
                />
              </div>
            </>
          ) : (
            <EmptyState />
          )}
        </main>
      </div>
    </div>
  )
}

