import { useEffect, useRef, useState } from 'react'
import type { Folder } from '../lib/db'
import { ContextMenu, type MenuItem } from './ContextMenu'
import './Sidebar.css'

interface SidebarProps {
  email: string
  collapsed: boolean
  folders: Folder[]
  counts: Map<string, number>
  allCount: number
  unfiledCount: number
  tags: Map<string, number>
  activeFolderId: string // 'all' / 'none' 表示全部/未归档，否则为文件夹 id
  activeTag: string | null
  onSelectFolder: (id: string) => void
  onDropNote: (noteId: string, folderId: string | null) => void
  onCreateFolder: (name: string) => void
  onRenameFolder: (id: string, name: string) => void
  onDeleteFolder: (id: string) => void
  onToggleTag: (name: string) => void
  onRenameTag: (oldName: string, newName: string) => void
  onDeleteTag: (name: string) => void
  onDropNoteToTag: (noteId: string, tag: string) => void
  onDropFile: (fileId: string, folderId: string | null) => void
  onFilesDrop: (files: File[], folderId: string | null) => void
  onSignOut: () => void
}

function IconPencil() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  )
}

function IconCross() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}

function IconPlus() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

// 行内输入框：Enter 提交、Esc 取消、失焦提交；提交时空白视为取消
function InlineNameInput({
  defaultValue,
  onSubmit,
  onCancel,
  ariaLabel,
}: {
  defaultValue: string
  onSubmit: (name: string) => void
  onCancel: () => void
  ariaLabel: string
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
  unfiledCount,
  tags,
  activeFolderId,
  activeTag,
  onSelectFolder,
  onDropNote,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onToggleTag,
  onRenameTag,
  onDeleteTag,
  onDropNoteToTag,
  onDropFile,
  onFilesDrop,
  onSignOut,
}: SidebarProps) {
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTag, setEditingTag] = useState<string | null>(null)
  // 右键菜单：目标与屏幕位置
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  // 拖拽悬停的放置目标（'all' / 'none' / 文件夹 id / tag:xxx），用于高亮反馈
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  // 列表拖来的放置负载：'note:<id>' / 'file:<id>'，文件夹与未归档两者都收；
  // 外部拖入的 Files 直接上传到该文件夹
  const dropHandlers = (target: string, folderId: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      const hasFiles = e.dataTransfer.types.includes('Files')
      if (!hasFiles && !e.dataTransfer.types.includes('text/plain')) return
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
      if (payload.startsWith('note:')) onDropNote(payload.slice(5), folderId)
      else if (payload.startsWith('file:')) onDropFile(payload.slice(5), folderId)
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

  // 拖到标签上 = 给笔记加该标签（不动文件夹归属）
  const tagDropHandlers = (tag: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('text/plain')) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'link'
      setDropTarget(`tag:${tag}`)
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) {
        setDropTarget((cur) => (cur === `tag:${tag}` ? null : cur))
      }
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      setDropTarget(null)
      const payload = e.dataTransfer.getData('text/plain')
      if (payload.startsWith('note:')) onDropNoteToTag(payload.slice(5), tag)
    },
  })

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

  const folderMenuItems = (folder: Folder): MenuItem[] => [
    {
      key: 'rename',
      label: '重命名',
      onClick: () => {
        setCreating(false)
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

  return (
    <nav className={collapsed ? 'sidebar collapsed' : 'sidebar'} aria-label="侧栏">
      <div className="sidebar-brand">InkFlow</div>
      <button
        type="button"
        className={itemClass('all', activeFolderId === 'all')}
        onClick={() => onSelectFolder('all')}
        {...dropHandlers('all', null)}
      >
        <span>全部笔记</span>
        <span className="sidebar-count">{allCount}</span>
      </button>
      <button
        type="button"
        className={itemClass('none', activeFolderId === 'none')}
        onClick={() => onSelectFolder('none')}
        {...dropHandlers('none', null)}
      >
        <span>未归档</span>
        <span className="sidebar-count">{unfiledCount}</span>
      </button>
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
          <IconPlus />
        </button>
      </div>
      {creating && (
        <InlineNameInput
          ariaLabel="新文件夹名称"
          defaultValue=""
          onSubmit={(name) => {
            onCreateFolder(name)
            setCreating(false)
          }}
          onCancel={() => setCreating(false)}
        />
      )}
      {folders.length === 0 && !creating ? (
        <div className="sidebar-empty">暂无文件夹</div>
      ) : (
        folders.map((folder) =>
          editingId === folder.id ? (
            <InlineNameInput
              key={folder.id}
              ariaLabel="重命名文件夹"
              defaultValue={folder.name}
              onSubmit={(name) => {
                onRenameFolder(folder.id, name)
                setEditingId(null)
              }}
              onCancel={() => setEditingId(null)}
            />
          ) : (
            <div
              key={folder.id}
              className={folderClass(folder.id, folder.id === activeFolderId)}
              {...dropHandlers(folder.id, folder.id)}
              onContextMenu={(e) => openMenu(e, folderMenuItems(folder))}
            >
              <button
                type="button"
                className="sidebar-folder-name"
                title={folder.name}
                onClick={() => onSelectFolder(folder.id)}
                onDoubleClick={() => setEditingId(folder.id)}
              >
                {folder.name}
              </button>
              <span className="sidebar-count">{counts.get(folder.id) ?? 0}</span>
              <span className="sidebar-folder-actions">
                <button
                  type="button"
                  className="sidebar-folder-action"
                  title="重命名"
                  aria-label={`重命名 ${folder.name}`}
                  onClick={() => {
                    setCreating(false)
                    setEditingId(folder.id)
                  }}
                >
                  <IconPencil />
                </button>
                <button
                  type="button"
                  className="sidebar-folder-action"
                  title="删除"
                  aria-label={`删除 ${folder.name}`}
                  onClick={() => onDeleteFolder(folder.id)}
                >
                  <IconCross />
                </button>
              </span>
            </div>
          ),
        )
      )}
      <div className="sidebar-section">标签</div>
      {tags.size === 0 ? (
        <div className="sidebar-empty">暂无标签</div>
      ) : (
        [...tags.entries()].map(([name, count]) =>
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
            <div
              key={`tag-${name}`}
              className={tagClass(name)}
              {...tagDropHandlers(name)}
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
              <span className="sidebar-count">{count}</span>
              <span className="sidebar-folder-actions">
                <button
                  type="button"
                  className="sidebar-folder-action"
                  title="重命名"
                  aria-label={`重命名标签 ${name}`}
                  onClick={() => setEditingTag(name)}
                >
                  <IconPencil />
                </button>
                <button
                  type="button"
                  className="sidebar-folder-action"
                  title="删除"
                  aria-label={`删除标签 ${name}`}
                  onClick={() => onDeleteTag(name)}
                >
                  <IconCross />
                </button>
              </span>
            </div>
          ),
        )
      )}
      <div className="sidebar-footer">
        <span className="sidebar-email" title={email}>
          {email}
        </span>
        <button type="button" className="sidebar-signout" onClick={onSignOut}>
          退出登录
        </button>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </nav>
  )
}
