import { useEffect, useRef, useState } from 'react'
import { TagInput } from './TagInput'
import './TagPicker.css'

// 工具栏上的标签入口：默认只是个按钮（带数量角标），点开弹出编辑面板。
// 不再占用正文区域一整行；点外部 / Esc 关闭。
export function TagPicker({
  tags,
  suggestions,
  onChange,
}: {
  tags: string[]
  suggestions: string[]
  onChange: (tags: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('touchstart', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('touchstart', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="tag-picker" ref={ref}>
      <button
        type="button"
        className={open || tags.length > 0 ? 'tool-btn tag-picker-btn on' : 'tool-btn tag-picker-btn'}
        title="设置标签"
        aria-label="设置标签"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 2H2v10l9.3 9.3a1.7 1.7 0 0 0 2.4 0l7.6-7.6a1.7 1.7 0 0 0 0-2.4Z" />
          <circle cx="7" cy="7" r="1.2" fill="currentColor" stroke="none" />
        </svg>
        {tags.length > 0 ? tags.length : ''}
      </button>
      {open && (
        <div className="tag-picker-pop" role="dialog" aria-label="设置标签">
          <TagInput
            tags={tags}
            suggestions={suggestions}
            onChange={onChange}
            onClose={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  )
}
