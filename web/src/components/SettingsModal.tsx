import { useEffect } from 'react'
import { Settings, X, FolderTree, Type, BookOpen } from 'lucide-react'
import './SettingsModal.css'

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
  includeSubfolders: boolean
  onToggleIncludeSubfolders: (val: boolean) => void
  toolbarHidden: boolean
  onToggleToolbarHidden: (val: boolean) => void
  readingMode: boolean
  onToggleReadingMode: (val: boolean) => void
  email?: string
}

export function SettingsModal({
  isOpen,
  onClose,
  includeSubfolders,
  onToggleIncludeSubfolders,
  toolbarHidden,
  onToggleToolbarHidden,
  readingMode,
  onToggleReadingMode,
  email,
}: SettingsModalProps) {
  // ESC 键关闭
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div
      className="settings-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-dialog-title"
    >
      <div className="settings-card" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h3 id="settings-dialog-title" className="settings-title">
            <Settings size={18} color="var(--qing)" />
            <span>偏好设置</span>
          </h3>
          <button
            type="button"
            className="settings-close"
            onClick={onClose}
            title="关闭"
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </div>

        <div className="settings-body">
          {/* 文件夹视图设置 */}
          <div className="settings-section">
            <span className="settings-section-title">文件夹视图</span>

            <div className="settings-item">
              <div className="settings-item-text">
                <span className="settings-item-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <FolderTree size={16} color="var(--qing)" />
                  父文件夹包含子文件夹内容
                </span>
                <span className="settings-item-desc">
                  默认关闭（严格模式：仅显示直属笔记与文件）；开启后，点击父文件夹会递归汇总所有子文件夹的内容。
                </span>
              </div>
              <label className="settings-switch">
                <input
                  type="checkbox"
                  checked={includeSubfolders}
                  onChange={(e) => onToggleIncludeSubfolders(e.target.checked)}
                />
                <span className="settings-slider" />
              </label>
            </div>
          </div>

          {/* 编辑器偏好 */}
          <div className="settings-section">
            <span className="settings-section-title">编辑器与阅读</span>

            <div className="settings-item">
              <div className="settings-item-text">
                <span className="settings-item-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Type size={16} />
                  默认隐藏格式工具栏
                </span>
                <span className="settings-item-desc">
                  开启后默认隐藏正文上方的格式工具栏（快捷键随时可用，也可点击顶栏 Aa 按钮临时展开）。
                </span>
              </div>
              <label className="settings-switch">
                <input
                  type="checkbox"
                  checked={toolbarHidden}
                  onChange={(e) => onToggleToolbarHidden(e.target.checked)}
                />
                <span className="settings-slider" />
              </label>
            </div>

            <div className="settings-item">
              <div className="settings-item-text">
                <span className="settings-item-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <BookOpen size={16} />
                  阅读模式
                </span>
                <span className="settings-item-desc">
                  纯净阅读体验，锁定光标避免误触编辑（快捷键 Ctrl+E）。
                </span>
              </div>
              <label className="settings-switch">
                <input
                  type="checkbox"
                  checked={readingMode}
                  onChange={(e) => onToggleReadingMode(e.target.checked)}
                />
                <span className="settings-slider" />
              </label>
            </div>
          </div>

          {/* 账号信息 */}
          {email && (
            <div className="settings-section">
              <span className="settings-section-title">账号与同步</span>
              <div className="settings-item" style={{ padding: '10px 14px' }}>
                <div className="settings-item-text">
                  <span className="settings-item-label" style={{ fontSize: 13 }}>当前登录账号</span>
                  <span className="settings-item-desc" style={{ fontFamily: 'var(--font-mono)' }}>{email}</span>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="settings-footer">
          <button type="button" className="settings-ok-btn" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  )
}
