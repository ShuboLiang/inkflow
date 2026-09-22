import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  closestCenter,
  defaultDropAnimationSideEffects,
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  MouseSensor,
  pointerWithin,
  TouchSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DropAnimation,
} from '@dnd-kit/core'
import { db, type FileEntry, type Folder, type Note } from './lib/db'
import { Auth } from './components/Auth'
import { Editor } from './components/Editor'
import { EditorBoundary } from './components/EditorBoundary'
import { EmptyState } from './components/EmptyState'
import { NoteList } from './components/NoteList'
import { NoteInfoModal } from './components/NoteInfoModal'
import { SettingsModal } from './components/SettingsModal'

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
import { createNote, permanentlyDeleteNote, restoreNote, softDeleteNote, updateNote } from './store/notes'
import { createFolder, deleteFolder, moveFolder, renameFolder } from './store/folders'
import { addTagToNote, deleteTag, renameTag } from './store/tags'
import {
  acquireFileUrl,
  deleteFile,
  moveFile,
  permanentlyDeleteFile,
  renameFile,
  restoreFile,
  saveFile,
  setFilePosition,
  setFileTags,
} from './store/files'
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
import {
  Menu,
  ChevronLeft,
  PanelLeftClose,
  PanelLeft,
  LayoutList,
  Plus,
  Download,
  Maximize2,
  Minimize2,
  Trash2,
  RotateCcw,
  Edit3,
  BookOpen,
  FileText,
  Info,
} from 'lucide-react'

// 本地临时持久化 tabs 的 storage key
const tabsStorageKey = (userId: string) => `inkflow:tabs:${userId}`
const lastFolderKey = (userId: string) => `inkflow:lastFolder:${userId}`

interface NavParams {
  folder?: string | null
  tag?: string | null
  q?: string
  noteId?: string | null
  fileId?: string | null
}

function parseUrlNavState(): {
  folder: string | null
  tag: string | null
  q: string
  noteId: string | null
  fileId: string | null
} {
  try {
    const p = new URLSearchParams(window.location.search)
    return {
      folder: p.get('folder'),
      tag: p.get('tag'),
      q: p.get('q') ?? '',
      noteId: p.get('note'),
      fileId: p.get('file'),
    }
  } catch {
    return { folder: null, tag: null, q: '', noteId: null, fileId: null }
  }
}

