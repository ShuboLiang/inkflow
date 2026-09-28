import { useState, useEffect } from 'react'
import { Info, Copy, Check, X, History } from 'lucide-react'
import type { Note } from '../lib/db'
import { countWords, firstLine } from '../lib/wordCount'
import { plainTextOf } from '../lib/search'
import { listNoteVersions, fetchRemoteVersions } from '../store/versions'
import './NoteInfoModal.css'

interface NoteInfoModalProps {
  isOpen: boolean
  note: Note | null
  folderPath?: string | null
  onClose: () => void
  onOpenVersionHistory?: (note: Note) => void
}

function formatDateTime(ts?: number | null): string {
  if (!ts) return '-'
  return new Date(ts).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

export function NoteInfoModal({ isOpen, note, folderPath, onClose, onOpenVersionHistory }: NoteInfoModalProps) {
  const [copied, setCopied] = useState(false)
  const [snapshotCount, setSnapshotCount] = useState<number | null>(null)

  // ESC 键关闭
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  // 查询历史快照数量
  useEffect(() => {
    if (!isOpen || !note?.id) return
    let active = true

    // 1. 本地快速获取
    void listNoteVersions(note.id).then((list) => {
      if (active) setSnapshotCount(list.length)
    })

    // 2. 远端尝试同步刷新（若有网络/已登录）
    void fetchRemoteVersions(note.id)
      .then((list) => {
        if (active) setSnapshotCount(list.length)
      })
      .catch(() => {})

    return () => {
      active = false
    }
  }, [isOpen, note?.id])

  if (!isOpen || !note) return null

  const title = note.title || firstLine(note.content) || '无标题'
  const words = countWords(note.content)
  const plainText = plainTextOf(note.content)
  const chars = plainText.length
  const charsNoSpace = plainText.replace(/\s+/g, '').length

  const handleCopyId = async () => {
    try {
      await navigator.clipboard.writeText(note.id)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 降级兜底
      const input = document.createElement('input')
      input.value = note.id
      document.body.appendChild(input)
      input.select()
      document.execCommand('copy')
      document.body.removeChild(input)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const syncStatusText = () => {
    if (note.dirty === 1) return '未同步（待同步）'
    if (note.syncedAt) return `已同步 (${formatDateTime(note.syncedAt)})`
    return '未同步'
  }

  return (
    <div
      className="note-info-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="note-info-title"
    >
      <div className="note-info-card" onClick={(e) => e.stopPropagation()}>
        <div className="note-info-header">
          <h3 id="note-info-title" className="note-info-title">
            <Info size={18} color="var(--qing)" />
            <span>笔记信息</span>
          </h3>
          <button
            type="button"
            className="note-info-close"
            onClick={onClose}
            title="关闭"
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </div>

        <div className="note-info-body">
          {/* 标题 */}
          <div className="note-info-row">
            <span className="note-info-label">标题</span>
            <div className="note-info-value" style={{ fontWeight: 600 }}>
              {title}
            </div>
          </div>

          {/* 笔记 ID */}
          <div className="note-info-row">
            <span className="note-info-label">笔记 ID</span>
            <div className="note-info-id-box">
              <span className="note-info-id-text" title={note.id}>
                {note.id}
              </span>
              <button
                type="button"
                className={`note-info-copy-btn ${copied ? 'copied' : ''}`}
                onClick={() => void handleCopyId()}
                title="复制 ID"
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                <span>{copied ? '已复制' : '复制'}</span>
              </button>
            </div>
          </div>

          {/* 统计网格 */}
          <div className="note-info-stats-grid">
            <div className="note-info-stat-item">
              <span className="note-info-stat-label">总字数</span>
              <span className="note-info-stat-val">{words.toLocaleString()}</span>
            </div>
            <div className="note-info-stat-item">
              <span className="note-info-stat-label">字符数 (含空格)</span>
              <span className="note-info-stat-val">{chars.toLocaleString()}</span>
            </div>
            <div className="note-info-stat-item">
              <span className="note-info-stat-label">字符数 (不含空格)</span>
              <span className="note-info-stat-val">{charsNoSpace.toLocaleString()}</span>
            </div>
            <div className="note-info-stat-item" title="底层同步修订轮次（每次打字落盘保存自动递增）">
              <span className="note-info-stat-label">保存轮次</span>
              <span className="note-info-stat-val">第 {note.version} 次落盘</span>
            </div>
          </div>

          {/* 历史快照 */}
          <div className="note-info-row">
            <span className="note-info-label">历史快照</span>
            <div className="note-info-value">
              {onOpenVersionHistory ? (
                <button
                  type="button"
                  className="note-info-snapshot-btn"
                  onClick={() => {
                    onClose()
                    onOpenVersionHistory(note)
                  }}
                  title="点击打开版本历史面板"
                >
                  <span className="note-info-snapshot-badge">
                    <History size={14} color="var(--qing)" />
                    <span>
                      {snapshotCount === null ? '查询中...' : `共 ${snapshotCount} 个快照`}
                    </span>
                  </span>
                  <span className="note-info-snapshot-action">打开版本面板 →</span>
                </button>
              ) : (
                <div className="note-info-snapshot-static">
                  <History size={14} color="var(--qing)" />
                  <span>
                    {snapshotCount === null ? '查询中...' : `共 ${snapshotCount} 个快照`}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* 文件夹 */}
          <div className="note-info-row">
            <span className="note-info-label">所在文件夹</span>
            <span className="note-info-value">{folderPath || '未分类（根目录）'}</span>
          </div>

          {/* 标签 */}
          <div className="note-info-row">
            <span className="note-info-label">标签</span>
            <div className="note-info-tags">
              {note.tags && note.tags.length > 0 ? (
                note.tags.map((t) => (
                  <span key={t} className="note-info-tag">
                    #{t}
                  </span>
                ))
              ) : (
                <span className="note-info-empty-tag">无标签</span>
              )}
            </div>
          </div>

          {/* 创建时间 */}
          <div className="note-info-row">
            <span className="note-info-label">创建时间</span>
            <span className="note-info-value">
              {formatDateTime(note.createdAt || note.updatedAt)}
            </span>
          </div>

          {/* 最后修改时间 */}
          <div className="note-info-row">
            <span className="note-info-label">最后修改时间</span>
            <span className="note-info-value">{formatDateTime(note.updatedAt)}</span>
          </div>

          {/* 同步状态 */}
          <div className="note-info-row">
            <span className="note-info-label">同步状态</span>
            <span className="note-info-value">{syncStatusText()}</span>
          </div>
        </div>

        <div className="note-info-footer">
          {onOpenVersionHistory && (
            <button
              type="button"
              className="note-info-history-btn"
              onClick={() => {
                onClose()
                onOpenVersionHistory(note)
              }}
              title="查看历史版本"
            >
              <History size={14} />
              <span>版本历史</span>
            </button>
          )}
          <button type="button" className="note-info-ok-btn" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  )
}
