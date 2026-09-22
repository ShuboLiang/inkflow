import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import {
  FileText,
  Folder as FolderIcon,
  Search,
  X,
  MoreHorizontal,
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

  // 统一列表：文件与笔记按 position 合并成同一顺序（无 position 的按创建时间兜底排后）
  const listItems = useMemo(
    () =>
      [
        ...files.map((f) => ({
          kind: 'file' as const,
          id: f.id,
          position: f.position ?? Infinity,
          createdAt: f.createdAt ?? f.updatedAt,
        })),
        ...notes.map((n) => ({
          kind: 'note' as const,
          id: n.id,
          position: n.position ?? Infinity,
          createdAt: n.createdAt ?? n.updatedAt,
        })),
      ].sort((a, b) => a.position - b.position || b.createdAt - a.createdAt),
    [files, notes],
  )

  // 拖拽中放开增量渲染：全部项挂上 sortable，未挂载的项没有碰撞矩形没法排
  const effectiveLimit = dragActive ? listItems.length : renderLimit
  const renderedItems = listItems.slice(0, effectiveLimit)

  return (
    <section
      className="note-list"
      aria-label="文件夹内容"
      onDragEnter={(e) => {
        if (!isFileDrag(e)) return
        e.preventDefault()
        setFileDragDepth((d) => d + 1)
      }}
      onDragOver={(e) => {
        if (isFileDrag(e)) e.preventDefault()
      }}
      onDragLeave={(e) => {
        if (!isFileDrag(e)) return
        setFileDragDepth((d) => Math.max(0, d - 1))
      }}
      onDrop={(e) => {
        if (!isFileDrag(e)) return
        e.preventDefault()
        setFileDragDepth(0)
        for (const file of Array.from(e.dataTransfer.files)) onUpload(file)
      }}
    >
      <div className="note-list-search">
        <div className="note-list-search-inner">
          <Search size={14} className="note-list-search-icon" aria-hidden="true" />
          <input
            id="note-search"
            type="search"
            placeholder="搜索全部笔记"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            aria-label="搜索笔记"
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
            <SortableContext items={renderedItems.map((it) => it.id)} strategy={verticalListSortingStrategy}>
            {renderedItems.map((it) => {
              if (it.kind === 'file') {
                const file = files.find((f) => f.id === it.id)!
                return renamingFileId === file.id ? (
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
                  <SortableCard key={file.id} id={file.id} kind="file" dragActive={dragActive} dragJustEndedRef={dragJustEndedRef}>
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
                        <span className="file-card-badge">{isHtmlFile(file) ? 'HTML' : 'PDF'}</span>
                      </div>
                      <div className="note-card-time">
                        {[formatSize(file.size), formatTime(file.updatedAt)].filter(Boolean).join(' · ')}
                      </div>
                      {(file.tags ?? []).length > 0 && (
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
                      {search.trim() && file.folderId && (
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
                    </button>
                    {moreButton('file', file.id, file.filename)}
                  </SortableCard>
                )
              }
              const note = notes.find((n) => n.id === it.id)!
              return (
                <SortableCard key={note.id} id={note.id} kind="note" dragActive={dragActive} dragJustEndedRef={dragJustEndedRef}>
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
                    <div className="note-card-title">{note.title || firstLine(note.content) || '无标题'}</div>
                    {excerptFor(note)}
                    {search.trim() && note.folderId && (
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
                    {(note.tags ?? []).length > 0 && (
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
                    <div className="note-card-time">{formatTime(note.updatedAt)}</div>
                  </button>
                  {moreButton('note', note.id, note.title || '无标题')}
                </SortableCard>
              )
            })}
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
    </section>
  )
}
