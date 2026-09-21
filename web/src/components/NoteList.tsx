import { useEffect, useRef, useState } from 'react'
import type { FileEntry, Folder, Note } from '../lib/db'
import { firstLine } from '../lib/wordCount'
import { softDeleteNote } from '../store/notes'
import { deleteFile, ensureFileData } from '../store/files'
import { createFileShare, createNoteShare, shareUrl } from '../store/shares'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { confirmDialog } from '../lib/dialog'
import { matchSnippet } from '../lib/search'
import { kindOfName } from '../lib/importFile'
import './NoteList.css'

interface NoteListProps {
  notes: Note[]
  files: FileEntry[]
  folders: Folder[]
  folderHits: { id: string; name: string; path: string }[]
  activeId: string | null
  search: string
  userId: string
  onSearch: (value: string) => void
  onSelectFolderHit: (id: string) => void
  /** 文件夹 id → 路径名（如 课程 / 数学），找不到返回 null */
  folderPathOf: (folderId: string) => string | null
  onGotoFolder: (folderId: string) => void
  onSelect: (id: string) => void
  onCreate: () => void
  onSelectFile: (id: string) => void
  onUpload: (file: File) => void
  onRenameNote: (id: string) => void
  onRenameFile: (id: string, filename: string) => void
  onMoveNote: (id: string, folderId: string | null) => void
  onMoveFile: (id: string, folderId: string | null) => void
  onRequestPush: () => void
  emptyHint?: string
}

// 只有精确指针（鼠标）设备启用卡片拖拽：触屏上 draggable 会干扰列表滚动
const DRAG_ENABLED = typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches

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

function IconFile() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  )
}

function IconFolder() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  )
}

function IconFolderSmall() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  )
}

