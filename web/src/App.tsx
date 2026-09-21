import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Folder } from './lib/db'
import { Auth } from './components/Auth'
import { Editor } from './components/Editor'
import { EditorBoundary } from './components/EditorBoundary'
import { EmptyState } from './components/EmptyState'
import { NoteList } from './components/NoteList'

// PDF 查看器（pdf.js 体积大，懒加载：只在打开 PDF 时才下载）
const PdfViewer = lazy(() =>
  import('./components/PdfViewer').then((m) => ({ default: m.PdfViewer })),
)
import { HtmlViewer } from './components/HtmlViewer'
import { TagPicker } from './components/TagPicker'
import { TabBar } from './components/TabBar'
import { Sidebar } from './components/Sidebar'
import { SyncIndicator } from './components/SyncIndicator'
import { useAuth } from './hooks/useAuth'
import { useSync } from './hooks/useSync'
import { createNote, softDeleteNote, updateNote } from './store/notes'
import { createFolder, deleteFolder, moveFolder, renameFolder } from './store/folders'
import { addTagToNote, deleteTag, renameTag } from './store/tags'
import { deleteFile, ensureFileData, moveFile, renameFile, saveFile, setFileTags } from './store/files'
import { loadPrefs, savePrefs, type TabItem } from './store/prefs'
import { applyTheme, isValidTheme, storedTheme, DEFAULT_THEME } from './lib/theme'
import { ShareMenu } from './components/ShareMenu'
import { NoteMoreMenu } from './components/NoteMoreMenu'
import { fileDownloadName, fileToDocJson, isHtmlFile, kindOfFile } from './lib/importFile'
import { exportNoteToImage, exportNoteToMarkdown, printNoteToPdf } from './lib/exportNote'
import { countWords } from './lib/wordCount'
import { setActiveEdit } from './sync/syncEngine'
import { DialogHost } from './components/Dialog'
import { alertDialog, confirmDialog } from './lib/dialog'
import { plainTextOf } from './lib/search'
import { migrateInlineImages, noteImageSrcs } from './store/images'
import './App.css'

const lastOpenKey = (userId: string) => `inkflow:lastOpen:${userId}`
const tabsStorageKey = (userId: string) => `inkflow:tabs:${userId}`

function IconTrash() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6" />
    </svg>
  )
}

function IconDownload() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14M5 12l7 7 7-7" />
      <path d="M4 21h16" />
    </svg>
  )
}

function IconSidebar() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </svg>
  )
}

function IconNoteList() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
      <path d="M15 3v18" />
    </svg>
  )
}

function IconMaximize() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
    </svg>
  )
}

function IconMinimize() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
    </svg>
  )
}

const DESKTOP_SIDEBAR_KEY = 'inkflow:desktop:sidebarCollapsed'
const DESKTOP_NOTELIST_KEY = 'inkflow:desktop:noteListCollapsed'

// 文件夹的祖先路径名（如「课程 / 数学」），找不到返回 null
function folderPathNames(id: string, folders: { id: string; name: string; parentId: string | null }[]): string | null {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const names: string[] = []
  let cur = byId.get(id) ?? null
  let guard = 0
  while (cur && guard++ < 20) {
    names.unshift(cur.name)
    cur = cur.parentId ? (byId.get(cur.parentId) ?? null) : null
  }
  return names.length ? names.join(' / ') : null
}

