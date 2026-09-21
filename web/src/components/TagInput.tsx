import { useEffect, useId, useMemo, useRef, useState } from 'react'
import './TagInput.css'

interface TagInputProps {
  tags: string[]
  // 全库已有标签（做补全建议与快速选择）
  suggestions: string[]
  onChange: (tags: string[]) => void
  onClose?: () => void
}

// 标签编辑面板：支持从全库已有标签中直接点选，支持输入搜索/实时过滤，支持回车创建新标签
export function TagInput({ tags, suggestions, onChange, onClose }: TagInputProps) {
  const [value, setValue] = useState('')
  const [createdTags, setCreatedTags] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const inputId = useId()

  useEffect(() => {
    // 桌面端自动聚焦输入框，便于直接打字；触屏设备不自动聚焦以防软键盘弹起遮挡已有标签
    if (window.matchMedia('(pointer: fine)').matches) {
      inputRef.current?.focus()
    }
  }, [])

  // 合并全库已有标签、当前笔记已挂载标签及当前面板新建标签，去重并按中文排序
  const allKnownTags = useMemo(() => {
    const map = new Map<string, string>()
    for (const s of suggestions) {
      if (!map.has(s.toLowerCase())) map.set(s.toLowerCase(), s)
    }
    for (const t of tags) {
      if (!map.has(t.toLowerCase())) map.set(t.toLowerCase(), t)
    }
    for (const c of createdTags) {
      if (!map.has(c.toLowerCase())) map.set(c.toLowerCase(), c)
    }
    return [...map.values()].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  }, [suggestions, tags, createdTags])

  const query = value.trim()

  // 根据用户输入过滤已有标签列表
  const filteredSuggestions = useMemo(() => {
    if (!query) return allKnownTags
    const q = query.toLowerCase()
    return allKnownTags.filter((s) => s.toLowerCase().includes(q))
  }, [allKnownTags, query])

  // 是否已有完全一致的标签（大小写不敏感）
  const exactMatch = useMemo(() => {
    if (!query) return null
    return allKnownTags.find((s) => s.toLowerCase() === query.toLowerCase()) ?? null
  }, [allKnownTags, query])

  // 提交添加新标签或现有标签
  const commit = (raw: string) => {
    const name = raw.trim().replace(/^#+/, '').replace(/,+$/, '').trim()
    if (!name) return
    const existing = allKnownTags.find((s) => s.toLowerCase() === name.toLowerCase())
    const finalName = existing || name
    setCreatedTags((prev) => (prev.includes(finalName) ? prev : [...prev, finalName]))
    if (!tags.some((t) => t.toLowerCase() === finalName.toLowerCase())) {
      onChange([...tags, finalName])
    }
    setValue('')
  }

  // 切换标签选中/取消
  const toggleTag = (tagName: string) => {
    const isSelected = tags.some((t) => t.toLowerCase() === tagName.toLowerCase())
    if (isSelected) {
      onChange(tags.filter((t) => t.toLowerCase() !== tagName.toLowerCase()))
    } else {
      onChange([...tags, tagName])
    }
  }

  const removeAt = (index: number) => {
    onChange(tags.filter((_, i) => i !== index))
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    if (v.includes(',')) {
      const parts = v.split(',')
      const validParts = parts
        .map((p) => p.trim().replace(/^#+/, ''))
        .filter(Boolean)
      if (validParts.length > 0) {
        let next = [...tags]
        for (const p of validParts) {
          const match = allKnownTags.find((s) => s.toLowerCase() === p.toLowerCase())
          const nameToAdd = match || p
          setCreatedTags((prev) => (prev.includes(nameToAdd) ? prev : [...prev, nameToAdd]))
          if (!next.some((t) => t.toLowerCase() === nameToAdd.toLowerCase())) {
            next.push(nameToAdd)
          }
        }
        onChange(next)
      }
      setValue('')
    } else {
      setValue(v)
    }
  }

  return (
    <div className="tag-panel">
      <div className="tag-panel-header">
        <span className="tag-panel-title">设置标签</span>
        {onClose && (
          <button
            type="button"
            className="tag-panel-close"
            onClick={onClose}
            aria-label="关闭标签面板"
            title="关闭"
          >
            ×
          </button>
        )}
      </div>

      <div className="tag-search-wrap">
        <svg
          className="tag-search-icon"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <input
          id={inputId}
          ref={inputRef}
          type="text"
          className="tag-search-input"
          value={value}
          placeholder="搜索或新建标签…"
          aria-label="搜索或新建标签"
          onChange={handleInputChange}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              if (exactMatch) {
                if (!tags.some((t) => t.toLowerCase() === exactMatch.toLowerCase())) {
                  onChange([...tags, exactMatch])
                }
                setValue('')
              } else if (query) {
                commit(query)
              }
            } else if (e.key === 'Backspace' && value === '' && tags.length > 0) {
              removeAt(tags.length - 1)
            } else if (e.key === 'Escape') {
              onClose?.()
            }
          }}
        />
        {value && (
          <button
            type="button"
            className="tag-search-clear"
            aria-label="清空输入"
            onClick={() => {
              setValue('')
              inputRef.current?.focus()
            }}
          >
            ×
          </button>
        )}
      </div>

      {query && !exactMatch && (
        <button
          type="button"
          className="tag-create-btn"
          onClick={() => {
            commit(query)
            inputRef.current?.focus()
          }}
        >
          <span className="tag-create-text">
            <span className="tag-create-plus">+</span>
            创建新标签 <strong>"{query}"</strong>
          </span>
          <span className="tag-key-hint">回车 ↵</span>
        </button>
      )}

      {tags.length > 0 && (
        <div className="tag-section">
          <div className="tag-section-title">
            已选标签 <span className="tag-section-count">({tags.length})</span>
          </div>
          <div className="tag-chip-list">
            {tags.map((tag, i) => (
              <span key={`${tag}-${i}`} className="tag-chip">
                <span className="tag-chip-hash">#</span>
                <span className="tag-chip-name">{tag}</span>
                <button
                  type="button"
                  aria-label={`移除标签 ${tag}`}
                  onClick={() => removeAt(i)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="tag-section">
        <div className="tag-section-title">
          {query ? '匹配标签' : '已有标签'}
          {filteredSuggestions.length > 0 && (
            <span className="tag-section-count">({filteredSuggestions.length})</span>
          )}
        </div>
        {filteredSuggestions.length > 0 ? (
          <div className="tag-choice-list" role="listbox" aria-label="选择已有标签">
            {filteredSuggestions.map((s) => {
              const isSelected = tags.some((t) => t.toLowerCase() === s.toLowerCase())
              return (
                <button
                  key={s}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={isSelected ? 'tag-choice-btn selected' : 'tag-choice-btn'}
                  title={isSelected ? `已选中 #${s}，点击移除` : `点击添加 #${s}`}
                  onClick={() => toggleTag(s)}
                >
                  <span className="tag-choice-icon" aria-hidden="true">
                    {isSelected ? '✓' : '+'}
                  </span>
                  <span className="tag-choice-name">{s}</span>
                </button>
              )
            })}
          </div>
        ) : (
          <div className="tag-empty-hint">
            {query ? '无匹配已有标签' : '全库暂无已有标签，输入后回车即可创建'}
          </div>
        )}
      </div>
    </div>
  )
}
