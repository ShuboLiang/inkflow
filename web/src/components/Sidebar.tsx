import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ChevronRight,
  ChevronDown,
  Plus,
  Pencil,
  Search,
  Trash2,
  MoreHorizontal,
  LogOut,
  X,
  Settings,
} from 'lucide-react'
import { useDroppable } from '@dnd-kit/core'
import type { Folder } from '../lib/db'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { ThemePicker } from './ThemePicker'
import './Sidebar.css'

// 文件夹 HTML5 拖拽（嵌套移动）仅在精确指针设备启用
const DRAG_FINE = typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches

// dnd-kit 放置区外壳：卡片拖到侧栏文件夹/「默认」/标签行时高亮。
// over-highlight 由 isOver 驱动，与 HTML5 拖放的 drag-over 样式共用
export function DropZone({
  dndId,
  accept,
  className,
  children,
  ...rest
}: {
  dndId: string
  accept: ('item' | 'folder-item')[]
  className?: string
  children: ReactNode
} & React.HTMLAttributes<HTMLDivElement>) {
  const { setNodeRef, isOver } = useDroppable({ id: dndId, data: { type: 'zone', accept } })
  return (
    <div ref={setNodeRef} className={isOver ? `${className ?? ''} dnd-over`.trim() : className} {...rest}>
      {children}
    </div>
  )
}

// 标签收纳：默认只显示前 N 个（数量优先排序下的常用标签），
// 总数超过阈值再出现搜索框；两个开关状态都记在 localStorage
const TAGS_PREVIEW = 10
const TAGS_SEARCH_THRESHOLD = 15
const TAGS_COLLAPSED_KEY = 'inkflow:sidebar:tagsCollapsed'
const TAGS_SHOW_ALL_KEY = 'inkflow:sidebar:tagsShowAll'

interface SidebarProps {
  email: string
  collapsed: boolean
  folders: Folder[]
  counts: Map<string, number>
  allCount: number
  tags: Map<string, number>
  activeFolderId: string // 'all' 表示全部，否则为文件夹 id
  activeTag: string | null
  onSelectFolder: (id: string) => void
  onCreateFolder: (name: string, parentId: string | null) => void
  onRenameFolder: (id: string, name: string) => void
  onDeleteFolder: (id: string) => void
  onDropFolder: (folderId: string, parentId: string | null) => void
  onToggleTag: (name: string) => void
  onRenameTag: (oldName: string, newName: string) => void
  onDeleteTag: (name: string) => void
  onFilesDrop: (files: File[], folderId: string | null) => void
  theme: string
  onThemeChange: (id: string) => void
  onSignOut: () => void
  onOpenSettings?: () => void
}

// 行内输入框：Enter 提交、Esc 取消、失焦提交；提交时空白视为取消。
// indent = 在树中的深度（子文件夹新建/重命名时对齐父级行）
function InlineNameInput({
  defaultValue,
  onSubmit,
  onCancel,
  ariaLabel,
  indent = 0,
}: {
  defaultValue: string
  onSubmit: (name: string) => void
  onCancel: () => void
  ariaLabel: string
  indent?: number
}) {
  const [value, setValue] = useState(defaultValue)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const commit = () => {
    const name = value.trim()
    if (name) onSubmit(name)
    else onCancel()
  }

  return (
    <input
      ref={inputRef}
      className="sidebar-folder-input"
      style={indent > 0 ? { marginLeft: 8 + indent * 16, width: `calc(100% - ${16 + indent * 16}px)` } : undefined}
      value={value}
      aria-label={ariaLabel}
      placeholder="文件夹名称"
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') onCancel()
      }}
    />
  )
}

