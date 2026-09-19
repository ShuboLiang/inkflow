import { useRef, useState } from 'react'
import type { FileEntry, Note } from '../lib/db'
import { firstLine } from '../lib/wordCount'
import { softDeleteNote } from '../store/notes'
import { deleteFile, ensureFileData } from '../store/files'
import { createFileShare, createNoteShare, shareUrl } from '../store/shares'
import { ContextMenu, type MenuItem } from './ContextMenu'
import './NoteList.css'

interface NoteListProps {
  notes: Note[]
  files: FileEntry[]
  activeId: string | null
  search: string
  userId: string
  onSearch: (value: string) => void
  onSelect: (id: string) => void
  onCreate: () => void
  onSelectFile: (id: string) => void
  onUpload: (file: File) => void
  onRenameNote: (id: string) => void
  onRequestPush: () => void
  emptyHint?: string
}

// 只有精确指针（鼠标）设备启用卡片拖拽：触屏上 draggable 会干扰列表滚动
const DRAG_ENABLED = typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches

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

export function NoteList({
  notes,
  files,
  activeId,
  search,
  userId,
  onSearch,
  onSelect,
  onCreate,
  onSelectFile,
  onUpload,
  onRenameNote,
  onRequestPush,
  emptyHint,
}: NoteListProps) {
  const uploadRef = useRef<HTMLInputElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'note' | 'file'; id: string } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = (msg: string) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2200)
  }

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
    if (!window.confirm(`删除笔记「${note?.title || '无标题'}」？`)) return
    await softDeleteNote(id)
    onRequestPush()
  }

  const deleteFileById = async (id: string) => {
    const file = files.find((f) => f.id === id)
    if (!window.confirm(`删除文件「${file?.filename ?? ''}」？`)) return
    await deleteFile(id)
    onRequestPush()
  }

  const menuItems = (m: { kind: 'note' | 'file'; id: string }): MenuItem[] =>
    m.kind === 'note'
      ? [
          { key: 'open', label: '打开', onClick: () => onSelect(m.id) },
          { key: 'share', label: '复制分享链接', onClick: () => void copyShareLink('note', m.id) },
          { key: 'rename', label: '重命名', onClick: () => onRenameNote(m.id) },
          { key: 'd1', label: '', divider: true, onClick: () => {} },
          { key: 'del', label: '删除', danger: true, onClick: () => void deleteNoteById(m.id) },
        ]
      : [
          { key: 'open', label: '打开', onClick: () => onSelectFile(m.id) },
          { key: 'dl', label: '下载', onClick: () => void downloadFile(m.id) },
          { key: 'share', label: '复制分享链接', onClick: () => void copyShareLink('file', m.id) },
          { key: 'd1', label: '', divider: true, onClick: () => {} },
          { key: 'del', label: '删除', danger: true, onClick: () => void deleteFileById(m.id) },
        ]

  const openMenu = (e: React.MouseEvent, kind: 'note' | 'file', id: string) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, kind, id })
  }

  return (
    <section className="note-list" aria-label="文件夹内容">
      <div className="note-list-search">
        <input
          type="search"
          placeholder="搜索笔记"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          aria-label="搜索笔记"
        />
      </div>
      <div className="note-list-items">
        {notes.length === 0 && files.length === 0 ? (
          <div className="note-list-empty">{emptyHint ?? '暂无内容'}</div>
        ) : (
          <>
            {files.map((file) => (
              <button
                key={file.id}
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
                  <span className="file-card-badge">PDF</span>
                </div>
                <div className="note-card-time">
                  {[formatSize(file.size), formatTime(file.updatedAt)].filter(Boolean).join(' · ')}
                </div>
              </button>
            ))}
            {notes.map((note) => (
              <button
                key={note.id}
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
                <div className="note-card-excerpt">{excerptOf(note.content)}</div>
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
            ))}
          </>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={() => setMenu(null)} />}
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
