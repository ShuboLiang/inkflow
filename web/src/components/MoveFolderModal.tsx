import { useMemo, useState, useEffect, useRef } from 'react'
import {
  Folder as FolderIcon,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Inbox,
  Search,
  X,
  Check,
} from 'lucide-react'
import type { Folder } from '../lib/db'
import './MoveFolderModal.css'

interface MoveFolderModalProps {
  isOpen: boolean
  targetTitle: string
  currentFolderId: string | null
  folders: Folder[]
  onSelectFolder: (targetFolderId: string | null) => void
  onClose: () => void
}

interface TreeNode {
  folder: Folder
  depth: number
  hasChildren: boolean
}

export function MoveFolderModal({
  isOpen,
  targetTitle,
  currentFolderId,
  folders,
  onSelectFolder,
  onClose,
}: MoveFolderModalProps) {
  const [search, setSearch] = useState('')
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(currentFolderId)
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // 当弹窗打开时重置状态
  if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen)
    if (isOpen) {
      setSelectedFolderId(currentFolderId)
      setSearch('')
    }
  }

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 50)
    }
  }, [isOpen])

  // ESC 键关闭，Enter 键确认
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault()
        onSelectFolder(selectedFolderId)
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, selectedFolderId, onSelectFolder, onClose])

  // 构建父子文件夹关系映射
  const childrenMap = useMemo(() => {
    const map = new Map<string | null, Folder[]>()
    for (const f of folders) {
      const pid = f.parentId ?? null
      const list = map.get(pid) ?? []
      list.push(f)
      map.set(pid, list)
    }
    // 每一层同级文件夹按名称排序
    for (const list of map.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    }
    return map
  }, [folders])

  // 展开 / 折叠切换
  const toggleCollapse = (folderId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setCollapsedIds((prev) => {
      const next = new Set(prev)
      if (next.has(folderId)) {
        next.delete(folderId)
      } else {
        next.add(folderId)
      }
      return next
    })
  }

  // 扁平化树节点（考虑折叠状态）
  const flattenedTree = useMemo(() => {
    const result: TreeNode[] = []
    const traverse = (parentId: string | null, depth: number) => {
      const children = childrenMap.get(parentId) ?? []
      for (const child of children) {
        const hasChildren = (childrenMap.get(child.id)?.length ?? 0) > 0
        result.push({ folder: child, depth, hasChildren })
        if (hasChildren && !collapsedIds.has(child.id)) {
          traverse(child.id, depth + 1)
        }
      }
    }
    traverse(null, 0)
    return result
  }, [childrenMap, collapsedIds])

  // 过滤后的列表（如果输入了搜索词，则过滤显示）
  const filteredList = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return flattenedTree

    // 搜索模式：平铺展示所有命中的文件夹并带有路径提示
    return folders
      .filter((f) => f.name.toLowerCase().includes(q))
      .map((f) => ({ folder: f, depth: 0, hasChildren: false }))
      .sort((a, b) => a.folder.name.localeCompare(b.folder.name, 'zh-Hans-CN'))
  }, [search, flattenedTree, folders])

  if (!isOpen) return null

  // 获取选中目标的名称
  const selectedName =
    selectedFolderId === null
      ? '根目录 (全部笔记)'
      : folders.find((f) => f.id === selectedFolderId)?.name ?? '已选文件夹'

  const handleConfirm = () => {
    onSelectFolder(selectedFolderId)
    onClose()
  }

  return (
    <div
      className="move-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="move-modal-title"
    >
      <div className="move-modal-card">
        <div className="move-modal-header">
          <div className="move-modal-header-text">
            <h2 id="move-modal-title" className="move-modal-title">
              移动到文件夹
            </h2>
            <p className="move-modal-subtitle" title={targetTitle}>
              目标：{targetTitle || '无标题'}
            </p>
          </div>
          <button
            type="button"
            className="move-modal-close"
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </div>

        {/* 搜索框 */}
        <div className="move-modal-search">
          <Search size={14} className="move-search-icon" aria-hidden="true" />
          <input
            ref={searchInputRef}
            type="search"
            className="move-search-input"
            placeholder="搜索文件夹…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              type="button"
              className="move-search-clear"
              onClick={() => setSearch('')}
              aria-label="清空搜索"
            >
              <X size={12} />
            </button>
          )}
        </div>

        {/* 树状文件夹列表 */}
        <div className="move-tree-list">
          {/* 根目录选项（无文件夹） */}
          {!search && (
            <div
              className={`move-tree-item ${selectedFolderId === null ? 'selected' : ''} ${currentFolderId === null ? 'is-current' : ''}`}
              onClick={() => setSelectedFolderId(null)}
              onDoubleClick={handleConfirm}
              role="button"
              tabIndex={0}
            >
              <div className="move-item-toggle-placeholder" />
              <div className="move-item-icon">
                <Inbox size={16} />
              </div>
              <span className="move-item-name">根目录 (无文件夹)</span>
              {currentFolderId === null && <span className="move-item-badge">当前位置</span>}
              {selectedFolderId === null && <Check size={16} className="move-item-check" />}
            </div>
          )}

          {/* 文件夹树节点 */}
          {filteredList.length > 0 ? (
            filteredList.map(({ folder, depth, hasChildren }) => {
              const isSelected = selectedFolderId === folder.id
              const isCurrent = currentFolderId === folder.id
              const isCollapsed = collapsedIds.has(folder.id)

              return (
                <div
                  key={folder.id}
                  className={`move-tree-item ${isSelected ? 'selected' : ''} ${isCurrent ? 'is-current' : ''}`}
                  style={{ paddingLeft: `${12 + depth * 20}px` }}
                  onClick={() => setSelectedFolderId(folder.id)}
                  onDoubleClick={handleConfirm}
                  role="button"
                  tabIndex={0}
                >
                  {/* 折叠/展开箭头 */}
                  {hasChildren && !search ? (
                    <button
                      type="button"
                      className="move-item-toggle"
                      onClick={(e) => toggleCollapse(folder.id, e)}
                      aria-label={isCollapsed ? '展开子文件夹' : '折叠子文件夹'}
                    >
                      {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    </button>
                  ) : (
                    <div className="move-item-toggle-placeholder" />
                  )}

                  {/* 文件夹图标 */}
                  <div className="move-item-icon">
                    {isSelected || (!isCollapsed && hasChildren) ? (
                      <FolderOpen size={16} />
                    ) : (
                      <FolderIcon size={16} />
                    )}
                  </div>

                  {/* 文件夹名称 */}
                  <span className="move-item-name">{folder.name}</span>

                  {/* 状态徽标 */}
                  {isCurrent && <span className="move-item-badge">当前位置</span>}
                  {isSelected && <Check size={16} className="move-item-check" />}
                </div>
              )
            })
          ) : (
            <div className="move-tree-empty">未找到匹配的文件夹</div>
          )}
        </div>

        {/* 底部操作区 */}
        <div className="move-modal-footer">
          <div className="move-modal-target-preview">
            移动至：<span className="move-target-strong">{selectedName}</span>
          </div>
          <div className="move-modal-actions">
            <button type="button" className="move-btn-cancel" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="move-btn-confirm"
              onClick={handleConfirm}
              disabled={selectedFolderId === currentFolderId}
            >
              {selectedFolderId === currentFolderId ? '已在此位置' : '确认移动'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