export function NoteList({
  notes,
  files,
  folders,
  folderHits,
  activeId,
  search,
  userId,
  onSearch,
  onSelectFolderHit,
  folderPathOf,
  onGotoFolder,
  onSelect,
  onCreate,
  onSelectFile,
  onUpload,
  onRenameNote,
  onRenameFile,
  onMoveNote,
  onMoveFile,
  onRequestPush,
  emptyHint,
}: NoteListProps) {
  const uploadRef = useRef<HTMLInputElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'note' | 'file'; id: string } | null>(null)
  // 「移动到文件夹…」的级联菜单（与 card 菜单同一定位策略）
  const [moveMenu, setMoveMenu] = useState<{ x: number; y: number; kind: 'note' | 'file'; id: string } | null>(null)
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
    const dataUrl = file.dataUrl ?? (await ensureFileData(id))
    if (!dataUrl) {
      showToast('文件内容不可用（可能尚未同步）')
      return
    }
    const a = document.createElement('a')
    a.href = dataUrl
    a.download = file.filename
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
    const gotoFolderItem: MenuItem | null =
      target?.folderId
        ? {
            key: 'goto',
            label: '跳到所在文件夹',
            onClick: () => onGotoFolder(target.folderId as string),
          }
        : null
    // 在原菜单位置换成文件夹列表（ContextMenu 自带视口避让）
    const moveItem: MenuItem = {
      key: 'move',
      label: '移动到文件夹…',
      onClick: () => setMoveMenu({ x: m.x, y: m.y, kind: m.kind, id: m.id }),
    }
    return m.kind === 'note'
      ? [
          { key: 'open', label: '打开', onClick: () => onSelect(m.id) },
          ...(gotoFolderItem ? [gotoFolderItem] : []),
          moveItem,
          { key: 'share', label: '复制分享链接', onClick: () => void copyShareLink('note', m.id) },
          { key: 'rename', label: '重命名', onClick: () => onRenameNote(m.id) },
          { key: 'd1', label: '', divider: true, onClick: () => {} },
          { key: 'del', label: '删除', danger: true, onClick: () => void deleteNoteById(m.id) },
        ]
      : [
          { key: 'open', label: '打开', onClick: () => onSelectFile(m.id) },
          ...(gotoFolderItem ? [gotoFolderItem] : []),
          moveItem,
          { key: 'rename', label: '重命名', onClick: () => setRenamingFileId(m.id) },
          { key: 'dl', label: '下载', onClick: () => void downloadFile(m.id) },
          { key: 'share', label: '复制分享链接', onClick: () => void copyShareLink('file', m.id) },
          { key: 'd1', label: '', divider: true, onClick: () => {} },
          { key: 'del', label: '删除', danger: true, onClick: () => void deleteFileById(m.id) },
        ]
  }

  // 文件夹列表（按路径拼音排序），当前所在位置打 ✓
  const moveToItems = (m: { kind: 'note' | 'file'; id: string }): MenuItem[] => {
    const target =
      m.kind === 'note' ? notes.find((n) => n.id === m.id) : files.find((f) => f.id === m.id)
    const cur = target?.folderId ?? null
    const move = (folderId: string | null) => () =>
      m.kind === 'note' ? onMoveNote(m.id, folderId) : onMoveFile(m.id, folderId)
    const entries = folders
      .map((f) => ({ id: f.id, label: folderPathOf(f.id) ?? f.name }))
      .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'))
    return [
      { key: 'none', label: cur === null ? '✓ 无文件夹' : '无文件夹', onClick: move(null) },
      ...entries.map((f) => ({
        key: f.id,
        label: cur === f.id ? `✓ ${f.label}` : f.label,
        onClick: move(f.id),
      })),
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

  // 触屏设备没有右键：卡片右上角的「⋯」按钮打开同一个菜单，锚在按钮下方
  const moreButton = (kind: 'note' | 'file', id: string, label: string) => (
    <button
      type="button"
      className="card-more"
      aria-label={`${label} 更多操作`}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        setMenu({ x: r.left, y: r.bottom + 4, kind, id })
      }}
    >
      ⋯
    </button>
  )

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
        <input
          id="note-search"
          type="search"
          placeholder="搜索全部笔记"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          aria-label="搜索笔记"
        />
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
                      <IconFolder />
                      <span className="folder-hit-name">{hit.name}</span>
                    </div>
                    <div className="note-card-time folder-hit-path">{hit.path}</div>
                  </button>
                ))}
              </>
            )}
            {files.slice(0, renderLimit).map((file) =>
              renamingFileId === file.id ? (
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
                <div key={file.id} className="card-wrap">
                  <button
                    type="button"
                    className="note-card file-card"
                    draggable={DRAG_ENABLED}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', `file:${file.id}`)
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onClick={() => onSelectFile(file.id)}
                    onContextMenu={(e) => openMenu(e, 'file', file.id)}
                  >
                    <div className="note-card-title file-card-title">
                      <IconFile />
                      <span className="file-card-name" title={file.filename}>
                        {file.filename}
                      </span>
                      <span className="file-card-badge">{kindOfName(file.filename) === 'html' ? 'HTML' : 'PDF'}</span>
                    </div>
                    <div className="note-card-time">
                      {[formatSize(file.size), formatTime(file.updatedAt)].filter(Boolean).join(' · ')}
                    </div>
                    {(file.tags ?? []).length > 0 && (
                      <div className="note-card-tags">
                        {(file.tags ?? []).slice(0, 3).map((t) => (
                          <span key={t} className="note-card-tag">
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
                        <IconFolderSmall />
                        {folderPathOf(file.folderId)}
                      </span>
                    )}
                  </button>
                  {moreButton('file', file.id, file.filename)}
                </div>
              ),
            )}
            {notes.slice(0, renderLimit).map((note) => (
              <div key={note.id} className="card-wrap">
                <button
                  type="button"
                  className={note.id === activeId ? 'note-card active' : 'note-card'}
                  draggable={DRAG_ENABLED}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/plain', `note:${note.id}`)
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onClick={() => onSelect(note.id)}
                  onContextMenu={(e) => openMenu(e, 'note', note.id)}
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
                      <IconFolderSmall />
                      {folderPathOf(note.folderId)}
                    </span>
                  )}
                  {(note.tags ?? []).length > 0 && (
                    <div className="note-card-tags">
                      {(note.tags ?? []).slice(0, 3).map((t) => (
                        <span key={t} className="note-card-tag">
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
              </div>
            ))}
            {files.length + notes.length > renderLimit && (
              <div ref={sentinelRef} className="note-list-more">
                加载更多（已显示 {Math.min(renderLimit, files.length + notes.length)} / {files.length + notes.length}）
              </div>
            )}
          </>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={() => setMenu(null)} />}
      {moveMenu && (
        <ContextMenu
          x={moveMenu.x}
          y={moveMenu.y}
          items={moveToItems(moveMenu)}
          onClose={() => setMoveMenu(null)}
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
