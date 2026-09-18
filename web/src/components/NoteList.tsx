import type { Note } from '../lib/db'
import { firstLine } from '../lib/wordCount'
import './NoteList.css'

interface NoteListProps {
  notes: Note[]
  activeId: string | null
  search: string
  onSearch: (value: string) => void
  onSelect: (id: string) => void
  onCreate: () => void
}

interface TipTapNode {
  type?: string
  text?: string
  content?: TipTapNode[]
}

function excerptOf(content: unknown): string {
  const paragraphs: string[] = []
  const textOf = (node: TipTapNode): string => {
    if (node.type === 'text') return node.text ?? ''
    if (node.type === 'inlineMath' || node.type === 'blockMath') return '[公式]'
    return (node.content ?? []).map(textOf).join('')
  }
  const root = content as TipTapNode | null
  for (const child of root?.content ?? []) {
    if (paragraphs.length >= 2) break
    const text = textOf(child).trim()
    if (text) paragraphs.push(text)
  }
  return paragraphs.join(' ') || '无内容'
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function NoteList({ notes, activeId, search, onSearch, onSelect, onCreate }: NoteListProps) {
  return (
    <section className="note-list" aria-label="笔记列表">
      <div className="note-list-search">
        <input
          type="search"
          placeholder="搜索笔记"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          aria-label="搜索笔记"
        />
      </div>
      <div className="note-list-items">
        {notes.map((note) => (
          <button
            key={note.id}
            type="button"
            className={note.id === activeId ? 'note-card active' : 'note-card'}
            onClick={() => onSelect(note.id)}
          >
            <div className="note-card-title">{note.title || firstLine(note.content) || '无标题'}</div>
            <div className="note-card-excerpt">{excerptOf(note.content)}</div>
            <div className="note-card-time">{formatTime(note.updatedAt)}</div>
          </button>
        ))}
      </div>
      <div className="note-list-footer">
        <button type="button" className="note-list-new" onClick={onCreate}>
          新建笔记
        </button>
      </div>
    </section>
  )
}
