import { useEffect, useRef, useState } from 'react'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { isHtmlFile } from '../lib/importFile'
import type { TabItem } from '../store/prefs'
import type { Note, FileEntry } from '../lib/db'
import './TabBar.css'

interface TabBarProps {
  tabs: TabItem[]
  activeTabId: string | null
  notes: Note[] | undefined
  files: FileEntry[] | undefined
  onSelectTab: (tab: TabItem) => void
  onCloseTab: (tabId: string) => void
  onCloseOtherTabs: (tabId: string) => void
  onCloseAllTabs: () => void
  onNewNote?: () => void
}

export function TabBar({
  tabs,
  activeTabId,
  notes,
  files,
  onSelectTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseAllTabs,
  onNewNote,
}: TabBarProps) {
  const tabListRef = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)

  // 当前激活 tab 改变时，确保自动滚入视口
  useEffect(() => {
    if (!activeTabId || !tabListRef.current) return
    const el = tabListRef.current.querySelector<HTMLElement>(`[data-tab-id="${activeTabId}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [activeTabId])

  if (tabs.length === 0) return null

  const getTabInfo = (tab: TabItem) => {
    if (tab.kind === 'note') {
      const note = notes?.find((n) => n.id === tab.id)
      const title = note?.title?.trim() || '无标题'
      return {
        title,
        kind: 'note' as const,
      }
    } else {
      const file = files?.find((f) => f.id === tab.id)
      const filename = file?.filename || '文件'
      const isHtml = file ? isHtmlFile(file) : false
      return {
        title: filename,
        kind: isHtml ? ('html' as const) : ('pdf' as const),
      }
    }
  }

  const handleContextMenu = (e: React.MouseEvent, tab: TabItem) => {
    e.preventDefault()
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          key: 'close',
          label: '关闭标签',
          onClick: () => onCloseTab(tab.id),
        },
        {
          key: 'close-others',
          label: '关闭其他标签',
          onClick: () => onCloseOtherTabs(tab.id),
        },
        {
          key: 'close-all',
          label: '关闭全部标签',
          danger: true,
          onClick: onCloseAllTabs,
        },
      ],
    })
  }

  return (
    <>
      <div className="tab-bar-container">
        <div className="tab-bar-scroll" ref={tabListRef} role="tablist" aria-label="已打开的标签">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId
            const info = getTabInfo(tab)

            return (
              <div
                key={tab.id}
                data-tab-id={tab.id}
                role="tab"
                aria-selected={isActive}
                tabIndex={0}
                className={isActive ? 'tab-item active' : 'tab-item'}
                onClick={() => onSelectTab(tab)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelectTab(tab)
                  }
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault()
                    e.stopPropagation()
                    onCloseTab(tab.id)
                  }
                }}
                onContextMenu={(e) => handleContextMenu(e, tab)}
                title={info.title}
              >
                <span className="tab-icon">
                  {info.kind === 'note' ? (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                      <line x1="16" y1="13" x2="8" y2="13" />
                      <line x1="16" y1="17" x2="8" y2="17" />
                      <polyline points="10 9 9 9 8 9" />
                    </svg>
                  ) : info.kind === 'html' ? (
                    <span className="tab-badge html">HTML</span>
                  ) : (
                    <span className="tab-badge pdf">PDF</span>
                  )}
                </span>
                <span className="tab-title">{info.title}</span>
                <button
                  type="button"
                  className="tab-close-btn"
                  title="关闭标签 (中键或点击)"
                  aria-label={`关闭标签 ${info.title}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onCloseTab(tab.id)
                  }}
                >
                  ×
                </button>
              </div>
            )
          })}
        </div>
        {onNewNote && (
          <button
            type="button"
            className="tab-new-btn"
            title="新建笔记"
            aria-label="新建笔记"
            onClick={onNewNote}
          >
            +
          </button>
        )}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  )
}
