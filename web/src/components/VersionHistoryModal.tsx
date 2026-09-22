import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  History,
  X,
  RotateCcw,
  FilePlus,
  Bookmark,
  Trash2,
  Edit2,
  Eye,
  GitCompare,
  ArrowLeft,
  Clock,
  Sparkles,
  Loader2,
} from 'lucide-react'
import { useEditor, EditorContent } from '@tiptap/react'
import type { Note, NoteVersion } from '../lib/db'
import { buildExtensions } from '../lib/editorExtensions'
import { plainTextOf } from '../lib/search'
import { computeLineDiff } from '../lib/diff'
import { confirmDialog, promptDialog } from '../lib/dialog'
import {
  listNoteVersions,
  fetchRemoteVersions,
  createVersionSnapshot,
  renameVersion,
  deleteVersion,
  copyVersionAsNewNote,
} from '../store/versions'
import './VersionHistoryModal.css'

interface VersionHistoryModalProps {
  isOpen: boolean
  note: Note | null
  onClose: () => void
  onRestore: (versionId: string) => Promise<void>
  onSaveAsCopy?: (newNote: Note) => void
}

function formatRelativeTime(ts: number): string {
  const now = Date.now()
  const diff = Math.max(0, now - ts)
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / (60 * 1000))} 分钟前`
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / (3600 * 1000))} 小时前`
  if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / (86400 * 1000))} 天前`
  return new Date(ts).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
}

function formatFullTime(ts: number): string {
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

function VersionPreviewEditor({ content }: { content: unknown }) {
  const editor = useEditor({
    extensions: buildExtensions(),
    editable: false,
    content: (content as object) ?? { type: 'doc', content: [] },
  })

  useEffect(() => {
    if (editor && content) {
      editor.commands.setContent((content as object) ?? { type: 'doc', content: [] })
    }
  }, [editor, content])

  return (
    <div className="vhm-preview-shell">
      <EditorContent editor={editor} className="vhm-preview-editor" />
    </div>
  )
}

export function VersionHistoryModal({
  isOpen,
  note,
  onClose,
  onRestore,
  onSaveAsCopy,
}: VersionHistoryModalProps) {
  const [versions, setVersions] = useState<NoteVersion[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [viewMode, setViewMode] = useState<'preview' | 'diff'>('preview')
  const [diffBase, setDiffBase] = useState<'current' | 'previous'>('current')
  // 移动端分屏切换（true = 详情视图，false = 列表视图）
  const [mobileShowDetail, setMobileShowDetail] = useState(false)

  const reloadVersions = useCallback(async (noteId: string) => {
    const locals = await listNoteVersions(noteId)
    setVersions(locals)
    if (locals.length > 0) {
      setSelectedId((prev) => (prev && locals.some((v) => v.id === prev) ? prev : locals[0].id))
    }
  }, [])

  useEffect(() => {
    if (!isOpen || !note) return

    let cancelled = false

    void (async () => {
      setLoading(true)
      // 1. 先快速读取本地
      const locals = await listNoteVersions(note.id)
      if (cancelled) return
      setVersions(locals)
      if (locals.length > 0) {
        setSelectedId(locals[0].id)
      }

      // 2. 异步联网增量补齐远程
      try {
        const remote = await fetchRemoteVersions(note.id)
        if (!cancelled) {
          setVersions(remote)
          if (remote.length > 0) {
            setSelectedId((prev) => prev ?? remote[0].id)
          }
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [isOpen, note])

  // ESC 键关闭
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  const selectedIndex = useMemo(() => {
    return versions.findIndex((v) => v.id === selectedId)
  }, [versions, selectedId])

  const selectedVersion = useMemo(() => {
    return selectedIndex >= 0 ? versions[selectedIndex] : null
  }, [versions, selectedIndex])

  // 计算比对目标的内容文本
  const diffComparison = useMemo(() => {
    if (!selectedVersion || !note) return null

    let targetTitle = ''
    let targetText = ''
    let targetLabel = ''

    if (diffBase === 'current') {
      targetTitle = note.title ?? ''
      targetText = plainTextOf(note.content)
      targetLabel = '当前工作区最新内容'
    } else {
      // 上一个更早版本
      const olderVersion = versions[selectedIndex + 1]
      if (olderVersion) {
        targetTitle = olderVersion.title ?? ''
        targetText = plainTextOf(olderVersion.content)
        targetLabel = olderVersion.name || formatRelativeTime(olderVersion.createdAt)
      } else {
        targetTitle = ''
        targetText = ''
        targetLabel = '初始空版本'
      }
    }

    const versionTitle = selectedVersion.title ?? ''
    const versionText = plainTextOf(selectedVersion.content)

    // diff 计算：以 target 为基准比对当前选中 version
    // 或者以 version 为基准比对 target
    // 心理模型：如果比较当前，看历史版本与当前的区别
    const titleDiff = computeLineDiff(versionTitle, targetTitle)
    const contentDiff = computeLineDiff(versionText, targetText)

    return {
      targetLabel,
      titleDiff,
      contentDiff,
    }
  }, [selectedVersion, note, diffBase, versions, selectedIndex])

  // 创建命名里程碑
  const handleCreateMilestone = async () => {
    if (!note) return
    const name = await promptDialog({
      title: '标记/命名当前版本',
      message: '为当前笔记的内容状态创建一个独立命名里程碑（如：初稿完成、大纲定稿）：',
      input: { placeholder: '版本名称（如：初稿定稿）' },
    })
    if (!name) return

    const newVer = await createVersionSnapshot(note, 'manual', name)
    await reloadVersions(note.id)
    setSelectedId(newVer.id)
  }

  // 重命名版本
  const handleRename = async (v: NoteVersion, e: React.MouseEvent) => {
    e.stopPropagation()
    const newName = await promptDialog({
      title: '重命名版本',
      message: '请输入新的版本名称：',
      input: { defaultValue: v.name ?? '', placeholder: '版本名称' },
    })
    if (newName === null) return

    await renameVersion(v.id, newName)
    if (note) await reloadVersions(note.id)
  }

  // 删除版本
  const handleDelete = async (v: NoteVersion, e: React.MouseEvent) => {
    e.stopPropagation()
    const ok = await confirmDialog({
      title: '删除版本快照',
      message: `确定要删除此版本记录（${v.name || formatFullTime(v.createdAt)}）吗？此操作无法撤销。`,
      confirmText: '确认删除',
      danger: true,
    })
    if (!ok) return

    await deleteVersion(v.id)
    if (note) await reloadVersions(note.id)
  }

  // 恢复版本
  const handleRestore = async () => {
    if (!selectedVersion || !note) return
    const timeStr = formatFullTime(selectedVersion.createdAt)
    const nameStr = selectedVersion.name ? `「${selectedVersion.name}」` : ''
    const ok = await confirmDialog({
      title: '恢复历史版本',
      message: `确定要将笔记恢复至 ${timeStr} ${nameStr} 的状态吗？系统会在恢复前为当前内容自动生成安全备份。`,
      confirmText: '恢复此版本',
    })
    if (!ok) return

    await onRestore(selectedVersion.id)
    onClose()
  }

  // 另存为新笔记
  const handleSaveAsCopy = async () => {
    if (!selectedVersion || !note) return
    const copy = await copyVersionAsNewNote(selectedVersion.id, note.folderId)
    if (copy && onSaveAsCopy) {
      onSaveAsCopy(copy)
    }
    onClose()
  }

  if (!isOpen || !note) return null

  return (
    <div
      className="vhm-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="vhm-dialog-title"
    >
      <div className="vhm-modal" onClick={(e) => e.stopPropagation()}>
        {/* 顶部标题栏 */}
        <header className="vhm-header">
          <div className="vhm-header-left">
            <History size={18} className="vhm-header-icon" />
            <div className="vhm-header-titles">
              <h3 id="vhm-dialog-title" className="vhm-title">
                版本历史
              </h3>
              <span className="vhm-subtitle" title={note.title || '无标题'}>
                {note.title || '无标题'}
              </span>
            </div>
            {loading && <Loader2 size={14} className="vhm-spin" />}
          </div>

          <div className="vhm-header-actions">
            <button
              type="button"
              className="vhm-btn vhm-btn-milestone"
              onClick={() => void handleCreateMilestone()}
              title="为当前工作区内容创建一个命名快照"
            >
              <Bookmark size={14} />
              <span>标记当前版本</span>
            </button>
            <button
              type="button"
              className="vhm-close-btn"
              onClick={onClose}
              title="关闭 (Esc)"
              aria-label="关闭"
            >
              <X size={18} />
            </button>
          </div>
        </header>

        {/* 主体两栏布局 */}
        <div className={`vhm-body ${mobileShowDetail ? 'mobile-show-detail' : ''}`}>
          {/* 左侧：版本时间轴列表 */}
          <aside className="vhm-sidebar">
            <div className="vhm-sidebar-head">
              <span className="vhm-sidebar-count">
                共 {versions.length} 个版本
              </span>
              <button
                type="button"
                className="vhm-mini-btn"
                onClick={() => void reloadVersions(note.id)}
                title="刷新版本"
              >
                刷新
              </button>
            </div>

            <div className="vhm-timeline-list">
              {versions.length === 0 ? (
                <div className="vhm-empty-list">
                  <Clock size={28} className="vhm-empty-icon" />
                  <p>暂无历史版本快照</p>
                  <span>修改笔记或点击上方“标记当前版本”即可创建</span>
                </div>
              ) : (
                versions.map((v, index) => {
                  const isSelected = v.id === selectedId
                  const older = versions[index + 1]
                  const charDiff = older ? v.charCount - older.charCount : 0
                  const isManual = v.source === 'manual' || !!v.name

                  return (
                    <div
                      key={v.id}
                      className={`vhm-timeline-item ${isSelected ? 'active' : ''} ${
                        isManual ? 'is-milestone' : ''
                      }`}
                      onClick={() => {
                        setSelectedId(v.id)
                        setMobileShowDetail(true)
                      }}
                    >
                      <div className="vhm-item-dot" />
                      <div className="vhm-item-content">
                        <div className="vhm-item-header">
                          <span className="vhm-item-name" title={v.name || '自动快照'}>
                            {v.name || '自动快照'}
                          </span>
                          {isManual ? (
                            <span className="vhm-badge milestone">里程碑</span>
                          ) : (
                            <span className="vhm-badge auto">自动</span>
                          )}
                        </div>

                        <div className="vhm-item-meta">
                          <span className="vhm-item-time" title={formatFullTime(v.createdAt)}>
                            {formatRelativeTime(v.createdAt)}
                          </span>
                          <span className="vhm-item-chars">
                            {v.charCount.toLocaleString()} 字
                            {charDiff !== 0 && (
                              <span
                                className={`vhm-char-diff ${
                                  charDiff > 0 ? 'positive' : 'negative'
                                }`}
                              >
                                {charDiff > 0 ? `+${charDiff}` : charDiff}
                              </span>
                            )}
                          </span>
                        </div>
                      </div>

                      {/* 悬停快捷操作 */}
                      <div className="vhm-item-actions">
                        <button
                          type="button"
                          className="vhm-action-icon"
                          onClick={(e) => void handleRename(v, e)}
                          title="重命名此版本"
                        >
                          <Edit2 size={12} />
                        </button>
                        <button
                          type="button"
                          className="vhm-action-icon danger"
                          onClick={(e) => void handleDelete(v, e)}
                          title="删除此版本"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </aside>

          {/* 右侧：预览与差异对比区域 */}
          <main className="vhm-main">
            {selectedVersion ? (
              <>
                <div className="vhm-detail-toolbar">
                  {/* 移动端返回按钮 */}
                  <button
                    type="button"
                    className="vhm-mobile-back-btn"
                    onClick={() => setMobileShowDetail(false)}
                  >
                    <ArrowLeft size={16} />
                    <span>版本列表</span>
                  </button>

                  {/* 模式切换 Tabs */}
                  <div className="vhm-tabs">
                    <button
                      type="button"
                      className={`vhm-tab ${viewMode === 'preview' ? 'active' : ''}`}
                      onClick={() => setViewMode('preview')}
                    >
                      <Eye size={14} />
                      <span>只读预览</span>
                    </button>
                    <button
                      type="button"
                      className={`vhm-tab ${viewMode === 'diff' ? 'active' : ''}`}
                      onClick={() => setViewMode('diff')}
                    >
                      <GitCompare size={14} />
                      <span>变更对比</span>
                    </button>
                  </div>

                  {/* 差异基准切换 */}
                  {viewMode === 'diff' && (
                    <div className="vhm-diff-selector">
                      <span className="vhm-diff-selector-label">对比对象:</span>
                      <select
                        className="vhm-select"
                        value={diffBase}
                        onChange={(e) => setDiffBase(e.target.value as 'current' | 'previous')}
                      >
                        <option value="current">当前工作区最新内容</option>
                        <option value="previous">上一历史版本</option>
                      </select>
                    </div>
                  )}

                  <div className="vhm-detail-actions">
                    <button
                      type="button"
                      className="vhm-btn vhm-btn-secondary"
                      onClick={() => void handleSaveAsCopy()}
                      title="将此版本复制为一篇新笔记"
                    >
                      <FilePlus size={14} />
                      <span>另存为新笔记</span>
                    </button>
                    <button
                      type="button"
                      className="vhm-btn vhm-btn-primary"
                      onClick={() => void handleRestore()}
                      title="将当前笔记恢复至此版本"
                    >
                      <RotateCcw size={14} />
                      <span>恢复此版本</span>
                    </button>
                  </div>
                </div>

                <div className="vhm-detail-content">
                  {viewMode === 'preview' ? (
                    <div className="vhm-preview-pane">
                      <div className="vhm-preview-meta-bar">
                        <span className="vhm-preview-version-tag">
                          版本快照 · {formatFullTime(selectedVersion.createdAt)}
                        </span>
                        {selectedVersion.name && (
                          <span className="vhm-preview-name-tag">
                            📌 {selectedVersion.name}
                          </span>
                        )}
                        <span className="vhm-preview-char-tag">
                          {selectedVersion.charCount.toLocaleString()} 字符
                        </span>
                      </div>
                      <h1 className="vhm-preview-doc-title">
                        {selectedVersion.title || '无标题'}
                      </h1>
                      <VersionPreviewEditor
                        key={selectedVersion.id}
                        content={selectedVersion.content}
                      />
                    </div>
                  ) : (
                    <div className="vhm-diff-pane">
                      {diffComparison && (
                        <>
                          <div className="vhm-diff-summary-bar">
                            <span className="vhm-diff-target-info">
                              正在对比: <strong>{diffComparison.targetLabel}</strong>
                            </span>
                            <div className="vhm-diff-stat-badges">
                              <span className="vhm-diff-badge added">
                                +{diffComparison.contentDiff.addedCount} 行新增
                              </span>
                              <span className="vhm-diff-badge removed">
                                -{diffComparison.contentDiff.removedCount} 行删除
                              </span>
                            </div>
                          </div>

                          {/* 标题对比 */}
                          {diffComparison.titleDiff.lines.some((l) => l.type !== 'unchanged') && (
                            <div className="vhm-diff-title-box">
                              <span className="vhm-diff-section-tag">标题变更</span>
                              <div className="vhm-diff-title-content">
                                {diffComparison.titleDiff.lines.map((l, idx) => (
                                  <div key={idx} className={`vhm-diff-title-line ${l.type}`}>
                                    {l.type === 'added' ? '+' : l.type === 'removed' ? '-' : ' '}
                                    {l.text || '(空标题)'}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* 正文行比对 */}
                          <div className="vhm-diff-lines-container">
                            {diffComparison.contentDiff.lines.length === 0 ? (
                              <div className="vhm-diff-empty">
                                <Sparkles size={24} className="vhm-empty-icon" />
                                <p>该版本与对比目标内容完全一致，没有差异</p>
                              </div>
                            ) : (
                              <table className="vhm-diff-table">
                                <tbody>
                                  {diffComparison.contentDiff.lines.map((line, idx) => (
                                    <tr key={idx} className={`vhm-diff-row ${line.type}`}>
                                      <td className="vhm-diff-num old-num">
                                        {line.oldLineNumber ?? ''}
                                      </td>
                                      <td className="vhm-diff-num new-num">
                                        {line.newLineNumber ?? ''}
                                      </td>
                                      <td className="vhm-diff-marker">
                                        {line.type === 'added'
                                          ? '+'
                                          : line.type === 'removed'
                                            ? '-'
                                            : ' '}
                                      </td>
                                      <td className="vhm-diff-text">
                                        {line.text || ' '}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="vhm-no-selection">
                <Clock size={36} className="vhm-empty-icon" />
                <p>请在左侧选择一个历史版本以查看预览或差异</p>
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  )
}
