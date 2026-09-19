import { useMemo, useRef, useState } from 'react'
import './TagInput.css'

interface TagInputProps {
  tags: string[]
  // 全库已有标签（做补全建议），不含当前笔记已挂的
  suggestions: string[]
  onChange: (tags: string[]) => void
}

// 标题下方的标签编辑：chips + 行内输入，Enter/逗号/失焦提交，空输入时退格删最后一个。
// 大小写不敏感去重（避免「工作」和「工作」并存）。
export function TagInput({ tags, suggestions, onChange }: TagInputProps) {
  const [value, setValue] = useState('')
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const skipClose = useRef(false)

  const matched = useMemo(() => {
    const q = value.trim().toLowerCase()
    if (!q) return []
    return suggestions
      .filter((s) => s.toLowerCase().includes(q))
      .filter((s) => !tags.some((t) => t.toLowerCase() === s.toLowerCase()))
      .slice(0, 6)
  }, [value, suggestions, tags])

  const commit = (raw: string) => {
    const name = raw.trim().replace(/,+$/, '').trim()
    if (!name) return
    if (tags.some((t) => t.toLowerCase() === name.toLowerCase())) {
      setValue('')
      return
    }
    onChange([...tags, name])
    setValue('')
  }

  const removeAt = (index: number) => {
    onChange(tags.filter((_, i) => i !== index))
  }

  return (
    <div className="tag-input">
      {tags.map((tag, i) => (
        <span key={`${tag}-${i}`} className="tag-chip">
          {tag}
          <button
            type="button"
            aria-label={`移除标签 ${tag}`}
            onClick={() => removeAt(i)}
          >
            ×
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        value={value}
        placeholder={tags.length === 0 ? '添加标签，回车确认' : ''}
        aria-label="添加标签"
        onChange={(e) => {
          const v = e.target.value
          if (v.includes(',')) {
            const parts = v.split(',')
            parts.slice(0, -1).forEach((p) => commit(p))
            setValue(parts[parts.length - 1])
          } else {
            setValue(v)
          }
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // mousedown 选建议时先置标记，避免 blur 先于 click 关闭列表
          if (skipClose.current) {
            skipClose.current = false
            return
          }
          commit(value)
          setOpen(false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (matched.length > 0 && value.trim()) commit(matched[0])
            else commit(value)
          } else if (e.key === 'Backspace' && value === '' && tags.length > 0) {
            removeAt(tags.length - 1)
          } else if (e.key === 'Escape') {
            inputRef.current?.blur()
          }
        }}
      />
      {open && matched.length > 0 && (
        <ul className="tag-suggest" role="listbox">
          {matched.map((s) => (
            <li key={s}>
              <button
                type="button"
                role="option"
                aria-selected="false"
                onMouseDown={() => {
                  skipClose.current = true
                }}
                onClick={() => {
                  commit(s)
                  inputRef.current?.focus()
                }}
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