function syncUrlNavState(patch: NavParams, mode: 'push' | 'replace' = 'replace') {
  try {
    const url = new URL(window.location.href)
    if (patch.folder !== undefined) {
      if (!patch.folder || patch.folder === 'all') {
        url.searchParams.delete('folder')
      } else {
        url.searchParams.set('folder', patch.folder)
      }
    }
    if (patch.tag !== undefined) {
      if (patch.tag) {
        url.searchParams.set('tag', patch.tag)
      } else {
        url.searchParams.delete('tag')
      }
    }
    if (patch.q !== undefined) {
      const q = patch.q.trim()
      if (q) {
        url.searchParams.set('q', q)
      } else {
        url.searchParams.delete('q')
      }
    }
    if (patch.noteId !== undefined) {
      if (patch.noteId) {
        url.searchParams.set('note', patch.noteId)
        url.searchParams.delete('file')
      } else {
        url.searchParams.delete('note')
      }
    }
    if (patch.fileId !== undefined) {
      if (patch.fileId) {
        url.searchParams.set('file', patch.fileId)
        url.searchParams.delete('note')
      } else {
        url.searchParams.delete('file')
      }
    }

    const query = url.searchParams.toString()
    const targetUrl = query ? `${url.pathname}?${query}${url.hash}` : `${url.pathname}${url.hash}`
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`
    if (targetUrl !== currentUrl) {
      if (mode === 'push') {
        window.history.pushState(null, '', targetUrl)
      } else {
        window.history.replaceState(null, '', targetUrl)
      }
    }
  } catch {}
}

const DESKTOP_SIDEBAR_KEY = 'inkflow:desktop:sidebarCollapsed'
const DESKTOP_NOTELIST_KEY = 'inkflow:desktop:noteListCollapsed'
const READING_MODE_KEY = 'inkflow:readingMode'

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
  const initialNav = useMemo(() => parseUrlNavState(), [])
  const [activeId, setActiveId] = useState<string | null>(initialNav.noteId)
  const [activeFileId, setActiveFileId] = useState<string | null>(initialNav.fileId)
  const [tabs, setTabs] = useState<TabItem[]>([])
  const [activeFolderId, setActiveFolderId] = useState<string>(() => {
    if (initialNav.folder) return initialNav.folder
    return 'all'
  })
  const [activeTag, setActiveTag] = useState<string | null>(initialNav.tag)
  const [search, setSearch] = useState(initialNav.q)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [mobileView, setMobileView] = useState<'list' | 'editor'>(
    initialNav.noteId || initialNav.fileId ? 'editor' : 'list',
  )
  // 阅读模式：持久化保存在 localStorage 中，跨笔记保持
  const [readingMode, setReadingMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem(READING_MODE_KEY) === 'true'
    } catch {
      return false
    }
  })
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
  // 偏好：是否在父文件夹中包含子文件夹内容（默认 false = 严格直属模式）
  const [includeSubfolders, setIncludeSubfolders] = useState<boolean>(() => {
    try {
      return localStorage.getItem('inkflow:prefs:includeSubfolders') === 'true'
    } catch {
      return false
    }
  })
  // 偏好设置弹窗状态
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 笔记信息弹窗目标（null = 关闭）
  const [noteInfoTarget, setNoteInfoTarget] = useState<Note | null>(null)
  const titleRef = useRef<HTMLTextAreaElement>(null)
  const titleFocusSeq = useRef(0)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSave = useRef<{ id: string; patch: { title?: string; content?: unknown } } | null>(null)

  const notes = useLiveQuery(() => db.notes.filter((n) => n.deletedAt === null).toArray(), [])

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
        // 若云端包含子文件夹偏好设置，采用云端设置
        if (typeof p.includeSubfolders === 'boolean') {
          setIncludeSubfolders(p.includeSubfolders)
          try {
            localStorage.setItem('inkflow:prefs:includeSubfolders', String(p.includeSubfolders))
          } catch {}
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

  const handleToggleIncludeSubfolders = (val: boolean) => {
    setIncludeSubfolders(val)
    try {
      localStorage.setItem('inkflow:prefs:includeSubfolders', String(val))
    } catch {}
    void savePrefs({ toolbarHidden, theme, includeSubfolders: val }).catch(() => {})
  }

  const toggleToolbar = () => {
    setToolbarHidden((cur) => {
      const next = !cur
      void savePrefs({ toolbarHidden: next, theme, includeSubfolders }).catch(() => {})
      return next
    })
  }

  // 切主题：本机立即生效并记住，同时随账号存到云端（新设备首次登录会带上）
  const changeTheme = (id: string) => {
    if (id === theme) return
    applyTheme(id)
    setTheme(id)
    void savePrefs({ toolbarHidden, theme: id, includeSubfolders }).catch(() => {})
  }

  const folders = useLiveQuery(async () => {
    const all = await db.folders.filter((f) => f.deletedAt === null).toArray()
    return all.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  }, [])

  const files = useLiveQuery(() => db.files.filter((f) => f.deletedAt === null).toArray(), [])
  const deletedNotes = useLiveQuery(() => db.notes.filter((n) => n.deletedAt !== null).toArray(), [])
  const deletedFiles = useLiveQuery(() => db.files.filter((f) => f.deletedAt !== null).toArray(), [])
  const trashCount = (deletedNotes?.length ?? 0) + (deletedFiles?.length ?? 0)
  const activeFile =
    (files?.find((f) => f.id === activeFileId) ?? deletedFiles?.find((f) => f.id === activeFileId)) ?? null
  const isTrashFile = activeFile?.deletedAt != null

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

  // 当开启包含子文件夹时，计算文件夹呈现排位：当前文件夹居首(0)，子孙文件夹按前序深度优先遍历各占一段(1, 2, 3...)
  const folderGroupRanks = useMemo(() => {
    if (activeFolderId === 'all' || activeFolderId === 'trash' || !includeSubfolders) return null
    const ranks = new Map<string, number>()
    ranks.set(activeFolderId, 0)
    let seq = 0
    const walk = (id: string) => {
      for (const ch of folderChildren.get(id) ?? []) {
        ranks.set(ch.id, ++seq)
        walk(ch.id)
      }
    }
    walk(activeFolderId)
    return ranks
  }, [activeFolderId, includeSubfolders, folderChildren])

  const isGroupedByFolder = folderGroupRanks !== null && !search.trim() && !activeTag

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
    // 数量优先、同数量按拼音：常用标签排前面（侧栏默认只显示前 N 个）
    return new Map([...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN')))
  }, [notes, files])

  // 乐观位置覆盖：拖拽或菜单调序后立即在本地渲染生效，消除 IndexedDB 异步写入造成的列表回弹与闪烁
  const [positionOverrides, setPositionOverrides] = useState<Record<string, number>>({})

  // 渲染期自清理：当 IndexedDB 已同步最新 position 后，清理对应 override（避免 effect 级联渲染）
  let hasStaleOverride = false
  for (const id in positionOverrides) {
    const n = notes?.find((x) => x.id === id)
    if (n && n.position === positionOverrides[id]) {
      hasStaleOverride = true
      break
    }
    const f = files?.find((x) => x.id === id)
    if (f && f.position === positionOverrides[id]) {
      hasStaleOverride = true
      break
    }
  }
  if (hasStaleOverride) {
    const next = { ...positionOverrides }
    for (const id in next) {
      const n = notes?.find((x) => x.id === id)
      if (n && n.position === next[id]) {
        delete next[id]
        continue
      }
      const f = files?.find((x) => x.id === id)
      if (f && f.position === next[id]) {
        delete next[id]
      }
    }
    setPositionOverrides(next)
  }

  const visibleNotes = useMemo(() => {
    if (activeFolderId === 'trash') {
      const all = deletedNotes ?? []
      const q = search.trim().toLowerCase()
      if (!q) return all
      return all.filter(
        (n) =>
          n.title.toLowerCase().includes(q) ||
          plainTextOf(n.content).toLowerCase().includes(q),
      )
    }
    const all = notes ?? []
    const q = search.trim().toLowerCase()
    // 「默认」= 未归入任何文件夹的笔记；文件夹视图 = 根据 includeSubfolders 决定是仅直接归属还是整棵子树
    const inScope = (n: (typeof all)[number]) => {
      if (activeFolderSubtree === null) return n.folderId === null
      if (includeSubfolders) return activeFolderSubtree.has(n.folderId ?? '')
      return n.folderId === activeFolderId
    }
    let scoped = q || activeTag ? all : all.filter(inScope)
    if (!q && activeTag) scoped = scoped.filter((n) => (n.tags ?? []).includes(activeTag))
    if (q) {
      // 标题/正文命中，或所属文件夹（含子树）名命中
      scoped = scoped.filter(
        (n) =>
          n.title.toLowerCase().includes(q) ||
          plainTextOf(n.content).toLowerCase().includes(q) ||
          (n.folderId !== null && folderHitSubtree !== null && folderHitSubtree.has(n.folderId)),
      )
    }
    // 统一列表排序：
    // 若处于按文件夹轻量分组模式，首先按文件夹层级分组，组内按 position 排序；
    // 无 position 的兜底排后。
    return [...scoped]
      .map((n) => (positionOverrides[n.id] !== undefined ? { ...n, position: positionOverrides[n.id] } : n))
      .sort((a, b) => {
        if (isGroupedByFolder && folderGroupRanks) {
          const rankA = folderGroupRanks.get(a.folderId ?? '') ?? 999999
          const rankB = folderGroupRanks.get(b.folderId ?? '') ?? 999999
          if (rankA !== rankB) return rankA - rankB
        }
        return (
          (a.position ?? Infinity) - (b.position ?? Infinity) ||
          (b.createdAt ?? b.updatedAt) - (a.createdAt ?? a.updatedAt)
        )
      })
  }, [activeFolderId, deletedNotes, notes, search, activeFolderSubtree, includeSubfolders, activeTag, folderHitSubtree, positionOverrides, isGroupedByFolder, folderGroupRanks])

  const active =
    (notes?.find((n) => n.id === activeId) ?? deletedNotes?.find((n) => n.id === activeId)) ?? null
  const isTrashNote = active?.deletedAt != null

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
            const changed = await updateNote(note.id, { content: next })
            if (changed) requestPush()
          }
        } catch (err) {
          console.error('migrate note images failed', note.id, err)
        }
        await new Promise((r) => setTimeout(r, 50))
      }
    })()
  }, [user, notes, requestPush])

  const scheduleSave = (id: string, patch: { title?: string; content?: unknown }) => {
    // 快速前置守卫：如果单改标题且内容未变，极速短路
    if (active && active.id === id) {
      if (patch.title !== undefined && patch.content === undefined && patch.title === active.title) {
        return
      }
    }
    pendingSave.current =
      pendingSave.current && pendingSave.current.id === id
        ? { id, patch: { ...pendingSave.current.patch, ...patch } }
        : { id, patch }
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      const pending = pendingSave.current
      pendingSave.current = null
      if (pending) {
        void updateNote(pending.id, pending.patch).then((changed) => {
          if (changed) requestPush()
        })
      }
    }, 500)
  }

  const flushSave = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const pending = pendingSave.current
    pendingSave.current = null
    if (pending) {
      void updateNote(pending.id, pending.patch).then((changed) => {
        if (changed) requestPush()
      })
    }
  }, [requestPush])

  const toggleReadingMode = useCallback(() => {
    flushSave()
    setReadingMode((prev) => {
      const next = !prev
      try {
        localStorage.setItem(READING_MODE_KEY, String(next))
      } catch {}
      return next
    })
  }, [flushSave])

  // Ctrl/Cmd + E 切换阅读模式 / 编辑模式
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
        if (activeId) {
          e.preventDefault()
          toggleReadingMode()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeId, toggleReadingMode])

  const handleCreate = async () => {
    flushSave()
    const targetFolder = activeFolderId === 'all' || activeFolderId === 'trash' ? null : activeFolderId
    const note = await createNote('', targetFolder)
    setTitleFocusReq({ id: note.id, n: ++titleFocusSeq.current })
    setTabs((prev) => [...prev, { kind: 'note', id: note.id }])
    setActiveFileId(null)
    setActiveId(note.id)
    setMobileView('editor')
    syncUrlNavState({ noteId: note.id, fileId: null }, 'replace')
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
    syncUrlNavState({ noteId: id, fileId: null }, 'replace')
  }

  const handleSelectTab = (tab: TabItem) => {
    flushSave()
    if (tab.kind === 'note') {
      setActiveFileId(null)
      setActiveId(tab.id)
      syncUrlNavState({ noteId: tab.id, fileId: null }, 'replace')
    } else {
      setActiveId(null)
      setActiveFileId(tab.id)
      syncUrlNavState({ fileId: tab.id, noteId: null }, 'replace')
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
        syncUrlNavState({ noteId: null, fileId: null }, 'replace')
      } else {
        const nextActiveIndex = Math.min(targetIndex, nextTabs.length - 1)
        const nextActive = nextTabs[nextActiveIndex]
        if (nextActive.kind === 'note') {
          setActiveFileId(null)
          setActiveId(nextActive.id)
          syncUrlNavState({ noteId: nextActive.id, fileId: null }, 'replace')
        } else {
          setActiveId(null)
          setActiveFileId(nextActive.id)
          syncUrlNavState({ fileId: nextActive.id, noteId: null }, 'replace')
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
      syncUrlNavState({ noteId: kept.id, fileId: null }, 'replace')
    } else {
      setActiveId(null)
      setActiveFileId(kept.id)
      syncUrlNavState({ fileId: kept.id, noteId: null }, 'replace')
    }
  }

  const handleCloseAllTabs = () => {
    flushSave()
    setTabs([])
    setActiveId(null)
    setActiveFileId(null)
    syncUrlNavState({ noteId: null, fileId: null }, 'replace')
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
    setSearch('')
    setSidebarOpen(false)
    // 手机上选文件夹=切换浏览上下文：从笔记里跳回列表（与侧栏选标签的行为一致）
    setMobileView('list')
    setDesktopNoteListCollapsed(false)
    if (user) {
      try {
        localStorage.setItem(lastFolderKey(user.id), id)
      } catch {}
    }
    syncUrlNavState({ folder: id, tag: null, q: '' }, 'push')
  }

  // 点击搜索结果里的文件夹：跳转进去并清空搜索/标签筛选
  const handleSelectFolderHit = (id: string) => {
    setActiveTag(null)
    setSearch('')
    setActiveFolderId(id)
    setSidebarOpen(false)
    setMobileView('list')
    setDesktopNoteListCollapsed(false)
    if (user) {
      try {
        localStorage.setItem(lastFolderKey(user.id), id)
      } catch {}
    }
    syncUrlNavState({ folder: id, tag: null, q: '' }, 'push')
  }

  // 跳到笔记/文件所在文件夹（保留打开的内容，只切换列表上下文）
  const handleGotoFolder = (folderId: string) => {
    setActiveTag(null)
    setSearch('')
    setActiveFolderId(folderId)
    setSidebarOpen(false)
    if (user) {
      try {
        localStorage.setItem(lastFolderKey(user.id), folderId)
      } catch {}
    }
    syncUrlNavState({ folder: folderId, tag: null, q: '' }, 'push')
  }

  const handleSearch = useCallback((q: string) => {
    setSearch(q)
    syncUrlNavState({ q }, 'replace')
  }, [])

  const handleCreateFolder = async (name: string, parentId: string | null = null) => {
    const folder = await createFolder(name, parentId)
    requestPush()
    setActiveFolderId(folder.id)
    if (user) {
      try {
        localStorage.setItem(lastFolderKey(user.id), folder.id)
      } catch {}
    }
    syncUrlNavState({ folder: folder.id }, 'push')
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
    if (activeFolderSubtree?.has(id) || activeFolderId === id) {
      setActiveFolderId('all')
      if (user) {
        try {
          localStorage.setItem(lastFolderKey(user.id), 'all')
        } catch {}
      }
      syncUrlNavState({ folder: 'all' }, 'replace')
    }
    requestPush()
  }

  const handleDropNote = (noteId: string, folderId: string | null) => {
    const note = notes?.find((n) => n.id === noteId)
    if (!note || note.deletedAt !== null || note.folderId === folderId) return
    void updateNote(noteId, { folderId }).then((changed) => {
      if (changed) requestPush()
    })
  }

  const handleToggleTag = (name: string) => {
    const next = activeTag === name ? null : name
    setSearch('')
    setActiveTag(next)
    setMobileView('list')
    setDesktopNoteListCollapsed(false)
    // 与点文件夹一致：移动端选完标签随手关抽屉（桌面端 sidebarOpen 无效果）
    setSidebarOpen(false)
    syncUrlNavState({ tag: next, q: '' }, 'push')
  }

  // 卡片标签点击：搜索词优先级高于标签过滤，不清空搜索的话点了标签也看不到过滤效果
  const handleSelectTag = (name: string) => {
    setSearch('')
    setActiveTag(name)
    setMobileView('list')
    setDesktopNoteListCollapsed(false)
    setSidebarOpen(false)
    syncUrlNavState({ tag: name, q: '' }, 'push')
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
    if (activeTag === oldName) {
      setActiveTag(newName)
      syncUrlNavState({ tag: newName }, 'replace')
    }
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
    if (activeTag === name) {
      setActiveTag(null)
      syncUrlNavState({ tag: null }, 'replace')
    }
    requestPush()
  }

  const handleDropNoteToTag = (noteId: string, tag: string) => {
    void addTagToNote(noteId, tag).then((added) => {
      if (added) requestPush()
    })
  }

  const handleNoteTagsChange = (tags: string[]) => {
    if (!active) return
    void updateNote(active.id, { tags }).then((changed) => {
      if (changed) requestPush()
    })
  }

  const handleFileTagsChange = (tags: string[]) => {
    if (!activeFile) return
    void setFileTags(activeFile.id, tags).then(requestPush)
  }

  // 纯云端文件按需流式拉取到内存（Blob URL），不写入 IndexedDB
  const [fileUrlState, setFileUrlState] = useState<{ id: string | null; url: string | null; error: boolean }>({
    id: null,
    url: null,
    error: false,
  })

  useEffect(() => {
    if (!activeFileId) return
    let cancelled = false

    void acquireFileUrl(activeFileId).then((url) => {
      if (cancelled) return
      setFileUrlState({
        id: activeFileId,
        url,
        error: !url,
      })
    })

    return () => {
      cancelled = true
    }
  }, [activeFileId])

  const activeFileUrl = fileUrlState.id === activeFileId ? fileUrlState.url : null
  const fileLoadError = fileUrlState.id === activeFileId ? fileUrlState.error : false

  // 过滤掉已被彻底删除或不存在的笔记/文件标签项（在回收站中的保留有效）
  const validTabs = useMemo(() => {
    if (!notes && !files) return tabs
    return tabs.filter((t) => {
      if (t.kind === 'note') {
        return (
          (!notes || notes.some((x) => x.id === t.id && x.deletedAt === null)) ||
          Boolean(deletedNotes?.some((x) => x.id === t.id))
        )
      } else {
        return (
          (!files || files.some((x) => x.id === t.id && !x.deletedAt)) ||
          Boolean(deletedFiles?.some((x) => x.id === t.id))
        )
      }
    })
  }, [tabs, notes, files, deletedNotes, deletedFiles])

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

      // 优先支持从 URL (initialNav) 恢复打开指定的笔记或文件
      const allNotes = (notes ?? []).concat(deletedNotes ?? [])
      const allFiles = (files ?? []).concat(deletedFiles ?? [])

      if (initialNav.noteId && allNotes.some((n) => n.id === initialNav.noteId)) {
        if (!loadedTabs.some((t) => t.kind === 'note' && t.id === initialNav.noteId)) {
          loadedTabs.push({ kind: 'note', id: initialNav.noteId })
        }
        loadedActiveTabId = initialNav.noteId
      } else if (initialNav.fileId && allFiles.some((f) => f.id === initialNav.fileId)) {
        if (!loadedTabs.some((t) => t.kind === 'file' && t.id === initialNav.fileId)) {
          loadedTabs.push({ kind: 'file', id: initialNav.fileId })
        }
        loadedActiveTabId = initialNav.fileId
      }

      const initialValid = loadedTabs.filter((t) => {
        if (t.kind === 'file') {
          return files.some((x) => x.id === t.id && !x.deletedAt) || Boolean(deletedFiles?.some((x) => x.id === t.id))
        } else {
          return notes.some((x) => x.id === t.id && x.deletedAt === null) || Boolean(deletedNotes?.some((x) => x.id === t.id))
        }
      })

      // 恢复当前文件夹现场：优先 URL 参数，其次本设备 localStorage
      const savedFolder = initialNav.folder || localStorage.getItem(lastFolderKey(user.id))
      if (savedFolder) {
        setActiveFolderId(savedFolder)
      }

      if (initialValid.length > 0) {
        setTabs(initialValid)
        const activeItem = initialValid.find((t) => t.id === loadedActiveTabId) || initialValid[0]
        if (activeItem.kind === 'file') {
          const f = allFiles.find((x) => x.id === activeItem.id)
          if (f) {
            setActiveFileId(f.id)
            setActiveId(null)
            if (!savedFolder && f.folderId) setActiveFolderId(f.folderId)
          }
        } else {
          const n = allNotes.find((x) => x.id === activeItem.id)
          if (n) {
            setActiveId(n.id)
            setActiveFileId(null)
            if (!savedFolder && n.folderId) setActiveFolderId(n.folderId)
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
        includeSubfolders,
      }).catch(() => {})
    }, 600)

    return () => {
      if (savePrefsTimer.current) clearTimeout(savePrefsTimer.current)
    }
  }, [user, restored, validTabs, activeId, activeFileId, toolbarHidden, theme, includeSubfolders])

  // 监听浏览器前进/后退，无缝同步导航现场
  useEffect(() => {
    const onPopState = () => {
      const nav = parseUrlNavState()
      if (nav.folder) {
        setActiveFolderId(nav.folder)
      } else if (user) {
        const saved = localStorage.getItem(lastFolderKey(user.id))
        setActiveFolderId(saved || 'all')
      } else {
        setActiveFolderId('all')
      }
      setActiveTag(nav.tag)
      setSearch(nav.q)
      if (nav.noteId) {
        setActiveId(nav.noteId)
        setActiveFileId(null)
        setTabs((prev) => {
          if (prev.some((t) => t.kind === 'note' && t.id === nav.noteId)) return prev
          return [...prev, { kind: 'note', id: nav.noteId as string }]
        })
        setMobileView('editor')
      } else if (nav.fileId) {
        setActiveId(null)
        setActiveFileId(nav.fileId)
        setTabs((prev) => {
          if (prev.some((t) => t.kind === 'file' && t.id === nav.fileId)) return prev
          return [...prev, { kind: 'file', id: nav.fileId as string }]
        })
        setMobileView('editor')
      }
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [user])

  // 当前视图里的文件。「默认」= 无文件夹的文件；文件夹视图 = 该文件夹（含子树）
  // 回收站视图 = 已删除的文件；
  // 有搜索词时跨全部范围：文件名命中，或所属文件夹（含子树）名命中；
  // 标签视图 = 全库范围内挂了该标签的文件（与笔记共用标签命名空间）
  const filesInView = useMemo(() => {
    const q = search.trim().toLowerCase()
    // 统一列表排序：
    // 若处于按文件夹轻量分组模式，首先按文件夹层级分组，组内按 position 排序
    const byPosition = (a: FileEntry, b: FileEntry) => {
      if (isGroupedByFolder && folderGroupRanks) {
        const rankA = folderGroupRanks.get(a.folderId ?? '') ?? 999999
        const rankB = folderGroupRanks.get(b.folderId ?? '') ?? 999999
        if (rankA !== rankB) return rankA - rankB
      }
      return (
        (a.position ?? Infinity) - (b.position ?? Infinity) ||
        (b.createdAt ?? b.updatedAt) - (a.createdAt ?? a.updatedAt)
      )
    }
    if (activeFolderId === 'trash') {
      const all = deletedFiles ?? []
      if (!q) return all
      return all.filter((f) => f.filename.toLowerCase().includes(q))
    }
    if (activeTag) {
      return (files ?? [])
        .filter((f) => !f.deletedAt && (f.tags ?? []).includes(activeTag))
        .map((f) => (positionOverrides[f.id] !== undefined ? { ...f, position: positionOverrides[f.id] } : f))
        .sort(byPosition)
    }
    const inScope = (folderId: string | null) => {
      if (activeFolderSubtree === null) return folderId === null
      if (includeSubfolders) return folderId !== null && activeFolderSubtree.has(folderId)
      return folderId === activeFolderId
    }
    return (files ?? [])
      .filter((f) => !f.deletedAt)
      .filter((f) => (q ? true : inScope(f.folderId ?? null)))
      .filter(
        (f) =>
          !q ||
          f.filename.toLowerCase().includes(q) ||
          ((f.folderId ?? null) !== null && folderHitSubtree !== null && folderHitSubtree.has(f.folderId as string)),
      )
      .map((f) => (positionOverrides[f.id] !== undefined ? { ...f, position: positionOverrides[f.id] } : f))
      .sort(byPosition)
  }, [files, deletedFiles, activeFolderId, activeFolderSubtree, includeSubfolders, search, folderHitSubtree, activeTag, positionOverrides, isGroupedByFolder, folderGroupRanks])

  // ---------- 统一列表手动排序（笔记与文件共用 position 数轴） ----------
  type OrderItem = { kind: 'note' | 'file'; id: string; folderId: string | null; position: number | null }

  // 当前可见顺序：笔记与文件按分组与 position 合并（与列表渲染一致）
  const visibleOrder: OrderItem[] = useMemo(() => {
    const items: OrderItem[] = [
      ...visibleNotes.map((n) => ({ kind: 'note' as const, id: n.id, folderId: n.folderId, position: n.position })),
      ...filesInView.map((f) => ({ kind: 'file' as const, id: f.id, folderId: f.folderId, position: f.position })),
    ]
    if (isGroupedByFolder && folderGroupRanks) {
      return items.sort((a, b) => {
        const rankA = folderGroupRanks.get(a.folderId ?? '') ?? 999999
        const rankB = folderGroupRanks.get(b.folderId ?? '') ?? 999999
        if (rankA !== rankB) return rankA - rankB
        return (a.position ?? Infinity) - (b.position ?? Infinity)
      })
    }
    return items.sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity))
  }, [visibleNotes, filesInView, isGroupedByFolder, folderGroupRanks])

  // 全量重整：按给定完整顺序等距重编（跨两张表），只写有变化的行
  const applyManualOrder = async (ordered: OrderItem[]) => {
    const overrides: Record<string, number> = {}
    for (let i = 0; i < ordered.length; i++) {
      overrides[ordered[i].id] = (i + 1) * 1000
    }
    setPositionOverrides((prev) => ({ ...prev, ...overrides }))

    let changed = 0
    for (let i = 0; i < ordered.length; i++) {
      const want = (i + 1) * 1000
      const it = ordered[i]
      if (it.position === want) continue
      if (it.kind === 'note') await updateNote(it.id, { position: want })
      else await setFilePosition(it.id, want)
      changed++
    }
    if (changed) requestPush()
  }

  const writePosition = (kind: 'note' | 'file', id: string, position: number) =>
    void (kind === 'note'
      ? updateNote(id, { position }).then((changed) => {
          if (changed) requestPush()
        })
      : setFilePosition(id, position).then(requestPush))

  // 顺序上下文 = 当前可见列表（用户看到什么顺序就排成什么顺序）
  const handleReorderItem = (
    dragged: { kind: 'note' | 'file'; id: string },
    target: { kind: 'note' | 'file'; id: string },
    place: 'before' | 'after',
  ) => {
    if (dragged.id === target.id) return
    const draggedItem = visibleOrder.find((it) => it.id === dragged.id)
    const targetItem = visibleOrder.find((it) => it.id === target.id)
    if (!draggedItem || !targetItem) return

    // 分组视图下跨文件夹拖拽卡片：忽略，防止打乱各自文件夹的排列
    if (isGroupedByFolder && draggedItem.folderId !== targetItem.folderId) {
      return
    }

    const orderScope = isGroupedByFolder
      ? visibleOrder.filter((it) => it.folderId === draggedItem.folderId)
      : visibleOrder

    const order = orderScope.filter((it) => it.id !== dragged.id)
    const idx = order.findIndex((it) => it.id === target.id)
    if (idx < 0) return
    const insertAt = place === 'before' ? idx : idx + 1
    const prevPos = order[insertAt - 1]?.position ?? null
    const nextPos = order[insertAt]?.position ?? null

    if (prevPos !== null && nextPos !== null && nextPos - prevPos < 1) {
      // 中点精度耗尽：在当前同文件夹作用域内按现有顺序重整为等距序列
      const all: OrderItem[] = isGroupedByFolder
        ? [
            ...(notes ?? [])
              .filter((n) => n.deletedAt === null && n.folderId === draggedItem.folderId)
              .map((n) => ({ kind: 'note' as const, id: n.id, folderId: n.folderId, position: n.position })),
            ...(files ?? [])
              .filter((f) => f.deletedAt === null && f.folderId === draggedItem.folderId)
              .map((f) => ({ kind: 'file' as const, id: f.id, folderId: f.folderId, position: f.position })),
          ].sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity))
        : [
            ...(notes ?? [])
              .filter((n) => n.deletedAt === null)
              .map((n) => ({ kind: 'note' as const, id: n.id, folderId: n.folderId, position: n.position })),
            ...(files ?? [])
              .filter((f) => f.deletedAt === null)
              .map((f) => ({ kind: 'file' as const, id: f.id, folderId: f.folderId, position: f.position })),
          ].sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity))
      const draggedFull = all.find((it) => it.id === dragged.id)
      const rest = all.filter((it) => it.id !== dragged.id)
      const fullIdx = rest.findIndex((it) => it.id === target.id)
      if (draggedFull && fullIdx >= 0) {
        const at = place === 'before' ? fullIdx : fullIdx + 1
        void applyManualOrder([...rest.slice(0, at), draggedFull, ...rest.slice(at)])
      }
      return
    }

    let pos: number
    if (prevPos !== null && nextPos !== null) pos = (prevPos + nextPos) / 2
    else if (prevPos !== null) pos = prevPos + 1000 // 拖到末尾
    else if (nextPos !== null) pos = nextPos - 1000 // 拖到开头
    else pos = 0
    setPositionOverrides((prev) => ({ ...prev, [dragged.id]: pos }))
    writePosition(dragged.kind, dragged.id, pos)
  }

  // 长按菜单「上移/下移」：与相邻项换位（跨类型也生效，如文件移到笔记前）
  const handleMoveStep = (kind: 'note' | 'file', id: string, dir: -1 | 1) => {
    const current = visibleOrder.find((it) => it.id === id)
    if (!current) return
    const scope = isGroupedByFolder
      ? visibleOrder.filter((it) => it.folderId === current.folderId)
      : visibleOrder
    const idx = scope.findIndex((it) => it.id === id)
    const target = scope[idx + dir]
    if (idx < 0 || !target) return
    handleReorderItem({ kind, id }, { kind: target.kind, id: target.id }, dir < 0 ? 'before' : 'after')
  }

  // 菜单「移到顶部/底部」：挪到首/尾邻居旁
  const handleMoveEdge = (kind: 'note' | 'file', id: string, edge: 'top' | 'bottom') => {
    const current = visibleOrder.find((it) => it.id === id)
    if (!current) return
    const scope = isGroupedByFolder
      ? visibleOrder.filter((it) => it.folderId === current.folderId)
      : visibleOrder
    const rest = scope.filter((it) => it.id !== id)
    if (!rest.length) return
    if (edge === 'top') {
      const first = rest[0]
      handleReorderItem({ kind, id }, { kind: first.kind, id: first.id }, 'before')
    } else {
      const last = rest[rest.length - 1]
      handleReorderItem({ kind, id }, { kind: last.kind, id: last.id }, 'after')
    }
  }

  // ---------- dnd-kit 拖拽上下文 ----------
  // 桌面：鼠标按住移动 5px 激活（不误伤单击）；手机：长按 250ms 抬起（tolerance 内仍可滚动列表）
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  )

  const collisionDetection: CollisionDetection = useCallback((args) => {
    // 优先指针直接悬停的目标（侧栏文件夹/标签/卡片）
    const pointerCollisions = pointerWithin(args)
    if (pointerCollisions.length > 0) {
      return pointerCollisions
    }
    // 指针在空白处时按最近中心回退
    return closestCenter(args)
  }, [])

  const [dragInfo, setDragInfo] = useState<{
    kind: 'note' | 'file'
    id: string
  } | null>(null)
  const [activeDragItem, setActiveDragItem] = useState<{
    kind: 'note' | 'file'
    id: string
    title: string
  } | null>(null)
  const [isOverZone, setIsOverZone] = useState(false)

  // 拖近左缘自动拉开移动端抽屉（侧栏 DOM 常驻仅 translateX 隐藏，droppable 可用）
  const handleDragMove = (e: DragMoveEvent) => {
    if (!e.active.data.current || e.active.data.current.type !== 'item') return
    if (e.delta.x < -40 && window.innerWidth < 1024) setSidebarOpen(true)
    setIsOverZone(e.over?.data.current?.type === 'zone')
  }

  const handleDragOver = (e: DragOverEvent) => {
    setIsOverZone(e.over?.data.current?.type === 'zone')
  }

  // 松手路由：item×item=排序；item×folder-zone=移动；item×tag-zone=加标签
  const handleDragEnd = (e: DragEndEvent) => {
    const info = dragInfo
    setDragInfo(null)
    setIsOverZone(false)
    setTimeout(() => setActiveDragItem(null), 300)
    if (!info) return
    const overData = e.over?.data.current as { type?: string; kind?: 'note' | 'file' } | undefined
    if (!e.over || !overData) return

    if (overData.type === 'zone') {
      const zoneId = String(e.over.id)
      if (zoneId.startsWith('folder-zone:')) {
        const folderId = zoneId.slice('folder-zone:'.length)
        if (info.kind === 'note') handleDropNote(info.id, folderId)
        else handleDropFile(info.id, folderId)
      } else if (zoneId === 'zone:all') {
        if (info.kind === 'note') handleDropNote(info.id, null)
        else handleDropFile(info.id, null)
      } else if (zoneId === 'zone:trash') {
        if (info.kind === 'note') {
          void softDeleteNote(info.id).then(() => {
            requestPush()
            handleCloseTab(info.id)
          })
        } else {
          void deleteFile(info.id).then(() => {
            requestPush()
            handleCloseTab(info.id)
          })
        }
      } else if (zoneId.startsWith('tag-zone:')) {
        const tag = zoneId.slice('tag-zone:'.length)
        if (info.kind === 'note') {
          handleDropNoteToTag(info.id, tag)
        } else {
          const targetFile = files?.find((f) => f.id === info.id)
          if (targetFile && !(targetFile.tags ?? []).includes(tag)) {
            const nextTags = [...(targetFile.tags ?? []), tag]
            void setFileTags(targetFile.id, nextTags).then(requestPush)
          }
        }
      }
      return
    }

    // item×item：同列表排序（over 是目标卡片，before/after 由原始索引关系决定）
    if (overData.type === 'item') {
      const overKind = (overData.kind ?? 'note') as 'note' | 'file'
      const overId = String(e.over.id)
      const fromIdx = visibleOrder.findIndex((it) => it.id === info.id)
      const toIdx = visibleOrder.findIndex((it) => it.id === overId)
      if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return
      handleReorderItem(info, { kind: overKind, id: overId }, fromIdx < toIdx ? 'after' : 'before')
    }
  }

  const dropAnimationConfig: DropAnimation = useMemo(
    () => ({
      duration: 180,
      easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)',
      sideEffects: defaultDropAnimationSideEffects({
        styles: {
          active: {
            opacity: '0',
          },
        },
      }),
    }),
    [],
  )


  // 上传：pdf/html 存为当前文件夹的文件（原生预览）；md 在当前文件夹新建一篇笔记（文件名作标题）。
  // targetFolderId 由拖放位置决定（侧栏文件夹）；按钮上传则跟随当前视图
  const handleUpload = async (file: File, targetFolderId?: string | null) => {
    const folderId = targetFolderId !== undefined ? targetFolderId : activeFolderId === 'all' ? null : activeFolderId
    const kind = kindOfFile(file)
    if (kind === 'binary' || kind === 'html') {
      const saved = await saveFile(file, folderId, user?.id)
      requestPush()
      setTabs((prev) => [...prev, { kind: 'file', id: saved.id }])
      setActiveId(null)
      setActiveFileId(saved.id)
      setMobileView('editor')
      syncUrlNavState({ fileId: saved.id, noteId: null }, 'replace')
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
      syncUrlNavState({ noteId: note.id, fileId: null }, 'replace')
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
    syncUrlNavState({ fileId: id, noteId: null }, 'replace')
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
    requestPush()
    handleCloseTab(delId)
    setMobileView('list')
  }

  const handleRestoreNote = async (id: string) => {
    await restoreNote(id)
    requestPush()
  }

  const handlePermanentlyDeleteNote = async (id: string) => {
    const note = (notes ?? []).concat(deletedNotes ?? []).find((n) => n.id === id)
    const ok = await confirmDialog({
      title: '彻底删除笔记',
      message: `彻底删除笔记「${note?.title || '无标题'}」？此操作无法撤销。`,
      confirmText: '彻底删除',
      danger: true,
    })
    if (!ok) return
    handleCloseTab(id)
    await permanentlyDeleteNote(id)
    requestPush()
  }

  const handleRestoreFile = async (id: string) => {
    await restoreFile(id)
    requestPush()
  }

  const handlePermanentlyDeleteFile = async (id: string) => {
    const file = (files ?? []).concat(deletedFiles ?? []).find((f) => f.id === id)
    const ok = await confirmDialog({
      title: '彻底删除文件',
      message: `彻底删除文件「${file?.filename ?? ''}」？此操作无法撤销。`,
      confirmText: '彻底删除',
      danger: true,
    })
    if (!ok) return
    handleCloseTab(id)
    await permanentlyDeleteFile(id)
    requestPush()
  }

  const handleEmptyTrash = async () => {
    const total = (deletedNotes?.length ?? 0) + (deletedFiles?.length ?? 0)
    if (total === 0) return
    const ok = await confirmDialog({
      title: '清空回收站',
      message: `确定要清空回收站吗？将彻底删除 ${total} 个项目，此操作无法撤销。`,
      confirmText: '清空',
      danger: true,
    })
    if (!ok) return
    for (const n of deletedNotes ?? []) {
      handleCloseTab(n.id)
      await permanentlyDeleteNote(n.id)
    }
    for (const f of deletedFiles ?? []) {
      handleCloseTab(f.id)
      await permanentlyDeleteFile(f.id)
    }
    requestPush()
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

  // 近左缘自动开抽屉见 handleDragMove；拖拽开始记录被拖项（DragOverlay 用）
  const handleDragStart = (e: DragStartEvent) => {
    const data = e.active.data.current as { type?: string; kind?: 'note' | 'file' } | undefined
    if (data?.type === 'item' && (data.kind === 'note' || data.kind === 'file')) {
      const id = String(e.active.id)
      setDragInfo({ kind: data.kind, id })
      const title =
        data.kind === 'note'
          ? notes?.find((n) => n.id === id)?.title || '无标题'
          : files?.find((f) => f.id === id)?.filename || '文件'
      setActiveDragItem({ kind: data.kind, id, title })
    }
  }

  // 拖拽笔记/文件/文件夹（text/plain 内部载荷）悬停在没有放置处理的地方时，
  // 浏览器默认把文本当"拖放搜索"，提示「松开鼠标以搜索文本」。外壳层兜底：
  // 内部载荷一律拦截默认行为并标记不可放置；真正的放置目标（排序卡片、
  // 侧栏文件夹/标签）自己 preventDefault 过的事件（defaultPrevented）不碰。
  const handleShellDragOver = (e: React.DragEvent) => {
    if (e.defaultPrevented || !e.dataTransfer.types.includes('text/plain')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'none'
  }
  const handleShellDrop = (e: React.DragEvent) => {
    if (e.defaultPrevented || !e.dataTransfer.types.includes('text/plain')) return
    e.preventDefault()
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={() => {
        setDragInfo(null)
        setIsOverZone(false)
        setActiveDragItem(null)
      }}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
    >
      <div
        className={['app-shell', mobileView === 'editor' ? 'mobile-editor' : 'mobile-list'].join(' ')}
        onDragOver={handleShellDragOver}
        onDrop={handleShellDrop}
      >
      <header className="app-topbar">
        <div className="app-topbar-left">
          <button
            type="button"
            className="app-menu"
            aria-label="打开侧栏"
            onClick={() => setSidebarOpen((v) => !v)}
          >
            <Menu size={18} />
          </button>
          <button
            type="button"
            className="app-topbar-back"
            onClick={() => {
              setMobileView('list')
              syncUrlNavState({ noteId: null, fileId: null }, 'replace')
            }}
          >
            <ChevronLeft size={16} />
            <span>列表</span>
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
              {desktopSidebarCollapsed ? <PanelLeft size={16} /> : <PanelLeftClose size={16} />}
            </button>
            <button
              type="button"
              className={isNoteListEffectivelyCollapsed ? 'app-topbar-btn active' : 'app-topbar-btn'}
              title={isNoteListEffectivelyCollapsed ? '展开笔记列表' : '折叠笔记列表'}
              aria-label={isNoteListEffectivelyCollapsed ? '展开笔记列表' : '折叠笔记列表'}
              aria-pressed={isNoteListEffectivelyCollapsed}
              onClick={toggleDesktopNoteList}
            >
              <LayoutList size={16} />
            </button>
          </div>
        </div>

        <div className="app-topbar-center">
          <span className="app-topbar-mobile-title">
            {activeTag
              ? `# ${activeTag}`
              : activeFolderId === 'trash'
                ? '回收站'
                : activeFolderId === 'all'
                  ? '默认'
                  : (folderPathNames(activeFolderId, folders ?? []) ?? '默认')}
          </span>
          {validTabs.length > 0 ? (
            <TabBar
              tabs={validTabs}
              activeTabId={activeFileId || activeId}
              notes={[...(notes ?? []), ...(deletedNotes ?? [])]}
              files={[...(files ?? []), ...(deletedFiles ?? [])]}
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
                  : activeFolderId === 'trash'
                    ? '回收站'
                    : activeFolderId === 'all'
                      ? '默认'
                      : (folderPathNames(activeFolderId, folders ?? []) ?? '默认')}
              </span>
              {activeFolderId !== 'trash' && (
                <button
                  type="button"
                  className="tab-new-btn"
                  title="新建笔记"
                  onClick={() => void handleCreate()}
                >
                  <Plus size={14} />
                </button>
              )}
            </div>
          )}
        </div>

        <div className="app-topbar-right">
          {activeFile ? (
            isTrashFile ? (
              <>
                {activeFileUrl && (
                  <a
                    className="tool-btn"
                    href={activeFileUrl}
                    download={fileDownloadName(activeFile)}
                    title="下载"
                  >
                    <Download size={14} />
                    <span>下载</span>
                  </a>
                )}
                <button
                  type="button"
                  className="tool-btn"
                  title="恢复文件"
                  onClick={() => void handleRestoreFile(activeFile.id)}
                >
                  <RotateCcw size={14} />
                  <span>恢复</span>
                </button>
                <button
                  type="button"
                  className="tool-btn danger"
                  title="彻底删除"
                  onClick={() => void handlePermanentlyDeleteFile(activeFile.id)}
                >
                  <Trash2 size={14} />
                  <span>彻底删除</span>
                </button>
              </>
            ) : (
              <>
                <TagPicker
                  tags={activeFile.tags ?? []}
                  suggestions={[...tagCounts.keys()]}
                  onChange={handleFileTagsChange}
                />
                <ShareMenu userId={user.id} target={{ kind: 'file', fileId: activeFile.id }} />
                {activeFileUrl && (
                  <a
                    className="tool-btn"
                    href={activeFileUrl}
                    download={fileDownloadName(activeFile)}
                    title="下载"
                  >
                    <Download size={14} />
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
                  {isContentFullScreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                  <span>{isContentFullScreen ? '退出全屏' : '全屏'}</span>
                </button>
                <button
                  type="button"
                  className="tool-btn danger"
                  title="删除"
                  onClick={() => void handleDeleteFile()}
                >
                  <Trash2 size={14} />
                  <span>删除</span>
                </button>
              </>
            )
          ) : active ? (
            isTrashNote ? (
              <>
                <button
                  type="button"
                  className="tool-btn"
                  title="恢复笔记"
                  onClick={() => void handleRestoreNote(active.id)}
                >
                  <RotateCcw size={14} />
                  <span>恢复</span>
                </button>
                <button
                  type="button"
                  className="tool-btn danger"
                  title="彻底删除"
                  onClick={() => void handlePermanentlyDeleteNote(active.id)}
                >
                  <Trash2 size={14} />
                  <span>彻底删除</span>
                </button>
                <button
                  type="button"
                  className="tool-btn"
                  title="查看笔记信息"
                  onClick={() => setNoteInfoTarget(active)}
                >
                  <Info size={14} />
                  <span>信息</span>
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className={readingMode ? 'tool-btn active-tool' : 'tool-btn'}
                  title={readingMode ? '切换为编辑模式 (Ctrl+E)' : '切换为阅读模式 (Ctrl+E)'}
                  aria-label={readingMode ? '切换为编辑模式' : '切换为阅读模式'}
                  aria-pressed={readingMode}
                  onClick={toggleReadingMode}
                >
                  {readingMode ? <Edit3 size={14} /> : <BookOpen size={14} />}
                  <span>{readingMode ? '编辑' : '阅读'}</span>
                </button>
                {readingMode ? null : (
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
                )}
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
                  readingMode={readingMode}
                  onToggleReadingMode={toggleReadingMode}
                  onOpenInfo={() => setNoteInfoTarget(active)}
                />
              </>
            )
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
        {sidebarOpen && (
          <div
            className="sidebar-backdrop"
            onClick={() => {
              if (dragInfo) return
              setSidebarOpen(false)
            }}
            aria-label="关闭侧栏"
          />
        )}
        <Sidebar
          email={user.email ?? ''}
          collapsed={!sidebarOpen}
          folders={folders ?? []}
          counts={includeSubfolders ? subtreeCounts : folderCounts}
          allCount={
            (notes ?? []).filter((n) => n.folderId === null).length +
            (files ?? []).filter((f) => f.folderId === null).length
          }
          tags={tagCounts}
          activeFolderId={activeFolderId}
          activeTag={activeTag}
          trashCount={trashCount}
          onSelectFolder={handleSelectFolder}
          onCreateFolder={(name, parentId) => void handleCreateFolder(name, parentId)}
          onRenameFolder={(id, name) => void handleRenameFolder(id, name)}
          onDeleteFolder={(id) => void handleDeleteFolder(id)}
          onDropFolder={handleDropFolder}
          onToggleTag={handleToggleTag}
          onRenameTag={(oldName, newName) => void handleRenameTag(oldName, newName)}
          onDeleteTag={(name) => void handleDeleteTag(name)}
          onFilesDrop={(dropped, folderId) => {
            for (const file of dropped) void handleUpload(file, folderId)
          }}
          theme={theme}
          onThemeChange={changeTheme}
          onSignOut={() => void signOut()}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <NoteList
          notes={visibleNotes}
          files={filesInView}
          folders={folders ?? []}
          folderHits={activeFolderId === 'trash' ? [] : folderHits}
          activeId={activeId}
          currentFolderId={activeFolderId}
          isGrouped={isGroupedByFolder}
          search={search}
          userId={user.id}
          onSearch={handleSearch}
          onSelectFolderHit={handleSelectFolderHit}
          folderPathOf={(id) => folderPathNames(id, folders ?? [])}
          onGotoFolder={handleGotoFolder}
          onSelectTag={handleSelectTag}
          onSelect={handleSelect}
          onCreate={() => void handleCreate()}
          onSelectFile={handleSelectFile}
          onUpload={(file) => void handleUpload(file)}
          onRenameNote={handleRenameNote}
          onRenameFile={handleRenameFile}
          onMoveNote={handleDropNote}
          onMoveFile={handleDropFile}
          onRequestPush={requestPush}
          dragActive={!!dragInfo}
          onMoveStep={handleMoveStep}
          onMoveEdge={handleMoveEdge}
          onShowNoteInfo={(note) => setNoteInfoTarget(note)}
          emptyHint={
            activeFolderId === 'trash'
              ? '回收站是空的'
              : activeFolderId === 'all'
                ? '暂无内容'
                : '此文件夹还没有内容'
          }
          isTrash={activeFolderId === 'trash'}
          onRestoreNote={handleRestoreNote}
          onPermanentlyDeleteNote={handlePermanentlyDeleteNote}
          onRestoreFile={handleRestoreFile}
          onPermanentlyDeleteFile={handlePermanentlyDeleteFile}
          onEmptyTrash={handleEmptyTrash}
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
          {(isTrashNote || isTrashFile) && (
            <div className="trash-banner">
              <div className="trash-banner-text">
                <span>此{isTrashNote ? '笔记' : '文件'}已在回收站中</span>
              </div>
              <div className="trash-banner-actions">
                <button
                  type="button"
                  className="trash-banner-btn restore"
                  onClick={() => {
                    if (isTrashNote && active) void handleRestoreNote(active.id)
                    else if (isTrashFile && activeFile) void handleRestoreFile(activeFile.id)
                  }}
                >
                  <RotateCcw size={13} />
                  <span>恢复</span>
                </button>
                <button
                  type="button"
                  className="trash-banner-btn delete"
                  onClick={() => {
                    if (isTrashNote && active) void handlePermanentlyDeleteNote(active.id)
                    else if (isTrashFile && activeFile) void handlePermanentlyDeleteFile(activeFile.id)
                  }}
                >
                  <Trash2 size={13} />
                  <span>彻底删除</span>
                </button>
              </div>
            </div>
          )}
          {activeFile ? (
            <div className="file-view">
              {activeFileUrl ? (
                isHtmlFile(activeFile) ? (
                  <HtmlViewer src={activeFileUrl} />
                ) : (
                  <Suspense fallback={<p className="file-view-fallback">正在加载…</p>}>
                    <PdfViewer key={activeFile.id} fileId={activeFile.id} src={activeFileUrl} />
                  </Suspense>
                )
              ) : fileLoadError ? (
                <p className="file-view-fallback">文件加载失败（云端文件可能已被删除或网络不可用）</p>
              ) : (
                <p className="file-view-fallback">正在从云端加载文件…</p>
              )}
            </div>
          ) : active ? (
            <>
              <div className="editor-scroll">
                <div className="editor-head">
                  {readingMode || isTrashNote ? (
                    <h1
                      className={`editor-title-static ${!active.title?.trim() ? 'untitled' : ''}`}
                      title={isTrashNote ? undefined : '双击进入编辑模式'}
                      onDoubleClick={() => {
                        if (isTrashNote) return
                        toggleReadingMode()
                        setTimeout(() => {
                          titleRef.current?.focus()
                        }, 50)
                      }}
                    >
                      {active.title?.trim() || '无标题'}
                    </h1>
                  ) : (
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
                  )}
                </div>
                <EditorBoundary>
                  <Editor
                    key={active.id}
                    content={active.content}
                    onUpdate={(content) => scheduleSave(active.id, { content })}
                    toolbarHidden={toolbarHidden}
                    readOnly={readingMode || isTrashNote}
                  />
                </EditorBoundary>
              </div>
              <div className="editor-footer">
                <button
                  type="button"
                  className="editor-footer-btn"
                  onClick={() => setNoteInfoTarget(active)}
                  title="查看笔记信息"
                >
                  <span>{countWords(active.content)} 字</span>
                  <Info size={12} className="editor-footer-icon" />
                </button>
              </div>
            </>
          ) : (
            <EmptyState />
          )}
        </main>
      </div>
      </div>
      <DialogHost />
      <NoteInfoModal
        isOpen={!!noteInfoTarget}
        note={
          noteInfoTarget && active && noteInfoTarget.id === active.id
            ? active
            : noteInfoTarget
        }
        folderPath={
          noteInfoTarget?.folderId
            ? folderPathNames(noteInfoTarget.folderId, folders ?? [])
            : null
        }
        onClose={() => setNoteInfoTarget(null)}
      />
      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        includeSubfolders={includeSubfolders}
        onToggleIncludeSubfolders={handleToggleIncludeSubfolders}
        toolbarHidden={toolbarHidden}
        onToggleToolbarHidden={(hidden) => {
          setToolbarHidden(hidden)
          void savePrefs({ toolbarHidden: hidden, theme, includeSubfolders }).catch(() => {})
        }}
        readingMode={readingMode}
        onToggleReadingMode={(rm) => {
          setReadingMode(rm)
          try {
            localStorage.setItem(READING_MODE_KEY, String(rm))
          } catch {}
        }}
        email={user?.email}
      />
      {/* 跟手拖影：被拖卡片的简化克隆（投影+微缩放），原位留空槽由 SortableCard 处理 */}
      <DragOverlay dropAnimation={isOverZone ? null : dropAnimationConfig}>
        {activeDragItem ? (
          <div className="dnd-card-ghost">
            <FileText size={15} />
            <span className="dnd-card-ghost-title">{activeDragItem.title}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

