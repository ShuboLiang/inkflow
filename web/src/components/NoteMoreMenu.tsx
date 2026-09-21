import { useEffect, useRef, useState } from 'react'
import './NoteMoreMenu.css'

interface NoteMoreMenuProps {
  onExportMarkdown: () => void
  onExportPdf: () => void
  onExportImage: () => void
  isFullScreen: boolean
  onToggleFullscreen: () => void
  onDeleteNote: () => void
  isExportingImage?: boolean
}

export function NoteMoreMenu({
  onExportMarkdown,
  onExportPdf,
  onExportImage,
  isFullScreen,
  onToggleFullscreen,
  onDeleteNote,
  isExportingImage = false,
}: NoteMoreMenuProps) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', handleClick)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('mousedown', handleClick)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div className="note-more-container" ref={menuRef}>
      <button
        type="button"
        className={`tool-btn note-more-btn ${open ? 'active-tool' : ''}`}
        title="更多操作"
        aria-label="更多操作"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="19" cy="12" r="2" />
        </svg>
      </button>

      {open && (
        <div className="note-more-dropdown" role="menu">
          <div className="note-more-section-title">导出笔记</div>
          <button
            type="button"
            className="note-more-item"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onExportMarkdown()
            }}
          >
            <span className="note-more-icon">📄</span>
            <div className="note-more-text">
              <span className="note-more-label">导出为 Markdown</span>
              <span className="note-more-hint">.md 格式</span>
            </div>
          </button>

          <button
            type="button"
            className="note-more-item"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onExportPdf()
            }}
          >
            <span className="note-more-icon">📑</span>
            <div className="note-more-text">
              <span className="note-more-label">导出为 PDF</span>
              <span className="note-more-hint">矢量打印排版</span>
            </div>
          </button>

          <button
            type="button"
            className="note-more-item"
            role="menuitem"
            disabled={isExportingImage}
            onClick={() => {
              setOpen(false)
              onExportImage()
            }}
          >
            <span className="note-more-icon">🖼️</span>
            <div className="note-more-text">
              <span className="note-more-label">{isExportingImage ? '正在生成图片…' : '导出为高清长图'}</span>
              <span className="note-more-hint">2x 视网膜高清 PNG</span>
            </div>
          </button>

          <div className="note-more-divider" />

          <button
            type="button"
            className="note-more-item"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onToggleFullscreen()
            }}
          >
            <span className="note-more-icon">⛶</span>
            <div className="note-more-text">
              <span className="note-more-label">{isFullScreen ? '退出全屏' : '全屏 / 专注模式'}</span>
              <span className="note-more-hint">Ctrl+\</span>
            </div>
          </button>

          <div className="note-more-divider" />

          <button
            type="button"
            className="note-more-item danger"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onDeleteNote()
            }}
          >
            <span className="note-more-icon">🗑️</span>
            <div className="note-more-text">
              <span className="note-more-label">删除笔记</span>
            </div>
          </button>
        </div>
      )}
    </div>
  )
}
