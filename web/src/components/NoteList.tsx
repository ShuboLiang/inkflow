import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import {
  FileText,
  Folder as FolderIcon,
  Search,
  X,
  MoreHorizontal,
  RotateCcw,
  Trash2,
  ChevronRight,
} from 'lucide-react'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { FileEntry, Folder, Note } from '../lib/db'
import { firstLine } from '../lib/wordCount'
import { softDeleteNote } from '../store/notes'
import { acquireFileUrl, deleteFile } from '../store/files'
import { createFileShare, createNoteShare, shareUrl } from '../store/shares'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { MoveFolderModal } from './MoveFolderModal'
import { DropZone } from './Sidebar'
import { confirmDialog } from '../lib/dialog'
import { matchSnippet } from '../lib/search'
import { fileDownloadName, isHtmlFile } from '../lib/importFile'
import './NoteList.css'

interface NoteListProps {
  notes: Note[]
  files: FileEntry[]
  folders: Folder[]
  folderHits: Array<{ id: string; name: string; path: string }>
  activeId: string | null
  currentFolderId: string | null
  isGrouped?: boolean
  search: string
  userId: string
  onSearch: (q: string) => void
  onSelectFolderHit: (id: string) => void
  folderPathOf: (folderId: string) => string | null
  onGotoFolder: (id: string) => void
  onSelectTag: (tag: string) => void
  onSelect: (id: string) => void
  onCreate: () => void
  onSelectFile: (id: string) => void
  onUpload: (file: File) => void
  onRenameNote: (id: string) => void
  onRenameFile: (id: string, filename: string) => void
  onMoveNote: (noteId: string, folderId: string | null) => void
  onMoveFile: (fileId: string, folderId: string | null) => void
  onRequestPush: () => void
  /** dnd-kit 拖拽进行中（App 的 DndContext 驱动）：全量渲染 + 抑制右键菜单 */
  dragActive: boolean
  /** 手动排序（菜单）：上移/下移一步 */
  onMoveStep: (kind: 'note' | 'file', id: string, dir: -1 | 1) => void
  /** 手动排序（菜单）：直接移到顶部/底部 */
  onMoveEdge: (kind: 'note' | 'file', id: string, edge: 'top' | 'bottom') => void
  onShowNoteInfo?: (note: Note) => void
  emptyHint?: string
  isTrash?: boolean
  onRestoreNote?: (id: string) => void
  onPermanentlyDeleteNote?: (id: string) => void
  onRestoreFile?: (id: string) => void
  onPermanentlyDeleteFile?: (id: string) => void
  onEmptyTrash?: () => void
}

// 可排序卡片外壳：dnd-kit sortable 挂在 .card-wrap 上。拖起时用 DragOverlay 显示
// 跟手拖影（App 渲染），原位保留空槽（.dnd-dragging 半透明虚线框），其余卡片平滑让位
function SortableCard({
  id,
  kind,
  dragActive,
  dragJustEndedRef,
  children,
}: {
  id: string
  kind: 'note' | 'file'
  dragActive: boolean
  dragJustEndedRef: RefObject<boolean>
  children: ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    data: { type: 'item', kind },
  })
  return (
    <div
      ref={setNodeRef}
      className={isDragging ? 'card-wrap dnd-dragging' : 'card-wrap'}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      onClickCapture={(e) => {
        if (dragActive || dragJustEndedRef.current) {
          e.stopPropagation()
        }
      }}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  )
}

// 列表增量渲染的每批条数
const RENDER_PAGE = 60

interface TipTapNode {
  type?: string
  text?: string
  content?: TipTapNode[]
}