export default function App() {
  const { user, loading, signOut } = useAuth()
  const { status: syncStatus, requestPush } = useSync(user)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [activeFileId, setActiveFileId] = useState<string | null>(null)
  const [tabs, setTabs] = useState<TabItem[]>([])
  const [activeFolderId, setActiveFolderId] = useState<string>('all')
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [mobileView, setMobileView] = useState<'list' | 'editor'>('list')
  // 电脑端侧栏折叠状态：默认从 localStorage 读取
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DESKTOP_SIDEBAR_KEY) === 'true'
    } catch {
      return false
    }
  })
  const [desktopNoteListCollapsed, setDesktopNoteListCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DESKTOP_NOTELIST_KEY) === 'true'
    } catch {
      return false
    }
  })

  // 当没有打开任何笔记或文件时，自动保证列表可见，避免空状态界面
  const isNoteListEffectivelyCollapsed = desktopNoteListCollapsed && (activeId !== null || activeFileId !== null)
  const isContentFullScreen = desktopSidebarCollapsed && isNoteListEffectivelyCollapsed

  const toggleDesktopSidebar = () => {
    setDesktopSidebarCollapsed((prev) => {
      const next = !prev
      try {
        localStorage.setItem(DESKTOP_SIDEBAR_KEY, String(next))
      } catch {}
      return next
    })
  }

  const toggleDesktopNoteList = () => {
    setDesktopNoteListCollapsed((prev) => {
      const next = !prev
      try {
        localStorage.setItem(DESKTOP_NOTELIST_KEY, String(next))
      } catch {}
      return next
    })
  }

  const toggleFullscreen = useCallback(() => {
    if (!activeId && !activeFileId) return
    if (isContentFullScreen) {
      setDesktopSidebarCollapsed(false)
      setDesktopNoteListCollapsed(false)
      try {
        localStorage.setItem(DESKTOP_SIDEBAR_KEY, 'false')
        localStorage.setItem(DESKTOP_NOTELIST_KEY, 'false')
      } catch {}
    } else {
      setDesktopSidebarCollapsed(true)
      setDesktopNoteListCollapsed(true)
      try {
        localStorage.setItem(DESKTOP_SIDEBAR_KEY, 'true')
        localStorage.setItem(DESKTOP_NOTELIST_KEY, 'true')
      } catch {}
    }
  }, [activeId, activeFileId, isContentFullScreen])

  // 格式工具栏隐藏偏好：全局（任意笔记隐藏 = 全部隐藏），登录后从云端加载、切换即保存
  const [toolbarHidden, setToolbarHidden] = useState(false)
  // 主题：本机即选即生效（localStorage），登录后若本机从未选过则采纳云端
  const [theme, setTheme] = useState(() => storedTheme() ?? DEFAULT_THEME)
  const titleRef = useRef<HTMLTextAreaElement>(null)
  const titleFocusSeq = useRef(0)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSave = useRef<{ id: string; patch: { title?: string; content?: unknown } } | null>(null)

  const notes = useLiveQuery(
    () => db.notes.orderBy('updatedAt').reverse().filter((n) => n.deletedAt === null).toArray(),
    [],
  )

  useEffect(() => {
    if (!user) return
    let cancelled = false
    void loadPrefs()
      .then((p) => {
        if (cancelled) return
        setToolbarHidden(p.toolbarHidden)
        // 本机没选过主题（新设备）→ 跟随账号的云端主题
        if (!storedTheme() && isValidTheme(p.theme)) {
          applyTheme(p.theme)
          setTheme(p.theme)
        }
        // 若云端有 tabs，且本地尚未有有效 tabs，则从云端恢复
        if (Array.isArray(p.tabs) && p.tabs.length > 0) {
          setTabs((cur) => {
            if (cur.length > 0) return cur
            return p.tabs!
          })
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [user])

  const toggleToolbar = () => {
    setToolbarHidden((cur) => {
      const next = !cur
      void savePrefs({ toolbarHidden: next, theme }).catch(() => {})
      return next
    })
  }

  // 切主题：本机立即生效并记住，同时随账号存到云端（新设备首次登录会带上）
  const changeTheme = (id: string) => {
    if (id === theme) return
    applyTheme(id)
    setTheme(id)
    void savePrefs({ toolbarHidden, theme: id }).catch(() => {})
  }

  const folders = useLiveQuery(async () => {
    const all = await db.folders.filter((f) => f.deletedAt === null).toArray()
    return all.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  }, [])

  const files = useLiveQuery(() => db.files.toArray(), [])
  const activeFile = files?.find((f) => f.id === activeFileId) ?? null

  const folderCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of notes ?? []) {
      if (n.folderId) m.set(n.folderId, (m.get(n.folderId) ?? 0) + 1)
    }
    for (const f of files ?? []) {
      if (f.folderId) m.set(f.folderId, (m.get(f.folderId) ?? 0) + 1)
    }
    return m
  }, [notes, files])

  // 子文件夹树：按父级分组（每层内按中文拼音排序）
  const folderChildren = useMemo(() => {
    const m = new Map<string | null, Folder[]>()
    for (const f of folders ?? []) {
      const key = f.parentId ?? null
      const list = m.get(key) ?? []
      list.push(f)
      m.set(key, list)
    }
    for (const list of m.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    }
    return m
  }, [folders])

  // 每个文件夹的子树项目总数（含所有后代文件夹，同时计入笔记与文件）
  const subtreeCounts = useMemo(() => {
    const counts = new Map<string, number>()
    const dfs = (id: string): number => {
      let c = folderCounts.get(id) ?? 0
      for (const ch of folderChildren.get(id) ?? []) c += dfs(ch.id)
      counts.set(id, c)
      return c
    }
    for (const f of folders ?? []) dfs(f.id)
    return counts
  }, [folders, folderChildren, folderCounts])

  // 当前选中文件夹的子树 id 集合（null = 全部笔记，不过滤）
  const activeFolderSubtree = useMemo(() => {
    if (activeFolderId === 'all') return null
    const set = new Set<string>([activeFolderId])
    const walk = (id: string) => {
      for (const ch of folderChildren.get(id) ?? []) {
        set.add(ch.id)
        walk(ch.id)
      }
    }
    walk(activeFolderId)
    return set
  }, [activeFolderId, folderChildren])

  // 搜索命中文件夹名时，其整棵子树的内容也进结果；命中的文件夹单独列出供点击跳转
  const folderHitSubtree = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return null
    const set = new Set<string>()
    const collect = (id: string) => {
      for (const ch of folderChildren.get(id) ?? []) {
        set.add(ch.id)
        collect(ch.id)
      }
    }
    for (const f of folders ?? []) {
      if (f.name.toLowerCase().includes(q)) {
        set.add(f.id)
        collect(f.id)
      }
    }
    return set.size ? set : null
  }, [search, folders, folderChildren])

  const folderHits = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return []
    return (folders ?? [])
      .filter((f) => f.name.toLowerCase().includes(q))
      .map((f) => {
        const path = folderPathNames(f.id, folders ?? []) ?? f.name
        return { id: f.id, name: f.name, path }
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  }, [search, folders])

  const tagCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of notes ?? []) {
      for (const t of n.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1)
    }
    for (const f of files ?? []) {
      if (f.deletedAt) continue
      for (const t of f.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1)
    }
    return new Map([...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN')))
  }, [notes, files])

  const visibleNotes = useMemo(() => {
    const all = notes ?? []
    const q = search.trim().toLowerCase()
    // 「默认」= 未归入任何文件夹的笔记；文件夹视图 = 该文件夹（含子树）
    const inScope = (n: (typeof all)[number]) =>
      activeFolderSubtree === null ? n.folderId === null : activeFolderSubtree.has(n.folderId ?? '')
    let scoped = q || activeTag ? all : all.filter(inScope)
    if (!q && activeTag) scoped = scoped.filter((n) => (n.tags ?? []).includes(activeTag))
    if (!q) return scoped
    // 标题/正文命中，或所属文件夹（含子树）名命中
    return scoped.filter(
      (n) =>
        n.title.toLowerCase().includes(q) ||
        plainTextOf(n.content).toLowerCase().includes(q) ||
        (n.folderId !== null && folderHitSubtree !== null && folderHitSubtree.has(n.folderId)),
    )
  }, [notes, search, activeFolderSubtree, activeTag, folderHitSubtree])

  const active = notes?.find((n) => n.id === activeId) ?? null

  useEffect(() => {
    setActiveEdit(activeId)
    return () => setActiveEdit(null)
  }, [activeId])

  // 标题聚焦请求：新建/重命名时置为目标 id，等该笔记渲染出来后聚焦并全选。
  // 必须用 state 而非 ref——重命名「当前已打开的笔记」时 activeId 不变，
  // 纯 ref 方案依赖的 effect 不会重跑，聚焦永远不触发。
  // n 是递增序号，appliedFocusN 保证一次请求只聚焦一次（切换走再切回不重复聚焦）
  const [titleFocusReq, setTitleFocusReq] = useState<{ id: string; n: number } | null>(null)
  const appliedFocusN = useRef(0)
  useEffect(() => {
    if (
      titleFocusReq &&
      titleFocusReq.n !== appliedFocusN.current &&
      activeId === titleFocusReq.id &&
      active
    ) {
      appliedFocusN.current = titleFocusReq.n
      titleRef.current?.focus()
      titleRef.current?.select()
    }
  }, [titleFocusReq, activeId, active])

  // 标题输入框自动增高：长标题换行后撑高，始终完整可见
  const autosizeTitle = useCallback(() => {
    const el = titleRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [])

  useEffect(() => {
    const el = titleRef.current
    if (el && active && el.value !== active.title) {
      el.value = active.title
    }
    autosizeTitle()
  }, [active, autosizeTitle])

  // 宽度变化（窗口缩放/折叠侧栏）时行数会变，重算高度
  useEffect(() => {
    const onResize = () => autosizeTitle()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [autosizeTitle])

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [])

  // Ctrl/Cmd + F 聚焦笔记搜索（全局，编辑中也能用）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        document.getElementById('note-search')?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Ctrl/Cmd + \ 切换全屏，Esc 退出全屏
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '\\') {
        e.preventDefault()
        toggleFullscreen()
      } else if (e.key === 'Escape' && isContentFullScreen) {
        e.preventDefault()
        setDesktopSidebarCollapsed(false)
        setDesktopNoteListCollapsed(false)
        try {
          localStorage.setItem(DESKTOP_SIDEBAR_KEY, 'false')
          localStorage.setItem(DESKTOP_NOTELIST_KEY, 'false')
        } catch {}
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isContentFullScreen, toggleFullscreen])

  // 存量图片迁移（每次启动跑一次）：正文里的 data URL 图片上传到 Storage 并替换为
  // 公共 URL，笔记标脏走正常同步。后台分批进行，不阻塞界面；失败的笔记下次启动再试。
  const migratedRef = useRef(false)
  useEffect(() => {
    if (!user || migratedRef.current || notes === undefined) return
    migratedRef.current = true
    const targets = notes.filter((n) => noteImageSrcs(n.content).some((s) => s.startsWith('data:')))
    void (async () => {
      for (const note of targets) {
        try {
          const next = await migrateInlineImages(note.content)
          if (next !== note.content) {
            await updateNote(note.id, { content: next })
            requestPush()
          }
        } catch (err) {
          console.error('migrate note images failed', note.id, err)
        }
        await new Promise((r) => setTimeout(r, 50))
      }
    })()
  }, [user, notes, requestPush])

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
    setTitleFocusReq({ id: note.id, n: ++titleFocusSeq.current })
    setTabs((prev) => [...prev, { kind: 'note', id: note.id }])
    setActiveFileId(null)
    setActiveId(note.id)
    setMobileView('editor')
  }

  const handleSelect = (id: string) => {
    flushSave()
    setTabs((prev) => {
      if (prev.some((t) => t.kind === 'note' && t.id === id)) return prev
      return [...prev, { kind: 'note', id }]
    })
    setActiveFileId(null)
    setActiveId(id)
    setMobileView('editor')
  }

  const handleSelectTab = (tab: TabItem) => {
    flushSave()
    if (tab.kind === 'note') {
      setActiveFileId(null)
      setActiveId(tab.id)
    } else {
      setActiveId(null)
      setActiveFileId(tab.id)
    }
    setMobileView('editor')
  }

  const handleCloseTab = (tabId: string) => {
    flushSave()
    const targetIndex = tabs.findIndex((t) => t.id === tabId)
    if (targetIndex === -1) return

    const nextTabs = tabs.filter((t) => t.id !== tabId)
    setTabs(nextTabs)

    const isClosingActive = activeId === tabId || activeFileId === tabId
    if (isClosingActive) {
      if (nextTabs.length === 0) {
        setActiveId(null)
        setActiveFileId(null)
      } else {
        const nextActiveIndex = Math.min(targetIndex, nextTabs.length - 1)
        const nextActive = nextTabs[nextActiveIndex]
        if (nextActive.kind === 'note') {
          setActiveFileId(null)
          setActiveId(nextActive.id)
        } else {
          setActiveId(null)
          setActiveFileId(nextActive.id)
        }
      }
    }
  }

  const handleCloseOtherTabs = (tabId: string) => {
    flushSave()
    const kept = tabs.find((t) => t.id === tabId)
    if (!kept) return
    setTabs([kept])
    if (kept.kind === 'note') {
      setActiveFileId(null)
      setActiveId(kept.id)
    } else {
      setActiveId(null)
      setActiveFileId(kept.id)
    }
  }

  const handleCloseAllTabs = () => {
    flushSave()
    setTabs([])
    setActiveId(null)
    setActiveFileId(null)
  }

  // 右键菜单「重命名」：选中并聚焦标题输入框
  const handleRenameNote = (id: string) => {
    handleSelect(id)
    setTitleFocusReq({ id, n: ++titleFocusSeq.current })
  }

  // 右键菜单「重命名」PDF 文件
  const handleRenameFile = (id: string, filename: string) => {
    void renameFile(id, filename).then(requestPush)
  }

  const handleDelete = async () => {
    if (!active) return
    const ok = await confirmDialog({ title: '删除笔记', message: '删除这篇笔记？', confirmText: '删除', danger: true })
    if (!ok) return
    flushSave()
    const delId = active.id
    await softDeleteNote(delId)
    requestPush()
    handleCloseTab(delId)
    setMobileView('list')
  }

  const handleSelectFolder = (id: string) => {
    setActiveFolderId(id)
    setActiveTag(null)
    setSidebarOpen(false)
    // 手机上选文件夹=切换浏览上下文：从笔记里跳回列表（与侧栏选标签的行为一致）
    setMobileView('list')
    setDesktopNoteListCollapsed(false)
  }

  // 点击搜索结果里的文件夹：跳转进去并清空搜索/标签筛选
  const handleSelectFolderHit = (id: string) => {
    setActiveTag(null)
    setSearch('')
    setActiveFolderId(id)
    setSidebarOpen(false)
    setMobileView('list')
    setDesktopNoteListCollapsed(false)
  }

  // 跳到笔记/文件所在文件夹（保留打开的内容，只切换列表上下文）
  const handleGotoFolder = (folderId: string) => {
    setActiveTag(null)
    setSearch('')
    setActiveFolderId(folderId)
    setSidebarOpen(false)
  }

  const handleCreateFolder = async (name: string, parentId: string | null = null) => {
    const folder = await createFolder(name, parentId)
    requestPush()
    setActiveFolderId(folder.id)
  }

  // 文件夹拖到另一个文件夹上 = 变成其子文件夹；拖到「全部笔记」= 移回顶层。
  // 禁止移进自己或自己的后代（会形成环）。
  const handleDropFolder = (folderId: string, targetParentId: string | null) => {
    if (folderId === targetParentId) return
    const isSelfOrDescendant = (pid: string | null): boolean => {
      if (!pid) return false
      if (pid === folderId) return true
      const parent = folders?.find((f) => f.id === pid)
      return parent ? isSelfOrDescendant(parent.parentId ?? null) : false
    }
    if (isSelfOrDescendant(targetParentId)) return
    void moveFolder(folderId, targetParentId)
    requestPush()
  }

  const handleRenameFolder = async (id: string, name: string) => {
    await renameFolder(id, name)
    requestPush()
  }

  const handleDeleteFolder = async (id: string) => {
    const folder = folders?.find((f) => f.id === id)
    const ok = await confirmDialog({
      title: '删除文件夹',
      message: `删除文件夹「${folder?.name ?? ''}」？其中的笔记会保留在全部笔记，子文件夹会上移到上一层。`,
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    await deleteFolder(id)
    if (activeFolderSubtree?.has(id)) setActiveFolderId('all')
    requestPush()
  }

  const handleDropNote = (noteId: string, folderId: string | null) => {
    const note = notes?.find((n) => n.id === noteId)
    if (!note || note.deletedAt !== null || note.folderId === folderId) return
    void updateNote(noteId, { folderId }).then(requestPush)
  }

  const handleToggleTag = (name: string) => {
    setActiveTag((cur) => (cur === name ? null : name))
    setMobileView('list')
    setDesktopNoteListCollapsed(false)
  }

  const handleRenameTag = async (oldName: string, newName: string) => {
    const merged = tagCounts.has(newName)
    const ok = await confirmDialog({
      title: merged ? '合并标签' : '重命名标签',
      message: merged
        ? `把标签「${oldName}」改名为「${newName}」？两个标签会合并。`
        : `把标签「${oldName}」改名为「${newName}」？所有相关笔记都会更新。`,
    })
    if (!ok) return
    await renameTag(oldName, newName)
    if (activeTag === oldName) setActiveTag(newName)
    requestPush()
  }

  const handleDeleteTag = async (name: string) => {
    const ok = await confirmDialog({
      title: '删除标签',
      message: `删除标签「${name}」？它会从所有笔记上移除，笔记本身不受影响。`,
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
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

  const handleFileTagsChange = (tags: string[]) => {
    if (!activeFile) return
    void setFileTags(activeFile.id, tags).then(requestPush)
  }

  // 新设备上拉到的文件只有云端元数据：打开查看器时按需下载内容并缓存进 Dexie
  const activeFileIdForEffect = activeFile?.id ?? null
  const activeFileHasData = !!activeFile?.dataUrl
  useEffect(() => {
    if (user && activeFileIdForEffect && !activeFileHasData) {
      void ensureFileData(activeFileIdForEffect)
    }
  }, [user, activeFileIdForEffect, activeFileHasData])

  // 过滤掉已被删除或不存在的笔记/文件标签项
  const validTabs = useMemo(() => {
    if (!notes && !files) return tabs
    return tabs.filter((t) => {
      if (t.kind === 'note') {
        return !notes || notes.some((x) => x.id === t.id && x.deletedAt === null)
      } else {
        return !files || files.some((x) => x.id === t.id && !x.deletedAt)
      }
    })
  }, [tabs, notes, files])

  // 启动时恢复上次打开的标签页（localStorage + Dexie 都是渲染期外部数据，
  // 用「渲染期调整状态」模式一次性恢复，避免 effect 里 setState 触发额外渲染）
  const [restored, setRestored] = useState(false)
  if (!restored && user && notes !== undefined && files !== undefined) {
    setRestored(true)
    try {
      let loadedTabs: TabItem[] = []
      let loadedActiveTabId: string | null = null
      const raw = localStorage.getItem(tabsStorageKey(user.id))
      if (raw) {
        const parsed = JSON.parse(raw) as { tabs?: TabItem[]; activeTabId?: string | null }
        if (Array.isArray(parsed.tabs)) {
          loadedTabs = parsed.tabs
          loadedActiveTabId = parsed.activeTabId ?? null
        }
      }
      // 兼容旧版单一记录
      if (loadedTabs.length === 0) {
        const oldRaw = localStorage.getItem(lastOpenKey(user.id))
        if (oldRaw) {
          const saved = JSON.parse(oldRaw) as { kind: string; id: string }
          if (saved.kind === 'file' || saved.kind === 'note') {
            loadedTabs = [{ kind: saved.kind, id: saved.id }]
            loadedActiveTabId = saved.id
          }
        }
      }

      const initialValid = loadedTabs.filter((t) => {
        if (t.kind === 'file') {
          return files.some((x) => x.id === t.id && !x.deletedAt)
        } else {
          return notes.some((x) => x.id === t.id && x.deletedAt === null)
        }
      })

      if (initialValid.length > 0) {
        setTabs(initialValid)
        const activeItem = initialValid.find((t) => t.id === loadedActiveTabId) || initialValid[0]
        if (activeItem.kind === 'file') {
          const f = files.find((x) => x.id === activeItem.id)
          if (f) {
            setActiveFileId(f.id)
            if (f.folderId) setActiveFolderId(f.folderId)
          }
        } else {
          const n = notes.find((x) => x.id === activeItem.id)
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

  // 标签页持久化：保存到 localStorage，并防抖同步到云端 user_prefs
  const savePrefsTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!user || !restored) return
    const activeTabId = activeFileId || activeId
    try {
      localStorage.setItem(
        tabsStorageKey(user.id),
        JSON.stringify({ tabs: validTabs, activeTabId }),
      )
    } catch {}

    if (savePrefsTimer.current) clearTimeout(savePrefsTimer.current)
    savePrefsTimer.current = setTimeout(() => {
      void savePrefs({
        toolbarHidden,
        theme,
        tabs: validTabs,
        activeTabId,
      }).catch(() => {})
    }, 600)

    return () => {
      if (savePrefsTimer.current) clearTimeout(savePrefsTimer.current)
    }
  }, [user, restored, validTabs, activeId, activeFileId, toolbarHidden, theme])

  // 当前视图里的文件。「默认」= 无文件夹的文件；文件夹视图 = 该文件夹（含子树）
  // 有搜索词时跨全部范围：文件名命中，或所属文件夹（含子树）名命中；
  // 标签视图 = 全库范围内挂了该标签的文件（与笔记共用标签命名空间）
  const filesInView = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (activeTag) {
      return (files ?? [])
        .filter((f) => !f.deletedAt && (f.tags ?? []).includes(activeTag))
        .sort((a, b) => b.updatedAt - a.updatedAt)
    }
    const inScope = (folderId: string | null) =>
      activeFolderSubtree === null ? folderId === null : folderId !== null && activeFolderSubtree.has(folderId)
    return (files ?? [])
      .filter((f) => !f.deletedAt)
      .filter((f) => (q ? true : inScope(f.folderId ?? null)))
      .filter(
        (f) =>
          !q ||
          f.filename.toLowerCase().includes(q) ||
          ((f.folderId ?? null) !== null && folderHitSubtree !== null && folderHitSubtree.has(f.folderId as string)),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [files, activeFolderSubtree, search, folderHitSubtree, activeTag])

  // 上传：pdf/html 存为当前文件夹的文件（原生预览）；md 在当前文件夹新建一篇笔记（文件名作标题）。
  // targetFolderId 由拖放位置决定（侧栏文件夹）；按钮上传则跟随当前视图
  const handleUpload = async (file: File, targetFolderId?: string | null) => {
    const folderId = targetFolderId !== undefined ? targetFolderId : activeFolderId === 'all' ? null : activeFolderId
    const kind = kindOfFile(file)
    if (kind === 'binary' || kind === 'html') {
      const saved = await saveFile(file, folderId)
      setTabs((prev) => [...prev, { kind: 'file', id: saved.id }])
      setActiveId(null)
      setActiveFileId(saved.id)
      setMobileView('editor')
      return
    }
    try {
      const content = await fileToDocJson(file)
      const title = file.name.replace(/\.(md|markdown|html|htm)$/i, '')
      // 必须单事务创建：先建空笔记再补内容会产生两次 liveQuery 通知，
      // 编辑器可能在两次之间挂载拿到空文档，内容被「未保存」保护挡住永远刷不进来
      const note = await createNote(title, folderId, content)
      requestPush()
      setTabs((prev) => [...prev, { kind: 'note', id: note.id }])
      setActiveFileId(null)
      setActiveId(note.id)
      setMobileView('editor')
    } catch {
      await alertDialog({ title: '导入失败', message: `导入 ${file.name} 失败：无法解析内容` })
    }
  }

  // 文件拖到侧栏文件夹/「全部笔记」上移动（笔记拖放走 handleDropNote）
  const handleDropFile = (fileId: string, folderId: string | null) => {
    const file = files?.find((f) => f.id === fileId)
    if (!file || (file.folderId ?? null) === folderId) return
    void moveFile(fileId, folderId)
  }

  // 选中文件：主内容区变成内嵌查看器（与选中笔记同一位置，不弹窗）
  const handleSelectFile = (id: string) => {
    flushSave()
    setTabs((prev) => {
      if (prev.some((t) => t.kind === 'file' && t.id === id)) return prev
      return [...prev, { kind: 'file', id }]
    })
    setActiveId(null)
    setActiveFileId(id)
    setMobileView('editor')
  }

  const handleDeleteFile = async () => {
    if (!activeFile) return
    const ok = await confirmDialog({
      title: '删除文件',
      message: `删除文件「${activeFile.filename}」？`,
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    const delId = activeFile.id
    await deleteFile(delId)
    handleCloseTab(delId)
  }

  const [isExportingImage, setIsExportingImage] = useState(false)

  const handleExportMarkdown = () => {
    if (!active) return
    exportNoteToMarkdown(active.title || '无标题', active.content)
  }

  const handleExportPdf = () => {
    if (!active) return
    const bodyEl = document.querySelector<HTMLElement>('.editor-body .ProseMirror')
    if (!bodyEl) return
    printNoteToPdf(active.title || '无标题', bodyEl)
  }

  const handleExportImage = async () => {
    if (!active) return
    const bodyEl = document.querySelector<HTMLElement>('.editor-body .ProseMirror')
    if (!bodyEl) return
    setIsExportingImage(true)
    try {
      await exportNoteToImage(active.title || '无标题', bodyEl)
    } catch (err) {
      console.error('export image failed', err)
      await alertDialog({ title: '导出失败', message: '生成高清长图失败，请重试' })
    } finally {
      setIsExportingImage(false)
    }
  }

  if (loading) {
    return <div className="app-shell" style={{ alignItems: 'center', justifyContent: 'center' }}>载入中…</div>
  }

  if (!user) return <Auth />

  return (
    <div className={['app-shell', mobileView === 'editor' ? 'mobile-editor' : 'mobile-list'].join(' ')}>
      <header className="app-topbar">
        <div className="app-topbar-left">
          <button
            type="button"
            className="app-menu"
            aria-label="打开侧栏"
            onClick={() => setSidebarOpen((v) => !v)}
          >
            ☰
          </button>
          <button
            type="button"
            className="app-topbar-back"
            onClick={() => setMobileView('list')}
          >
            ← 列表
          </button>
          <div className="app-topbar-desktop-tools">
            <button
              type="button"
              className={desktopSidebarCollapsed ? 'app-topbar-btn active' : 'app-topbar-btn'}
              title={desktopSidebarCollapsed ? '展开文件夹侧栏' : '折叠文件夹侧栏'}
              aria-label={desktopSidebarCollapsed ? '展开文件夹侧栏' : '折叠文件夹侧栏'}
              aria-pressed={desktopSidebarCollapsed}
              onClick={toggleDesktopSidebar}
            >
              <IconSidebar />
            </button>
            <button
              type="button"
              className={isNoteListEffectivelyCollapsed ? 'app-topbar-btn active' : 'app-topbar-btn'}
              title={isNoteListEffectivelyCollapsed ? '展开笔记列表' : '折叠笔记列表'}
              aria-label={isNoteListEffectivelyCollapsed ? '展开笔记列表' : '折叠笔记列表'}
              aria-pressed={isNoteListEffectivelyCollapsed}
              onClick={toggleDesktopNoteList}
            >
              <IconNoteList />
            </button>
          </div>
        </div>

        <div className="app-topbar-center">
          <span className="app-topbar-mobile-title">
            {activeTag
              ? `# ${activeTag}`
              : activeFolderId === 'all'
                ? '默认'
                : (folderPathNames(activeFolderId, folders ?? []) ?? '默认')}
          </span>
          {validTabs.length > 0 ? (
            <TabBar
              tabs={validTabs}
              activeTabId={activeFileId || activeId}
              notes={notes}
              files={files}
              onSelectTab={handleSelectTab}
              onCloseTab={handleCloseTab}
              onCloseOtherTabs={handleCloseOtherTabs}
              onCloseAllTabs={handleCloseAllTabs}
              onNewNote={() => void handleCreate()}
            />
          ) : (
            <div className="app-topbar-empty">
              <span className="app-view-title">
                {activeTag
                  ? `# ${activeTag}`
                  : activeFolderId === 'all'
                    ? '默认'
                    : (folderPathNames(activeFolderId, folders ?? []) ?? '默认')}
              </span>
              <button
                type="button"
                className="tab-new-btn"
                title="新建笔记"
                onClick={() => void handleCreate()}
              >
                +
              </button>
            </div>
          )}
        </div>

        <div className="app-topbar-right">
          {activeFile ? (
            <>
              <TagPicker
                tags={activeFile.tags ?? []}
                suggestions={[...tagCounts.keys()]}
                onChange={handleFileTagsChange}
              />
              <ShareMenu userId={user.id} target={{ kind: 'file', fileId: activeFile.id }} />
              {activeFile.dataUrl && (
                <a
                  className="tool-btn"
                  href={activeFile.dataUrl}
                  download={fileDownloadName(activeFile)}
                  title="下载"
                >
                  <IconDownload />
                  <span>下载</span>
                </a>
              )}
              <button
                type="button"
                className={isContentFullScreen ? 'tool-btn active-tool fullscreen-toggle' : 'tool-btn fullscreen-toggle'}
                title={isContentFullScreen ? '退出全屏 (展开侧栏) (Esc)' : '全屏显示 (折叠侧栏) (Ctrl+\\)'}
                aria-label={isContentFullScreen ? '退出全屏' : '全屏显示'}
                aria-pressed={isContentFullScreen}
                onClick={toggleFullscreen}
              >
                {isContentFullScreen ? <IconMinimize /> : <IconMaximize />}
                <span>{isContentFullScreen ? '退出全屏' : '全屏'}</span>
              </button>
              <button
                type="button"
                className="tool-btn danger"
                title="删除"
                onClick={() => void handleDeleteFile()}
              >
                <IconTrash />
                <span>删除</span>
              </button>
            </>
          ) : active ? (
            <>
              <button
                type="button"
                className={toolbarHidden ? 'tool-btn active-tool' : 'tool-btn'}
                title={toolbarHidden ? '显示格式栏' : '隐藏格式栏'}
                aria-label={toolbarHidden ? '显示格式栏' : '隐藏格式栏'}
                aria-pressed={toolbarHidden}
                onClick={toggleToolbar}
              >
                Aa
              </button>
              <TagPicker
                tags={active.tags ?? []}
                suggestions={[...tagCounts.keys()]}
                onChange={handleNoteTagsChange}
              />
              <ShareMenu userId={user.id} target={{ kind: 'note', noteId: active.id }} />
              <NoteMoreMenu
                onExportMarkdown={handleExportMarkdown}
                onExportPdf={handleExportPdf}
                onExportImage={() => void handleExportImage()}
                isFullScreen={isContentFullScreen}
                onToggleFullscreen={toggleFullscreen}
                onDeleteNote={() => void handleDelete()}
                isExportingImage={isExportingImage}
              />
            </>
          ) : null}
          <SyncIndicator status={syncStatus} />
        </div>
      </header>
      <div
        className={[
          'app-main',
          mobileView === 'editor' ? 'view-editor' : '',
          desktopSidebarCollapsed ? 'sidebar-collapsed' : '',
          isNoteListEffectivelyCollapsed ? 'notelist-collapsed' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <Sidebar
          email={user.email ?? ''}
          collapsed={!sidebarOpen}
          folders={folders ?? []}
          counts={subtreeCounts}
          allCount={
            (notes ?? []).filter((n) => n.folderId === null).length +
            (files ?? []).filter((f) => f.folderId === null).length
          }
          tags={tagCounts}
          activeFolderId={activeFolderId}
          activeTag={activeTag}
          onSelectFolder={handleSelectFolder}
          onDropNote={handleDropNote}
          onCreateFolder={(name, parentId) => void handleCreateFolder(name, parentId)}
          onRenameFolder={(id, name) => void handleRenameFolder(id, name)}
          onDeleteFolder={(id) => void handleDeleteFolder(id)}
          onDropFolder={handleDropFolder}
          onToggleTag={handleToggleTag}
          onRenameTag={(oldName, newName) => void handleRenameTag(oldName, newName)}
          onDeleteTag={(name) => void handleDeleteTag(name)}
          onDropNoteToTag={handleDropNoteToTag}
          onDropFile={handleDropFile}
          onFilesDrop={(dropped, folderId) => {
            for (const file of dropped) void handleUpload(file, folderId)
          }}
          theme={theme}
          onThemeChange={changeTheme}
          onSignOut={() => void signOut()}
        />
        <NoteList
          notes={visibleNotes}
          files={filesInView}
          folders={folders ?? []}
          folderHits={folderHits}
          activeId={activeId}
          search={search}
          userId={user.id}
          onSearch={setSearch}
          onSelectFolderHit={handleSelectFolderHit}
          folderPathOf={(id) => folderPathNames(id, folders ?? [])}
          onGotoFolder={handleGotoFolder}
          onSelect={handleSelect}
          onCreate={() => void handleCreate()}
          onSelectFile={handleSelectFile}
          onUpload={(file) => void handleUpload(file)}
          onRenameNote={handleRenameNote}
          onRenameFile={handleRenameFile}
          onMoveNote={handleDropNote}
          onMoveFile={handleDropFile}
          onRequestPush={requestPush}
          emptyHint={activeFolderId === 'all' ? '暂无内容' : '此文件夹还没有内容'}
        />
        <main
          className="editor-pane"
          onDragOver={(e) => {
            // 外部文件拖入整个内容区都允许放置（浏览器默认会拦截导航）
            if (e.dataTransfer.types.includes('Files')) e.preventDefault()
          }}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return
            e.preventDefault()
            for (const f of Array.from(e.dataTransfer.files)) void handleUpload(f)
          }}
        >
          {activeFile ? (
            <div className="file-view">
              {activeFile.dataUrl ? (
                isHtmlFile(activeFile) ? (
                  <HtmlViewer src={activeFile.dataUrl} />
                ) : (
                  <Suspense fallback={<p className="file-view-fallback">正在加载…</p>}>
                    <PdfViewer src={activeFile.dataUrl} />
                  </Suspense>
                )
              ) : (
                <p className="file-view-fallback">正在从云端加载文件…</p>
              )}
            </div>
          ) : active ? (
            <>
              <div className="editor-scroll">
                <div className="editor-head">
                  <textarea
                    key={`title-${active.id}`}
                    ref={titleRef}
                    rows={1}
                    className="editor-title"
                    defaultValue={active.title}
                    placeholder="无标题"
                    aria-label="笔记标题"
                    onChange={(e) => {
                      autosizeTitle()
                      // 标题保持单段语义：粘贴带来的换行折成空格入库
                      scheduleSave(active.id, { title: e.target.value.replace(/\r?\n/g, ' ') })
                    }}
                    onBlur={(e) => {
                      e.target.value = e.target.value.replace(/\s*\r?\n\s*/g, ' ')
                      autosizeTitle()
                    }}
                    onKeyDown={(e) => {
                      // 标题内 Enter 不换行：转去正文开头继续写（常见笔记行为）
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault()
                        document.querySelector<HTMLElement>('.editor-body .ProseMirror')?.focus()
                      }
                    }}
                  />
                </div>
                <EditorBoundary>
                  <Editor
                    key={active.id}
                    content={active.content}
                    onUpdate={(content) => scheduleSave(active.id, { content })}
                    toolbarHidden={toolbarHidden}
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
      <DialogHost />
    </div>
  )
}