export function Sidebar({
  email,
  collapsed,
  folders,
  counts,
  allCount,
  tags,
  activeFolderId,
  activeTag,
  onSelectFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onDropFolder,
  onToggleTag,
  onRenameTag,
  onDeleteTag,
  onFilesDrop,
  theme,
  onThemeChange,
  onSignOut,
  onOpenSettings,
}: SidebarProps) {
  const [creating, setCreating] = useState(false)
  const [creatingChildOf, setCreatingChildOf] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTag, setEditingTag] = useState<string | null>(null)
  // 树形收起状态（默认全部展开）
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set())
  // 右键菜单：目标与屏幕位置
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  // 拖拽悬停的放置目标（'all' / 文件夹 id / tag:xxx），用于高亮反馈
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  // 标签区收纳：整区折叠 / 展开全部 / 搜索过滤
  const [tagsCollapsed, setTagsCollapsed] = useState(() => localStorage.getItem(TAGS_COLLAPSED_KEY) === 'true')
  const [tagsShowAll, setTagsShowAll] = useState(() => localStorage.getItem(TAGS_SHOW_ALL_KEY) === 'true')
  const [tagFilter, setTagFilter] = useState('')

  const toggleTagsCollapsed = () => {
    setTagsCollapsed((cur) => {
      localStorage.setItem(TAGS_COLLAPSED_KEY, String(!cur))
      return !cur
    })
  }
  const toggleTagsShowAll = () => {
    setTagsShowAll((cur) => {
      localStorage.setItem(TAGS_SHOW_ALL_KEY, String(!cur))
      return !cur
    })
  }

  // 搜索过滤 + 截断：搜索中忽略前 N 截断；折叠态下激活的标签也保证可见
  const tagQuery = tagFilter.trim().toLowerCase()
  const allTags = useMemo(() => [...tags.entries()], [tags])
  const matchedTags = useMemo(
    () => (tagQuery ? allTags.filter(([name]) => name.toLowerCase().includes(tagQuery)) : allTags),
    [allTags, tagQuery],
  )
  const visibleTags = useMemo(() => {
    if (tagQuery || tagsShowAll || matchedTags.length <= TAGS_PREVIEW) return matchedTags
    const head = matchedTags.slice(0, TAGS_PREVIEW)
    if (activeTag && !head.some(([name]) => name === activeTag)) {
      const active = matchedTags.find(([name]) => name === activeTag)
      if (active) return [...head, active]
    }
    return head
  }, [matchedTags, tagQuery, tagsShowAll, activeTag])

  // 按父级分组的树（每层内已按中文拼音排序）
  const childrenByParent = useMemo(() => {
    const m = new Map<string | null, Folder[]>()
    for (const f of folders) {
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

  const toggleCollapse = (id: string) => {
    setCollapsedFolders((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // 选中文件夹变化（含搜索跳转）时自动展开它的祖先链，保证目标可见。
  // 渲染期调整状态（避免 effect 里 setState 触发级联渲染）
  const [lastActiveFolderId, setLastActiveFolderId] = useState(activeFolderId)
  if (lastActiveFolderId !== activeFolderId) {
    setLastActiveFolderId(activeFolderId)
    if (activeFolderId !== 'all') {
      const byId = new Map(folders.map((f) => [f.id, f]))
      const ancestors: string[] = []
      let cur = byId.get(activeFolderId)
      while (cur?.parentId) {
        ancestors.push(cur.parentId)
        cur = byId.get(cur.parentId)
      }
      if (ancestors.length) {
        setCollapsedFolders((prev) => {
          const next = new Set(prev)
          for (const a of ancestors) next.delete(a)
          return next
        })
      }
    }
  }

  // HTML5 拖放只保留两类：外部 OS 文件拖入（上传到该文件夹）与文件夹行拖拽（dir:，嵌套移动）。
  // 卡片（note:/file:）的拖放已迁移到 dnd-kit（DropZone 外壳），鼠标和触屏都能拖
  const dropHandlers = (target: string, folderId: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      const hasFiles = e.dataTransfer.types.includes('Files')
      const hasDir = !hasFiles && e.dataTransfer.types.includes('text/plain')
      if (!hasFiles && !hasDir) return
      e.preventDefault()
      e.dataTransfer.dropEffect = hasFiles ? 'copy' : 'move'
      setDropTarget(target)
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) {
        setDropTarget((cur) => (cur === target ? null : cur))
      }
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      setDropTarget(null)
      if (e.dataTransfer.files.length > 0) {
        onFilesDrop(Array.from(e.dataTransfer.files), folderId)
        return
      }
      const payload = e.dataTransfer.getData('text/plain')
      if (payload.startsWith('dir:')) onDropFolder(payload.slice(4), folderId)
    },
  })

  const itemClass = (id: string, active: boolean) =>
    [
      'sidebar-item',
      active ? 'active' : '',
      dropTarget === id ? 'drag-over' : '',
    ]
      .filter(Boolean)
      .join(' ')

  const folderClass = (id: string, active: boolean) =>
    [
      'sidebar-folder',
      active ? 'active' : '',
      dropTarget === id ? 'drag-over' : '',
    ]
      .filter(Boolean)
      .join(' ')

  const tagClass = (name: string) =>
    [
      'sidebar-folder',
      activeTag === name ? 'active' : '',
      dropTarget === `tag:${name}` ? 'drag-over' : '',
    ]
      .filter(Boolean)
      .join(' ')

  const openMenu = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  // 触屏设备没有右键：行尾按钮打开同一个菜单，锚在按钮下方
  const moreButton = (items: MenuItem[], label: string) => (
    <button
      type="button"
      className="sidebar-more"
      aria-label={`${label} 更多操作`}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        setMenu({ x: r.left, y: r.bottom + 4, items })
      }}
    >
      <MoreHorizontal size={14} />
    </button>
  )

  const folderMenuItems = (folder: Folder): MenuItem[] => [
    {
      key: 'sub',
      label: '新建子文件夹',
      onClick: () => {
        setCreating(false)
        setEditingId(null)
        setCreatingChildOf(folder.id)
      },
    },
    {
      key: 'rename',
      label: '重命名',
      onClick: () => {
        setCreating(false)
        setCreatingChildOf(null)
        setEditingId(folder.id)
      },
    },
    { key: 'd1', label: '', divider: true, onClick: () => {} },
    { key: 'del', label: '删除', danger: true, onClick: () => onDeleteFolder(folder.id) },
  ]

  const tagMenuItems = (name: string): MenuItem[] => [
    { key: 'rename', label: '重命名', onClick: () => setEditingTag(name) },
    { key: 'd1', label: '', divider: true, onClick: () => {} },
    { key: 'del', label: '删除', danger: true, onClick: () => onDeleteTag(name) },
  ]

  // 递归渲染文件夹树：缩进 + 展开箭头；行可拖拽（移动层级）、可放置笔记/文件/子文件夹
  const renderFolderTree = (parentId: string | null, depth: number): ReactNode =>
    (childrenByParent.get(parentId) ?? []).map((folder) => {
      const children = childrenByParent.get(folder.id) ?? []
      const isCollapsed = collapsedFolders.has(folder.id)
      return (
        <div key={folder.id}>
          {editingId === folder.id ? (
            <InlineNameInput
              ariaLabel="重命名文件夹"
              defaultValue={folder.name}
              indent={Math.min(depth, 3)}
              onSubmit={(name) => {
                onRenameFolder(folder.id, name)
                setEditingId(null)
              }}
              onCancel={() => setEditingId(null)}
            />
          ) : creatingChildOf === folder.id ? (
            <InlineNameInput
              ariaLabel="新子文件夹名称"
              defaultValue=""
              indent={Math.min(depth + 1, 3)}
              onSubmit={(name) => {
                onCreateFolder(name, folder.id)
                setCreatingChildOf(null)
              }}
              onCancel={() => setCreatingChildOf(null)}
            />
          ) : (
            <DropZone
              dndId={`folder-zone:${folder.id}`}
              accept={['item']}
              className={folderClass(folder.id, folder.id === activeFolderId)}
              style={{ paddingLeft: 10 + Math.min(depth, 3) * 16 }}
              {...dropHandlers(folder.id, folder.id)}
              onContextMenu={(e) => openMenu(e, folderMenuItems(folder))}
              draggable={DRAG_FINE}
              onDragStart={(e) => {
                e.stopPropagation()
                e.dataTransfer.setData('text/plain', `dir:${folder.id}`)
                e.dataTransfer.effectAllowed = 'move'
              }}
            >
              {children.length > 0 ? (
                <button
                  type="button"
                  className="sidebar-tree-toggle"
                  title={isCollapsed ? '展开' : '收起'}
                  aria-label={isCollapsed ? `展开 ${folder.name}` : `收起 ${folder.name}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleCollapse(folder.id)
                  }}
                >
                  {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                </button>
              ) : (
                <span className="sidebar-tree-toggle-placeholder" aria-hidden="true" />
              )}
              <button
                type="button"
                className="sidebar-folder-name"
                title={folder.name}
                onClick={() => onSelectFolder(folder.id)}
                onDoubleClick={() => setEditingId(folder.id)}
              >
                {folder.name}
              </button>
              {(counts.get(folder.id) ?? 0) > 0 && (
                <span className="sidebar-count">{counts.get(folder.id)}</span>
              )}
              <span className="sidebar-folder-actions">
                <button
                  type="button"
                  className="sidebar-folder-action"
                  title="新建子文件夹"
                  aria-label={`在 ${folder.name} 下新建子文件夹`}
                  onClick={() => {
                    setCreating(false)
                    setEditingId(null)
                    setCreatingChildOf(folder.id)
                  }}
                >
                  <Plus size={14} />
                </button>
                <button
                  type="button"
                  className="sidebar-folder-action"
                  title="重命名"
                  aria-label={`重命名 ${folder.name}`}
                  onClick={() => {
                    setCreating(false)
                    setCreatingChildOf(null)
                    setEditingId(folder.id)
                  }}
                >
                  <Pencil size={13} />
                </button>
                <button
                  type="button"
                  className="sidebar-folder-action"
                  title="删除"
                  aria-label={`删除 ${folder.name}`}
                  onClick={() => onDeleteFolder(folder.id)}
                >
                  <Trash2 size={13} />
                </button>
              </span>
              {moreButton(folderMenuItems(folder), folder.name)}
            </DropZone>
          )}
          {!isCollapsed && renderFolderTree(folder.id, depth + 1)}
        </div>
      )
    })

  return (
    <nav className={collapsed ? 'sidebar collapsed' : 'sidebar'} aria-label="侧栏">
      <div className="sidebar-brand">InkFlow</div>
      <DropZone dndId="zone:all" accept={['item']} className="sidebar-zone-item">
        <button
          type="button"
          className={itemClass('all', activeFolderId === 'all')}
          onClick={() => onSelectFolder('all')}
          {...dropHandlers('all', null)}
        >
          <span>默认</span>
          <span className="sidebar-count">{allCount}</span>
        </button>
      </DropZone>
      <div className="sidebar-section">
        <span>文件夹</span>
        <button
          type="button"
          className="sidebar-section-add"
          title="新建文件夹"
          aria-label="新建文件夹"
          onClick={() => {
            setEditingId(null)
            setCreating(true)
          }}
        >
          <Plus size={15} />
        </button>
      </div>
      {creating && (
        <InlineNameInput
          ariaLabel="新文件夹名称"
          defaultValue=""
          onSubmit={(name) => {
            onCreateFolder(name, null)
            setCreating(false)
          }}
          onCancel={() => setCreating(false)}
        />
      )}
      {folders.length === 0 && !creating ? (
        <div className="sidebar-empty">暂无文件夹</div>
      ) : (
        renderFolderTree(null, 0)
      )}
      {tags.size === 0 ? (
        <div className="sidebar-section">标签</div>
      ) : (
        <button
          type="button"
          className="sidebar-section sidebar-section-toggle"
          onClick={toggleTagsCollapsed}
          aria-expanded={!tagsCollapsed}
        >
          <span>标签</span>
          {tagsCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
      )}
      {tags.size === 0 && <div className="sidebar-empty">暂无标签</div>}
      {!tagsCollapsed && tags.size > 0 && allTags.length > TAGS_SEARCH_THRESHOLD && (
        <div className="sidebar-tag-search">
          <Search size={14} className="sidebar-tag-search-icon" />
          <input
            type="text"
            value={tagFilter}
            placeholder="搜索标签…"
            aria-label="搜索标签"
            onChange={(e) => setTagFilter(e.target.value)}
          />
          {tagFilter && (
            <button
              type="button"
              className="sidebar-tag-search-clear"
              aria-label="清空标签搜索"
              onClick={() => setTagFilter('')}
            >
              <X size={15} />
            </button>
          )}
        </div>
      )}
      {!tagsCollapsed &&
        tags.size > 0 &&
        (matchedTags.length === 0 ? (
          <div className="sidebar-empty">{tagQuery ? '无匹配标签' : '暂无标签'}</div>
        ) : (
          <>
            {visibleTags.map(([name, count]) =>
              editingTag === name ? (
                <InlineNameInput
                  key={`tag-${name}`}
                  ariaLabel="重命名标签"
                  defaultValue={name}
                  onSubmit={(newName) => {
                    onRenameTag(name, newName)
                    setEditingTag(null)
                  }}
                  onCancel={() => setEditingTag(null)}
                />
              ) : (
                <DropZone
                  key={`tag-${name}`}
                  dndId={`tag-zone:${name}`}
                  accept={['item']}
                  className={tagClass(name)}
                  onContextMenu={(e) => openMenu(e, tagMenuItems(name))}
                >
                  <button
                    type="button"
                    className="sidebar-folder-name"
                    title={`#${name}`}
                    onClick={() => onToggleTag(name)}
                    onDoubleClick={() => setEditingTag(name)}
                  >
                    # {name}
                  </button>
                  {count > 0 && <span className="sidebar-count">{count}</span>}
                  <span className="sidebar-folder-actions">
                    <button
                      type="button"
                      className="sidebar-folder-action"
                      title="重命名"
                      aria-label={`重命名标签 ${name}`}
                      onClick={() => setEditingTag(name)}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      className="sidebar-folder-action"
                      title="删除"
                      aria-label={`删除标签 ${name}`}
                      onClick={() => onDeleteTag(name)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </span>
                  {moreButton(tagMenuItems(name), name)}
                </DropZone>
              ),
            )}
            {!tagQuery && matchedTags.length > TAGS_PREVIEW && (
              <button type="button" className="sidebar-tags-more" onClick={toggleTagsShowAll}>
                {tagsShowAll ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <span>{tagsShowAll ? '收起标签列表' : `显示全部 ${matchedTags.length} 个标签`}</span>
              </button>
            )}
          </>
        ))}
      <div className="sidebar-footer">
        <ThemePicker theme={theme} onChange={onThemeChange} />
        <span className="sidebar-email" title={email}>
          {email}
        </span>
        {onOpenSettings && (
          <button type="button" className="sidebar-signout" onClick={onOpenSettings}>
            <Settings size={13} />
            <span>偏好设置</span>
          </button>
        )}
        <button type="button" className="sidebar-signout" onClick={onSignOut}>
          <LogOut size={13} />
          <span>退出登录</span>
        </button>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </nav>
  )
}