function excerptOf(content: unknown): string {
  const paragraphs: string[] = []
  const textOf = (node: TipTapNode): string => {
    if (node.type === 'text') return node.text ?? ''
    if (node.type === 'inlineMath' || node.type === 'blockMath') return '[公式]'
    if (node.type === 'image') return '[图片]'
    return (node.content ?? []).map(textOf).join('')
  }
  const root = content as TipTapNode | null
  for (const child of root?.content ?? []) {
    if (paragraphs.length >= 2) break
    const text = textOf(child).trim()
    if (text) paragraphs.push(text)
  }
  return paragraphs.join(' ') || '无内容'
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatSize(size: number | null): string {
  if (!size) return ''
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

export function NoteList({
  notes,
  files,
  folders,
  folderHits,
  activeId,
  currentFolderId,
  isGrouped = false,
  search,
  userId,
  onSearch,
  onSelectFolderHit,
  folderPathOf,
  onGotoFolder,
  onSelectTag,
  onSelect,
  onCreate,
  onSelectFile,
  onUpload,
  onRenameNote,
  onRenameFile,
  onMoveNote,
  onMoveFile,
  onRequestPush,
  dragActive,
  onMoveStep,
  onMoveEdge,
  onShowNoteInfo,
  emptyHint,
  isTrash,
  onRestoreNote,
  onPermanentlyDeleteNote,
  onRestoreFile,
  onPermanentlyDeleteFile,
  onEmptyTrash,
}: NoteListProps) {
  const uploadRef = useRef<HTMLInputElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'note' | 'file'; id: string } | null>(null)
  // 「移动到文件夹…」弹窗目标
  const [movingTarget, setMovingTarget] = useState<{
    kind: 'note' | 'file'
    id: string
    title: string
    folderId: string | null
  } | null>(null)
  const [renamingFileId, setRenamingFileId] = useState<string | null>(null)
  // 增量渲染：一次只渲染前 RENDER_PAGE 条，滚近底部再追加，避免大列表全量挂 DOM
  const [renderLimit, setRenderLimit] = useState(RENDER_PAGE)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 外部文件拖入的进入深度（0 = 未拖入），用于显示放置遮罩
  const [fileDragDepth, setFileDragDepth] = useState(0)

  const isFileDrag = (e: React.DragEvent) => e.dataTransfer.types.includes('Files')

  const showToast = (msg: string) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2200)
  }

  // 换搜索词时回到第一批（渲染期调整状态，避免 effect 级联渲染）
  const [lastSearch, setLastSearch] = useState(search)
  if (lastSearch !== search) {
    setLastSearch(search)
    setRenderLimit(RENDER_PAGE)
  }

  // 拖拽刚结束标记：防止拖拽释放时误触卡片单击打开笔记
  const prevDragActive = useRef(dragActive)
  const dragJustEndedRef = useRef(false)
  useEffect(() => {
    if (prevDragActive.current && !dragActive) {
      dragJustEndedRef.current = true
      const timer = setTimeout(() => {
        dragJustEndedRef.current = false
      }, 300)
      return () => clearTimeout(timer)
    }
    prevDragActive.current = dragActive
  }, [dragActive])

  // 哨兵进入视口（提前 300px）就追加下一批
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setRenderLimit((l) => l + RENDER_PAGE)
        }
      },
      { rootMargin: '300px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  // 创建（或复用）分享并复制链接；文件需已上云（createFileShare 内部会处理）
  const copyShareLink = async (kind: 'note' | 'file', id: string) => {
    try {
      const share =
        kind === 'note' ? await createNoteShare(userId, id) : await createFileShare(userId, id)
      await navigator.clipboard.writeText(shareUrl(share.token))
      showToast('分享链接已复制')
    } catch {
      showToast('创建分享失败（文件需先同步上云）')
    }
  }

  const downloadFile = async (id: string) => {
    const file = files.find((f) => f.id === id)
    if (!file) return
    const url = await acquireFileUrl(id)
    if (!url) {
      showToast('文件内容不可用（可能尚未同步）')
      return
    }
    const a = document.createElement('a')
    a.href = url
    a.download = fileDownloadName(file)
    a.click()
  }

  const deleteNoteById = async (id: string) => {
    const note = notes.find((n) => n.id === id)
    const ok = await confirmDialog({
      title: '删除笔记',
      message: `删除笔记「${note?.title || '无标题'}」？`,
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    await softDeleteNote(id)
    onRequestPush()
  }

  const deleteFileById = async (id: string) => {
    const file = files.find((f) => f.id === id)
    const ok = await confirmDialog({
      title: '删除文件',
      message: `删除文件「${file?.filename ?? ''}」？`,
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    await deleteFile(id)
    onRequestPush()
  }

  const menuItems = (m: { x: number; y: number; kind: 'note' | 'file'; id: string }): MenuItem[] => {
    const target =
      m.kind === 'note' ? notes.find((n) => n.id === m.id) : files.find((f) => f.id === m.id)

    // 非搜索状态下，若目标文件/笔记已在当前文件夹，跳到所在文件夹是多余的，予以隐藏
    const isAlreadyInSameFolder =
      !search.trim() &&
      target?.folderId &&
      currentFolderId === target.folderId

    const gotoFolderItem: MenuItem | null =
      target?.folderId && !isAlreadyInSameFolder
        ? {
            key: 'goto',
            label: '跳到所在文件夹',
            onClick: () => onGotoFolder(target.folderId as string),
          }
        : null

    const moveItem: MenuItem = {
      key: 'move',
      label: '移动到文件夹…',
      onClick: () => {
        const title =
          m.kind === 'note'
            ? (target as Note)?.title || firstLine((target as Note)?.content) || '无标题'
            : (target as FileEntry)?.filename || '文件'
        setMovingTarget({
          kind: m.kind,
          id: m.id,
          title,
          folderId: target?.folderId ?? null,
        })
      },
    }

    if (isTrash) {
      if (m.kind === 'note') {
        return [
          { key: 'open', label: '查看', onClick: () => onSelect(m.id) },
          { key: 'restore', label: '恢复', onClick: () => onRestoreNote?.(m.id) },
          ...(onShowNoteInfo && target
            ? [{ key: 'info', label: '笔记信息', onClick: () => onShowNoteInfo(target as Note) }]
            : []),
          { key: 'd1', label: '', divider: true, onClick: () => {} },
          { key: 'del', label: '彻底删除', danger: true, onClick: () => onPermanentlyDeleteNote?.(m.id) },
        ]
      }
      return [
        { key: 'open', label: '查看', onClick: () => onSelectFile(m.id) },
        { key: 'dl', label: '下载', onClick: () => void downloadFile(m.id) },
        { key: 'restore', label: '恢复', onClick: () => onRestoreFile?.(m.id) },
        { key: 'd1', label: '', divider: true, onClick: () => {} },
        { key: 'del', label: '彻底删除', danger: true, onClick: () => onPermanentlyDeleteFile?.(m.id) },
      ]
    }

    return m.kind === 'note'
      ? [
          { key: 'open', label: '打开', onClick: () => onSelect(m.id) },
          { key: 'up', label: '上移', onClick: () => onMoveStep('note', m.id, -1) },
          { key: 'down', label: '下移', onClick: () => onMoveStep('note', m.id, 1) },
          { key: 'top', label: '移到顶部', onClick: () => onMoveEdge('note', m.id, 'top') },
          { key: 'bottom', label: '移到底部', onClick: () => onMoveEdge('note', m.id, 'bottom') },
          ...(gotoFolderItem ? [gotoFolderItem] : []),
          moveItem,
          { key: 'share', label: '复制分享链接', onClick: () => void copyShareLink('note', m.id) },
          { key: 'rename', label: '重命名', onClick: () => onRenameNote(m.id) },
          ...(onShowNoteInfo && target
            ? [{ key: 'info', label: '笔记信息', onClick: () => onShowNoteInfo(target as Note) }]
            : []),
          { key: 'd1', label: '', divider: true, onClick: () => {} },
          { key: 'del', label: '删除', danger: true, onClick: () => void deleteNoteById(m.id) },
        ]
      : [
          { key: 'open', label: '打开', onClick: () => onSelectFile(m.id) },
          { key: 'up', label: '上移', onClick: () => onMoveStep('file', m.id, -1) },
          { key: 'down', label: '下移', onClick: () => onMoveStep('file', m.id, 1) },
          { key: 'top', label: '移到顶部', onClick: () => onMoveEdge('file', m.id, 'top') },
          { key: 'bottom', label: '移到底部', onClick: () => onMoveEdge('file', m.id, 'bottom') },
          ...(gotoFolderItem ? [gotoFolderItem] : []),
          moveItem,
          { key: 'rename', label: '重命名', onClick: () => setRenamingFileId(m.id) },
          { key: 'dl', label: '下载', onClick: () => void downloadFile(m.id) },
          { key: 'share', label: '复制分享链接', onClick: () => void copyShareLink('file', m.id) },
          { key: 'd1', label: '', divider: true, onClick: () => {} },
          { key: 'del', label: '删除', danger: true, onClick: () => void deleteFileById(m.id) },
        ]
  }

  const openMenu = (e: React.MouseEvent, kind: 'note' | 'file', id: string) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, kind, id })
  }

  // 搜索时卡片摘要显示「命中词前后片段」；未搜索或仅标题命中则回退普通摘要
  const excerptFor = (note: Note) => {
    const q = search.trim()
    const snip = q ? matchSnippet(note.content, q) : null
    if (!snip) return <div className="note-card-excerpt">{excerptOf(note.content)}</div>
    return (
      <div className="note-card-excerpt">
        {snip.beforeCut && '…'}
        {snip.before}
        <mark className="note-card-hit">{snip.hit}</mark>
        {snip.after}
        {snip.afterCut && '…'}
      </div>
    )
  }

  // 触屏设备没有右键：卡片右上角按钮打开同一个菜单，锚在按钮下方
  const moreButton = (kind: 'note' | 'file', id: string, label: string) => (
    <button
      type="button"
      className="card-more"
      aria-label={`${label} 更多操作`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        const r = e.currentTarget.getBoundingClientRect()
        setMenu({ x: r.left, y: r.bottom + 4, kind, id })
      }}
    >
      <MoreHorizontal size={15} />
    </button>
  )

  // 当处于分组模式时，计算文件夹呈现排位：当前文件夹居首(0)，后代按深度优先遍历各占一段(1, 2, 3...)
  const folderGroupRanks = useMemo(() => {
    if (!isGrouped || !currentFolderId || currentFolderId === 'all') return null
    const ranks = new Map<string, number>()
    ranks.set(currentFolderId, 0)
    let seq = 0
    const childMap = new Map<string | null, Folder[]>()
    for (const f of folders) {
      const p = f.parentId ?? null
      const list = childMap.get(p) ?? []
      list.push(f)
      childMap.set(p, list)
    }
    for (const list of childMap.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    }
    const walk = (id: string) => {
      for (const ch of childMap.get(id) ?? []) {
        ranks.set(ch.id, ++seq)
        walk(ch.id)
      }
    }
    walk(currentFolderId)
    return ranks
  }, [isGrouped, currentFolderId, folders])

  // 统一列表：文件与笔记合并排序
  // 在回收站按删除时间倒序排列；分组视图优先按文件夹呈现排位，组内按 position 顺序（无 position 的按创建时间兜底排后）
  const listItems = useMemo(
    () =>
      [
        ...files.map((f) => ({
          kind: 'file' as const,
          id: f.id,
          folderId: f.folderId ?? null,
          position: f.position ?? Infinity,
          createdAt: f.createdAt ?? f.updatedAt,
          deletedAt: f.deletedAt ?? 0,
        })),
        ...notes.map((n) => ({
          kind: 'note' as const,
          id: n.id,
          folderId: n.folderId ?? null,
          position: n.position ?? Infinity,
          createdAt: n.createdAt ?? n.updatedAt,
          deletedAt: n.deletedAt ?? 0,
        })),
      ].sort((a, b) => {
        if (isTrash) return b.deletedAt - a.deletedAt
        if (isGrouped && folderGroupRanks) {
          const rankA = folderGroupRanks.get(a.folderId ?? '') ?? 999999
          const rankB = folderGroupRanks.get(b.folderId ?? '') ?? 999999
          if (rankA !== rankB) return rankA - rankB
        }
        return a.position - b.position || b.createdAt - a.createdAt
      }),
    [files, notes, isTrash, isGrouped, folderGroupRanks],
  )

  // 文件夹相对路径（从当前激活的根文件夹算起）
  const relativeFolderPath = (folderId: string, baseFolderId: string, folderList: Folder[]): string => {
    const names: string[] = []
    let curr: string | null = folderId
    while (curr && curr !== baseFolderId) {
      const f = folderList.find((x) => x.id === curr)
      if (!f) break
      names.unshift(f.name)
      curr = f.parentId ?? null
    }
    return names.join(' / ') || '子文件夹'
  }

  // 拖拽中放开增量渲染：全部项挂上 sortable，未挂载的项没有碰撞矩形没法排
  const effectiveLimit = dragActive ? listItems.length : renderLimit
  const renderedItems = listItems.slice(0, effectiveLimit)

  // 组织分组数据：仅当开启分组且包含子文件夹项目时生效
  const folderGroups = useMemo(() => {
    if (!isGrouped || !currentFolderId || currentFolderId === 'all') return null

    // 检查是否有来自子文件夹的项目
    const hasSubfolderItems = listItems.some(
      (it) => it.folderId !== null && it.folderId !== currentFolderId,
    )
    if (!hasSubfolderItems) return null

    type Group = {
      folderId: string
      name: string
      isDirect: boolean
      items: typeof renderedItems
    }

    const groups: Group[] = []

    // 1. 直属内容
    const directItems = renderedItems.filter((it) => (it.folderId ?? null) === currentFolderId)
    if (directItems.length > 0) {
      groups.push({
        folderId: currentFolderId,
        name: '直属内容',
        isDirect: true,
        items: directItems,
      })
    }

    // 2. 子孙文件夹分组（按已排序的 folderGroupRanks 顺序收集）
    const subfolderIds = Array.from(
      new Set(
        renderedItems
          .map((it) => it.folderId)
          .filter((fid): fid is string => Boolean(fid && fid !== currentFolderId)),
      ),
    ).sort((a, b) => (folderGroupRanks?.get(a) ?? 999999) - (folderGroupRanks?.get(b) ?? 999999))

    for (const sfId of subfolderIds) {
      const items = renderedItems.filter((it) => it.folderId === sfId)
      if (items.length > 0) {
        groups.push({
          folderId: sfId,
          name: relativeFolderPath(sfId, currentFolderId, folders),
          isDirect: false,
          items,
        })
      }
    }

    return groups.length > 0 ? groups : null
  }, [isGrouped, currentFolderId, listItems, renderedItems, folders, folderGroupRanks])

  const renderItemCard = (it: (typeof listItems)[number]) => {
    if (it.kind === 'file') {
      const file = files.find((f) => f.id === it.id)
      if (!file) return null
      const cardContent = renamingFileId === file.id ? (
        <input
          key={file.id}
          className="note-card file-rename-input"
          defaultValue={file.filename}
          aria-label="重命名文件"
          autoFocus
          onFocus={(e) => e.target.select()}
          onBlur={(e) => {
            setRenamingFileId(null)
            onRenameFile(file.id, e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') setRenamingFileId(null)
          }}
        />
      ) : (
        <>
          <button
            type="button"
            className="note-card file-card"
            onClick={() => {
              if (dragActive || dragJustEndedRef.current) return
              onSelectFile(file.id)
            }}
            onContextMenu={(e) => {
              // Android 长按启动拖拽时会带出系统菜单
              if (dragActive) {
                e.preventDefault()
                return
              }
              openMenu(e, 'file', file.id)
            }}
          >
            <div className="note-card-title file-card-title">
              <FileText size={16} />
              <span className="file-card-name" title={file.filename}>
                {file.filename}
              </span>
              <span className={isTrash ? 'trash-type-badge' : 'file-card-badge'}>
                {isHtmlFile(file) ? 'HTML' : 'PDF'}
              </span>
            </div>
            <div className="note-card-time">
              {isTrash && file.deletedAt
                ? `删除于 ${formatTime(file.deletedAt)}`
                : [formatSize(file.size), formatTime(file.updatedAt)].filter(Boolean).join(' · ')}
            </div>
            {!isTrash && (file.tags ?? []).length > 0 && (
              <div className="note-card-tags">
                {(file.tags ?? []).slice(0, 3).map((t) => (
                  <span
                    key={t}
                    className="note-card-tag tag-jump"
                    title={`按标签筛选：${t}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onSelectTag(t)
                    }}
                  >
                    # {t}
                  </span>
                ))}
                {(file.tags ?? []).length > 3 && (
                  <span className="note-card-tag">+{(file.tags ?? []).length - 3}</span>
                )}
              </div>
            )}
            {!isTrash &&
              !folderGroups &&
              (search.trim() ||
                (currentFolderId && currentFolderId !== 'all' && file.folderId !== currentFolderId)) &&
              file.folderId && (
              <span
                className="note-card-loc"
                title={`跳到文件夹：${folderPathOf(file.folderId) ?? ''}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onGotoFolder(file.folderId as string)
                }}
              >
                <FolderIcon size={12} />
                {folderPathOf(file.folderId)}
              </span>
            )}
            {isTrash && (
              <div className="trash-card-footer">
                <span
                  className="trash-orig-loc"
                  title={file.folderId ? `原位置：${folderPathOf(file.folderId) ?? ''}` : '原位置：根目录'}
                >
                  <FolderIcon size={11} />
                  <span>{file.folderId ? (folderPathOf(file.folderId) ?? '未知文件夹') : '根目录'}</span>
                </span>
                <div className="trash-card-actions">
                  <button
                    type="button"
                    className="trash-card-action-btn"
                    title="恢复"
                    onClick={(e) => {
                      e.stopPropagation()
                      onRestoreFile?.(file.id)
                    }}
                  >
                    <RotateCcw size={11} />
                    <span>恢复</span>
                  </button>
                  <button
                    type="button"
                    className="trash-card-action-btn danger"
                    title="彻底删除"
                    onClick={(e) => {
                      e.stopPropagation()
                      onPermanentlyDeleteFile?.(file.id)
                    }}
                  >
                    <Trash2 size={11} />
                    <span>彻底删除</span>
                  </button>
                </div>
              </div>
            )}
          </button>
          {moreButton('file', file.id, file.filename)}
        </>
      )

      return isTrash ? (
        <div key={file.id} className="card-wrap">
          {cardContent}
        </div>
      ) : (
        <SortableCard key={file.id} id={file.id} kind="file" dragActive={dragActive} dragJustEndedRef={dragJustEndedRef}>
          {cardContent}
        </SortableCard>
      )
    }

    const note = notes.find((n) => n.id === it.id)
    if (!note) return null
    const noteCardContent = (
      <>
        <button
          type="button"
          className={note.id === activeId ? 'note-card active' : 'note-card'}
          onClick={() => {
            if (dragActive || dragJustEndedRef.current) return
            onSelect(note.id)
          }}
          onContextMenu={(e) => {
            if (dragActive) {
              e.preventDefault()
              return
            }
            openMenu(e, 'note', note.id)
          }}
        >
          <div className="note-card-title">
            <span>{note.title || firstLine(note.content) || '无标题'}</span>
            {isTrash && <span className="trash-type-badge">笔记</span>}
          </div>
          {excerptFor(note)}
          {!isTrash &&
            !folderGroups &&
            (search.trim() ||
              (currentFolderId && currentFolderId !== 'all' && note.folderId !== currentFolderId)) &&
            note.folderId && (
            <span
              className="note-card-loc"
              title={`跳到文件夹：${folderPathOf(note.folderId) ?? ''}`}
              onClick={(e) => {
                e.stopPropagation()
                onGotoFolder(note.folderId as string)
              }}
            >
              <FolderIcon size={12} />
              {folderPathOf(note.folderId)}
            </span>
          )}
          {!isTrash && (note.tags ?? []).length > 0 && (
            <div className="note-card-tags">
              {(note.tags ?? []).slice(0, 3).map((t) => (
                <span
                  key={t}
                  className="note-card-tag tag-jump"
                  title={`按标签筛选：${t}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onSelectTag(t)
                  }}
                >
                  # {t}
                </span>
              ))}
              {(note.tags ?? []).length > 3 && (
                <span className="note-card-tag">+{(note.tags ?? []).length - 3}</span>
              )}
            </div>
          )}
          <div className="note-card-time">
            {isTrash && note.deletedAt
              ? `删除于 ${formatTime(note.deletedAt)}`
              : formatTime(note.updatedAt)}
          </div>
          {isTrash && (
            <div className="trash-card-footer">
              <span
                className="trash-orig-loc"
                title={note.folderId ? `原位置：${folderPathOf(note.folderId) ?? ''}` : '原位置：根目录'}
              >
                <FolderIcon size={11} />
                <span>{note.folderId ? (folderPathOf(note.folderId) ?? '未知文件夹') : '根目录'}</span>
              </span>
              <div className="trash-card-actions">
                <button
                  type="button"
                  className="trash-card-action-btn"
                  title="恢复"
                  onClick={(e) => {
                    e.stopPropagation()
                    onRestoreNote?.(note.id)
                  }}
                >
                  <RotateCcw size={11} />
                  <span>恢复</span>
                </button>
                <button
                  type="button"
                  className="trash-card-action-btn danger"
                  title="彻底删除"
                  onClick={(e) => {
                    e.stopPropagation()
                    onPermanentlyDeleteNote?.(note.id)
                  }}
                >
                  <Trash2 size={11} />
                  <span>彻底删除</span>
                </button>
              </div>
            </div>
          )}
        </button>
        {moreButton('note', note.id, note.title || '无标题')}
      </>
    )

    return isTrash ? (
      <div key={note.id} className="card-wrap">
        {noteCardContent}
      </div>
    ) : (
      <SortableCard key={note.id} id={note.id} kind="note" dragActive={dragActive} dragJustEndedRef={dragJustEndedRef}>
        {noteCardContent}
      </SortableCard>
    )
  }

  return (
    <section
      className="note-list"
      aria-label={isTrash ? '回收站' : '文件夹内容'}
      onDragEnter={(e) => {
        if (!isFileDrag(e) || isTrash) return
        e.preventDefault()
        setFileDragDepth((d) => d + 1)
      }}
      onDragOver={(e) => {
        if (isFileDrag(e) && !isTrash) e.preventDefault()
      }}
      onDragLeave={(e) => {
        if (!isFileDrag(e) || isTrash) return
        setFileDragDepth((d) => Math.max(0, d - 1))
      }}
      onDrop={(e) => {
        if (!isFileDrag(e) || isTrash) return
        e.preventDefault()
        setFileDragDepth(0)
        for (const file of Array.from(e.dataTransfer.files)) onUpload(file)
      }}
    >
      {isTrash && (
        <div className="trash-header">
          <div className="trash-header-info">
            <span className="trash-header-title">回收站</span>
            <span className="trash-header-count">{notes.length + files.length} 个项目</span>
          </div>
          {notes.length + files.length > 0 && onEmptyTrash && (
            <button
              type="button"
              className="trash-empty-btn"
              onClick={onEmptyTrash}
              title="清空回收站中所有项目"
            >
              <Trash2 size={13} />
              <span>清空回收站</span>
            </button>
          )}
        </div>
      )}
      <div className="note-list-search">
        <div className="note-list-search-inner">
          <Search size={14} className="note-list-search-icon" aria-hidden="true" />
          <input
            id="note-search"
            type="search"
            placeholder={isTrash ? '搜索回收站' : '搜索全部笔记'}
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            aria-label={isTrash ? '搜索回收站' : '搜索笔记'}
          />
          {search && (
            <button
              type="button"
              className="note-list-search-clear"
              onClick={() => onSearch('')}
              aria-label="清空搜索"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>
      <div className="note-list-items">
        {notes.length === 0 && files.length === 0 && folderHits.length === 0 ? (
          <div className="note-list-empty">
            {search.trim() ? `没有找到与「${search.trim()}」相关的内容` : (emptyHint ?? '暂无内容')}
          </div>
        ) : (
          <>
            {folderHits.length > 0 && (
              <>
                <div className="note-list-group-label">文件夹</div>
                {folderHits.map((hit) => (
                  <button
                    key={hit.id}
                    type="button"
                    className="note-card folder-hit-card"
                    onClick={() => onSelectFolderHit(hit.id)}
                  >
                    <div className="note-card-title folder-hit-title">
                      <FolderIcon size={16} />
                      <span className="folder-hit-name">{hit.name}</span>
                    </div>
                    <div className="note-card-time folder-hit-path">{hit.path}</div>
                  </button>
                ))}
              </>
            )}
            <SortableContext items={isTrash ? [] : renderedItems.map((it) => it.id)} strategy={verticalListSortingStrategy}>
              {folderGroups ? (
                folderGroups.map((group) => (
                  <div key={group.folderId} className="note-list-folder-group">
                    <DropZone
                      dndId={`folder-zone:${group.folderId}`}
                      accept={['item']}
                      className={`note-list-folder-group-header ${group.isDirect ? 'is-direct' : ''}`}
                      onClick={() => {
                        if (!group.isDirect) onGotoFolder(group.folderId)
                      }}
                    >
                      <div className="note-list-group-header-left">
                        <FolderIcon size={14} className="note-list-group-icon" />
                        <span className="note-list-group-title">{group.name}</span>
                        <span className="note-list-group-count">{group.items.length}</span>
                      </div>
                      {!group.isDirect && (
                        <button
                          type="button"
                          className="note-list-group-jump-btn"
                          title={`进入文件夹「${group.name}」`}
                          onClick={(e) => {
                            e.stopPropagation()
                            onGotoFolder(group.folderId)
                          }}
                        >
                          <span>进入</span>
                          <ChevronRight size={12} />
                        </button>
                      )}
                    </DropZone>
                    <div className="note-list-group-cards">
                      {group.items.map(renderItemCard)}
                    </div>
                  </div>
                ))
              ) : (
                renderedItems.map(renderItemCard)
              )}
            </SortableContext>
            {!dragActive && files.length + notes.length > renderLimit && (
              <div ref={sentinelRef} className="note-list-more">
                加载更多（已显示 {Math.min(renderLimit, files.length + notes.length)} / {files.length + notes.length}）
              </div>
            )}
          </>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={() => setMenu(null)} />}
      {movingTarget && (
        <MoveFolderModal
          isOpen={true}
          targetTitle={movingTarget.title}
          currentFolderId={movingTarget.folderId}
          folders={folders}
          onSelectFolder={(targetFolderId) => {
            if (movingTarget.kind === 'note') {
              onMoveNote(movingTarget.id, targetFolderId)
            } else {
              onMoveFile(movingTarget.id, targetFolderId)
            }
            setMovingTarget(null)
          }}
          onClose={() => setMovingTarget(null)}
        />
      )}
      {fileDragDepth > 0 && (
        <div className="note-list-drop-overlay">松开以上传到当前文件夹（md/html 新建笔记，pdf 存为文件）</div>
      )}
      {toast && (
        <div className="note-list-toast" role="status">
          {toast}
        </div>
      )}
      {!isTrash && (
        <div className="note-list-footer">
          <button type="button" className="note-list-new" onClick={onCreate}>
            新建笔记
          </button>
          <button
            type="button"
            className="note-list-upload"
            title="上传文件到当前文件夹（md/html 新建笔记，pdf 存为文件）"
            onClick={() => uploadRef.current?.click()}
          >
            上传文件
          </button>
          <input
            ref={uploadRef}
            type="file"
            hidden
            accept=".md,.markdown,.html,.htm,.pdf"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) onUpload(file)
            }}
          />
        </div>
      )}
    </section>
  )
}
