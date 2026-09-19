import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './lib/db'
import { Auth } from './components/Auth'
import { Editor } from './components/Editor'
import { EditorBoundary } from './components/EditorBoundary'
import { EmptyState } from './components/EmptyState'
import { NoteList } from './components/NoteList'
import { Sidebar } from './components/Sidebar'
import { SyncIndicator } from './components/SyncIndicator'
import { useAuth } from './hooks/useAuth'
import { useSync } from './hooks/useSync'
import { createNote, softDeleteNote, updateNote } from './store/notes'
import { createFolder, deleteFolder, renameFolder } from './store/folders'
import { addTagToNote, deleteTag, renameTag } from './store/tags'
import { deleteFile, ensureFileData, moveFile, saveFile } from './store/files'
import { ShareMenu } from './components/ShareMenu'
import { fileToDocJson, kindOfFile } from './lib/importFile'
import { TagInput } from './components/TagInput'
import { countWords } from './lib/wordCount'
import { getDiagnostics } from './lib/diagnostics'
import { setActiveEdit } from './sync/syncEngine'
import './App.css'

const lastOpenKey = (userId: string) => `inkflow:lastOpen:${userId}`

export default function App() {
  const { user, loading, signOut } = useAuth()
  const { status: syncStatus, requestPush } = useSync(user)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [activeFolderId, setActiveFolderId] = useState<string>('all')
  const [activeTag, setActiveTag] = useState<string | null>(null)
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

  const folders = useLiveQuery(async () => {
    const all = await db.folders.filter((f) => f.deletedAt === null).toArray()
    return all.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  }, [])

  const files = useLiveQuery(() => db.files.toArray(), [])

  const folderCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of notes ?? []) {
      if (n.folderId) m.set(n.folderId, (m.get(n.folderId) ?? 0) + 1)
    }
    return m
  }, [notes])

  const unfiledCount = useMemo(() => (notes ?? []).filter((n) => n.folderId === null).length, [notes])

  const tagCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of notes ?? []) {
      for (const t of n.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1)
    }
    return new Map([...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN')))
  }, [notes])

  const visibleNotes = useMemo(() => {
    const all = notes ?? []
    let scoped =
      activeFolderId === 'all'
        ? all
        : activeFolderId === 'none'
          ? all.filter((n) => n.folderId === null)
          : all.filter((n) => n.folderId === activeFolderId)
    if (activeTag) scoped = scoped.filter((n) => (n.tags ?? []).includes(activeTag))
    const q = search.trim().toLowerCase()
    if (!q) return scoped
    return scoped.filter((n) => n.title.toLowerCase().includes(q))
  }, [notes, search, activeFolderId, activeTag])

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
    const note = await createNote('', activeFolderId === 'all' ? null : activeFolderId)
    focusTitleOn.current = note.id
    setActiveFileId(null)
    setActiveId(note.id)
    setMobileView('editor')
  }

  const handleSelect = (id: string) => {
    flushSave()
    setActiveFileId(null)
    setActiveId(id)
    setMobileView('editor')
  }

  // 右键菜单「重命名」：选中并聚焦标题输入框
  const handleRenameNote = (id: string) => {
    handleSelect(id)
    focusTitleOn.current = id
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

  const handleSelectFolder = (id: string) => {
    setActiveFolderId(id)
    setSidebarOpen(false)
  }

  const handleCreateFolder = async (name: string) => {
    const folder = await createFolder(name)
    requestPush()
    setActiveFolderId(folder.id)
  }

  const handleRenameFolder = async (id: string, name: string) => {
    await renameFolder(id, name)
    requestPush()
  }

  const handleDeleteFolder = async (id: string) => {
    const folder = folders?.find((f) => f.id === id)
    if (!window.confirm(`删除文件夹「${folder?.name ?? ''}」？其中的笔记会移回全部笔记。`)) return
    await deleteFolder(id)
    if (activeFolderId === id) setActiveFolderId('all')
    requestPush()
  }

  const handleMoveNote = (folderId: string | null) => {
    if (!active) return
    void updateNote(active.id, { folderId }).then(requestPush)
  }

  const handleDropNote = (noteId: string, folderId: string | null) => {
    const note = notes?.find((n) => n.id === noteId)
    if (!note || note.deletedAt !== null || note.folderId === folderId) return
    void updateNote(noteId, { folderId }).then(requestPush)
  }

  const handleToggleTag = (name: string) => {
    setActiveTag((cur) => (cur === name ? null : name))
    setMobileView('list')
  }

  const handleRenameTag = async (oldName: string, newName: string) => {
    const merged = tagCounts.has(newName)
    const msg = merged
      ? `把标签「${oldName}」改名为「${newName}」？两个标签会合并。`
      : `把标签「${oldName}」改名为「${newName}」？所有相关笔记都会更新。`
    if (!window.confirm(msg)) return
    await renameTag(oldName, newName)
    if (activeTag === oldName) setActiveTag(newName)
    requestPush()
  }

  const handleDeleteTag = async (name: string) => {
    if (!window.confirm(`删除标签「${name}」？它会从所有笔记上移除，笔记本身不受影响。`)) return
    await deleteTag(name)
    if (activeTag === name) setActiveTag(null)
    requestPush()
  }

  const handleDropNoteToTag = (noteId: string, tag: string) => {
    void addTagToNote(noteId, tag).then((added) => {
      if (added) requestPush()
    })
  }

  const handleNoteTagsChange = (tags: string[]) => {
    if (!active) return
    void updateNote(active.id, { tags }).then(requestPush)
  }

  const [activeFileId, setActiveFileId] = useState<string | null>(null)
  const activeFile = files?.find((f) => f.id === activeFileId) ?? null
  // 新设备上拉到的文件只有云端元数据：打开查看器时按需下载内容并缓存进 Dexie
  const activeFileIdForEffect = activeFile?.id ?? null
  const activeFileHasData = !!activeFile?.dataUrl
  useEffect(() => {
    if (user && activeFileIdForEffect && !activeFileHasData) {
      void ensureFileData(activeFileIdForEffect)
    }
  }, [user, activeFileIdForEffect, activeFileHasData])

  // 记住最后打开的笔记/文件，下次启动直接恢复（按用户分开存）
  useEffect(() => {
    if (!user) return
    if (activeFileId) {
      localStorage.setItem(lastOpenKey(user.id), JSON.stringify({ kind: 'file', id: activeFileId }))
    } else if (activeId) {
      localStorage.setItem(lastOpenKey(user.id), JSON.stringify({ kind: 'note', id: activeId }))
    }
  }, [user, activeId, activeFileId])

  // 启动时恢复上次打开的笔记/文件（localStorage + Dexie 都是渲染期外部数据，
  // 用「渲染期调整状态」模式一次性恢复，避免 effect 里 setState 触发额外渲染）
  const [restored, setRestored] = useState(false)
  if (!restored && user && notes !== undefined && files !== undefined) {
    setRestored(true)
    try {
      const raw = localStorage.getItem(lastOpenKey(user.id))
      if (raw) {
        const saved = JSON.parse(raw) as { kind: string; id: string }
        if (saved.kind === 'file') {
          const f = files.find((x) => x.id === saved.id && !x.deletedAt)
          if (f) {
            setActiveFileId(f.id)
            if (f.folderId) setActiveFolderId(f.folderId)
          }
        } else {
          const n = notes.find((x) => x.id === saved.id && x.deletedAt === null)
          if (n) {
            setActiveId(n.id)
            if (n.folderId) setActiveFolderId(n.folderId)
          }
        }
      }
    } catch {
      // 本地记录损坏则忽略，保持默认空状态
    }
  }
  // 当前视图里的文件（文件夹内容：md/html 上传会变成笔记，pdf 以文件卡片出现）
  const filesInView = useMemo(
    () =>
      (files ?? [])
        .filter((f) => !f.deletedAt)
        .filter((f) =>
          activeFolderId === 'all'
            ? true
            : activeFolderId === 'none'
              ? (f.folderId ?? null) === null
              : (f.folderId ?? null) === activeFolderId,
        )
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [files, activeFolderId],
  )

  // 上传：pdf 存为当前文件夹的文件；md/html 在当前文件夹新建一篇笔记（文件名作标题）。
  // targetFolderId 由拖放位置决定（侧栏文件夹）；按钮上传则跟随当前视图
  const handleUpload = async (file: File, targetFolderId?: string | null) => {
    const folderId =
      targetFolderId !== undefined
        ? targetFolderId
        : activeFolderId === 'all' || activeFolderId === 'none'
          ? null
          : activeFolderId
    if (kindOfFile(file) === 'binary') {
      await saveFile(file, folderId)
      return
    }
    try {
      const content = await fileToDocJson(file)
      const title = file.name.replace(/\.(md|markdown|html|htm)$/i, '')
      // 必须单事务创建：先建空笔记再补内容会产生两次 liveQuery 通知，
      // 编辑器可能在两次之间挂载拿到空文档，内容被「未保存」保护挡住永远刷不进来
      const note = await createNote(title, folderId, content)
      requestPush()
      setActiveFileId(null)
      setActiveId(note.id)
      setMobileView('editor')
    } catch {
      window.alert(`导入 ${file.name} 失败：无法解析内容`)
    }
  }

  // 文件拖到侧栏文件夹/未归档上移动（笔记拖放走 handleDropNote）
  const handleDropFile = (fileId: string, folderId: string | null) => {
    const file = files?.find((f) => f.id === fileId)
    if (!file || (file.folderId ?? null) === folderId) return
    void moveFile(fileId, folderId)
  }

  // 选中文件：主内容区变成内嵌查看器（与选中笔记同一位置，不弹窗）
  const handleSelectFile = (id: string) => {
    flushSave()
    setActiveId(null)
    setActiveFileId(id)
    setMobileView('editor')
  }

  const handleDeleteFile = async () => {
    if (!activeFile) return
    if (!window.confirm(`删除文件「${activeFile.filename}」？`)) return
    await deleteFile(activeFile.id)
    setActiveFileId(null)
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
        <button
          type="button"
          className="diag-btn"
          title="复制诊断信息（卡死/异常时点这里，把内容发给开发者）"
          onClick={() => {
            void navigator.clipboard.writeText(getDiagnostics())
          }}
        >
          复制诊断
        </button>
        <SyncIndicator status={syncStatus} />
      </header>
      <div className={mobileView === 'editor' ? 'app-main view-editor' : 'app-main'}>
        <Sidebar
          email={user.email ?? ''}
          collapsed={!sidebarOpen}
          folders={folders ?? []}
          counts={folderCounts}
          allCount={notes?.length ?? 0}
          unfiledCount={unfiledCount}
          tags={tagCounts}
          activeFolderId={activeFolderId}
          activeTag={activeTag}
          onSelectFolder={handleSelectFolder}
          onDropNote={handleDropNote}
          onCreateFolder={(name) => void handleCreateFolder(name)}
          onRenameFolder={(id, name) => void handleRenameFolder(id, name)}
          onDeleteFolder={(id) => void handleDeleteFolder(id)}
          onToggleTag={handleToggleTag}
          onRenameTag={(oldName, newName) => void handleRenameTag(oldName, newName)}
          onDeleteTag={(name) => void handleDeleteTag(name)}
          onDropNoteToTag={handleDropNoteToTag}
          onDropFile={handleDropFile}
          onFilesDrop={(dropped, folderId) => {
            for (const file of dropped) void handleUpload(file, folderId)
          }}
          onSignOut={() => void signOut()}
        />
        <NoteList
          notes={visibleNotes}
          files={filesInView}
          activeId={activeId}
          search={search}
          userId={user.id}
          onSearch={setSearch}
          onSelect={handleSelect}
          onCreate={() => void handleCreate()}
          onSelectFile={handleSelectFile}
          onUpload={(file) => void handleUpload(file)}
          onRenameNote={handleRenameNote}
          onRequestPush={requestPush}
          emptyHint={
            activeFolderId === 'all'
              ? '暂无内容'
              : activeFolderId === 'none'
                ? '未归档里还没有内容'
                : '此文件夹还没有内容'
          }
        />
        <main className="editor-pane">
          {activeFile ? (
            <>
              <div className="editor-toolbar">
                <button type="button" className="editor-back" onClick={() => setMobileView('list')}>
                  ← 返回列表
                </button>
                <span className="editor-file-name" title={activeFile.filename}>
                  {activeFile.filename}
                </span>
                <ShareMenu userId={user.id} target={{ kind: 'file', fileId: activeFile.id }} />
                {activeFile.dataUrl && (
                  <a
                    className="editor-file-action"
                    href={activeFile.dataUrl}
                    download={activeFile.filename}
                  >
                    下载
                  </a>
                )}
                <button
                  type="button"
                  className="editor-delete"
                  onClick={() => void handleDeleteFile()}
                >
                  删除
                </button>
              </div>
              <div className="file-view">
                {activeFile.dataUrl ? (
                  <iframe title={activeFile.filename} src={activeFile.dataUrl} className="file-view-frame" />
                ) : (
                  <p className="file-view-fallback">正在从云端加载文件…</p>
                )}
              </div>
            </>
          ) : active ? (
            <>
              <div className="editor-toolbar">
                <button type="button" className="editor-back" onClick={() => setMobileView('list')}>
                  ← 返回列表
                </button>
                <select
                  className="editor-folder"
                  value={active.folderId ?? ''}
                  aria-label="所在文件夹"
                  onChange={(e) => handleMoveNote(e.target.value || null)}
                >
                  <option value="">未归档</option>
                  {(folders ?? []).map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folder.name}
                    </option>
                  ))}
                </select>
                <ShareMenu userId={user.id} target={{ kind: 'note', noteId: active.id }} />
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
                <TagInput
                  key={`tags-${active.id}`}
                  tags={active.tags ?? []}
                  suggestions={[...tagCounts.keys()]}
                  onChange={handleNoteTagsChange}
                />
                <EditorBoundary>
                  <Editor
                    key={active.id}
                    content={active.content}
                    onUpdate={(content) => scheduleSave(active.id, { content })}
                  />
                </EditorBoundary>
              </div>
              <div className="editor-footer">{countWords(active.content)} 字</div>
            </>
          ) : (
            <EmptyState />
          )}
        </main>
      </div>
    </div>
  )
}

