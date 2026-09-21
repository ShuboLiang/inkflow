import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Link2,
  CheckSquare,
  Highlighter,
  Table as TableIcon,
  Heading,
} from 'lucide-react'
import { useEditorState, type Editor } from '@tiptap/react'
import { TextSelection } from '@tiptap/pm/state'
import { promptDialog } from '../lib/dialog'
import './Toolbar.css'

interface ToolbarProps {
  editor: Editor | null
}

interface ActiveMap {
  h1: boolean
  h2: boolean
  h3: boolean
  bold: boolean
  italic: boolean
  strike: boolean
  code: boolean
  codeBlock: boolean
  blockquote: boolean
  bulletList: boolean
  orderedList: boolean
  link: boolean
  inlineMath: boolean
  blockMath: boolean
  table: boolean
  taskList: boolean
  highlight: boolean
}

interface MathDraft {
  kind: 'inlineMath' | 'blockMath'
  latex: string
  from: number
  to: number
}

// 文字颜色 / 荧光笔色板（与应用整体色调协调的常用色）
const TEXT_COLORS = [
  { label: '默认', value: null },
  { label: '红', value: '#c92a2a' },
  { label: '橙', value: '#d9480f' },
  { label: '绿', value: '#2b8a3e' },
  { label: '青', value: '#1f6f6b' },
  { label: '蓝', value: '#1971c2' },
  { label: '紫', value: '#862e9c' },
  { label: '灰', value: '#495057' },
]

const MARK_COLORS = [
  { label: '无', value: null },
  { label: '黄', value: '#fff3bf' },
  { label: '红', value: '#ffe3e3' },
  { label: '橙', value: '#ffe8cc' },
  { label: '绿', value: '#d3f9d8' },
  { label: '青', value: '#c5f6fa' },
  { label: '蓝', value: '#dbe4ff' },
  { label: '紫', value: '#f3d9fa' },
]

export function Toolbar({ editor }: ToolbarProps) {
  if (!editor) return null
  return <ToolbarInner editor={editor} />
}

function ToolbarInner({ editor }: { editor: Editor }) {
  const [mathDraft, setMathDraft] = useState<MathDraft | null>(null)
  const [tablePick, setTablePick] = useState(false)
  // 表格插入网格的悬停规格（行,列），点选后 insertTable
  const [tableSize, setTableSize] = useState({ rows: 2, cols: 2 })
  const [colorPick, setColorPick] = useState(false)
  const [markPick, setMarkPick] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const active = useEditorState<ActiveMap>({
    editor,
    selector: (ctx) =>
      ({
        h1: ctx.editor.isActive('heading', { level: 1 }),
        h2: ctx.editor.isActive('heading', { level: 2 }),
        h3: ctx.editor.isActive('heading', { level: 3 }),
        bold: ctx.editor.isActive('bold'),
        italic: ctx.editor.isActive('italic'),
        strike: ctx.editor.isActive('strike'),
        code: ctx.editor.isActive('code'),
        codeBlock: ctx.editor.isActive('codeBlock'),
        blockquote: ctx.editor.isActive('blockquote'),
        bulletList: ctx.editor.isActive('bulletList'),
        orderedList: ctx.editor.isActive('orderedList'),
        link: ctx.editor.isActive('link'),
        inlineMath: ctx.editor.isActive('inlineMath'),
        blockMath: ctx.editor.isActive('blockMath'),
        table: ctx.editor.isActive('table'),
        taskList: ctx.editor.isActive('taskList'),
        highlight: ctx.editor.isActive('highlight'),
      }) satisfies ActiveMap,
  })

  useEffect(() => {
    if (mathDraft) inputRef.current?.focus()
  }, [mathDraft])

  // 点击已有公式：打开预填现有 LaTeX 的编辑浮层，确认后原地替换节点
  useEffect(() => {
    const onEditMath = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        kind: MathDraft['kind']
        latex: string
        from: number
        to: number
      }
      setMathDraft(detail)
    }
    window.addEventListener('inkflow:edit-math', onEditMath)
    return () => window.removeEventListener('inkflow:edit-math', onEditMath)
  }, [])

  if (!active) return null

  // 打开公式浮层时记录当前选区：选中文本作为初始 LaTeX，插入时替换选区
  const openMath = (kind: MathDraft['kind']) => {
    const { from, to } = editor.state.selection
    const selected = editor.state.doc.textBetween(from, to, ' ')
    setMathDraft({ kind, latex: selected, from, to })
  }

  const confirmMath = () => {
    if (!mathDraft) return
    const { kind, latex, from, to } = mathDraft
    setMathDraft(null)
    if (!latex.trim()) return
    const chain = editor.chain().focus().deleteRange({ from, to })
    if (kind === 'inlineMath') {
      chain.insertInlineMath({ latex, pos: from }).run()
    } else {
      chain.insertBlockMath({ latex, pos: from }).run()
      // Editor 的 onUpdate 已在微任务里补了尾部空段落；此处兜底并把光标落到文末。
      // 同步 view.focus()，避免 TipTap focus 命令的 rAF 延迟吃掉紧跟的按键。
      queueMicrotask(() => {
        if (editor.isDestroyed) return
        if (editor.state.doc.lastChild?.type.name === 'blockMath') {
          editor.chain().insertContentAt(editor.state.doc.content.size, { type: 'paragraph' }).run()
        }
        editor.view.focus()
        editor.chain().command(({ tr, dispatch }) => {
          if (dispatch) tr.setSelection(TextSelection.atEnd(tr.doc))
          return true
        }).run()
      })
    }
  }

  const cancelMath = () => {
    setMathDraft(null)
    editor.commands.focus()
  }

  const items: { key: keyof ActiveMap; label: ReactNode; title: string; run: () => void }[] = [
    { key: 'h1', label: 'H1', title: '标题 1', run: () => editor.chain().focus().toggleHeading({ level: 1 }).run() },
    { key: 'h2', label: 'H2', title: '标题 2', run: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { key: 'h3', label: 'H3', title: '标题 3', run: () => editor.chain().focus().toggleHeading({ level: 3 }).run() },
    { key: 'bold', label: 'B', title: '粗体 Ctrl+B', run: () => editor.chain().focus().toggleBold().run() },
    { key: 'italic', label: 'I', title: '斜体 Ctrl+I', run: () => editor.chain().focus().toggleItalic().run() },
    { key: 'strike', label: 'S̶', title: '删除线 Ctrl+Shift+S', run: () => editor.chain().focus().toggleStrike().run() },
    { key: 'code', label: '<>', title: '行内代码 Ctrl+E', run: () => editor.chain().focus().toggleCode().run() },
    { key: 'codeBlock', label: '{ }', title: '代码块', run: () => editor.chain().focus().toggleCodeBlock().run() },
    { key: 'blockquote', label: '❝', title: '引用', run: () => editor.chain().focus().toggleBlockquote().run() },
    { key: 'bulletList', label: '•≡', title: '无序列表', run: () => editor.chain().focus().toggleBulletList().run() },
    { key: 'orderedList', label: '1≡', title: '有序列表', run: () => editor.chain().focus().toggleOrderedList().run() },
    { key: 'inlineMath', label: 'Σ', title: '行内公式（也可用 $…$ 输入）', run: () => openMath('inlineMath') },
    { key: 'blockMath', label: '∫', title: '块级公式（也可用 $$…$$ 输入）', run: () => openMath('blockMath') },
    {
      key: 'link',
      label: <Link2 size={13} />,
      title: '链接',
      run: () => {
        if (editor.isActive('link')) {
          editor.chain().focus().unsetLink().run()
          return
        }
        void (async () => {
          const url = await promptDialog({
            title: '插入链接',
            message: '链接地址',
            input: { placeholder: 'https://…' },
          })
          if (!url) return
          editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
        })()
      },
    },
  ]

  return (
    <div className="fmt-wrap">
      <div className="fmt-toolbar" role="toolbar" aria-label="格式工具栏">
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            className={active[item.key] ? 'fmt-btn active' : 'fmt-btn'}
            title={item.title}
            aria-pressed={active[item.key]}
            onMouseDown={(e) => e.preventDefault()}
            onClick={item.run}
          >
            {item.label}
          </button>
        ))}
        <button
          type="button"
          className={active.taskList ? 'fmt-btn active' : 'fmt-btn'}
          title="待办清单"
          aria-label="待办清单"
          aria-pressed={active.taskList}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleTaskList().run()}
        >
          <CheckSquare size={13} />
        </button>
        <button
          type="button"
          className={colorPick ? 'fmt-btn active' : 'fmt-btn'}
          title="文字颜色"
          aria-label="文字颜色"
          aria-pressed={colorPick}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setColorPick((v) => !v)
            setMarkPick(false)
            setTablePick(false)
          }}
        >
          A<span className="fmt-color-bar" />
        </button>
        <button
          type="button"
          className={active.highlight ? 'fmt-btn active' : 'fmt-btn'}
          title="荧光笔高亮"
          aria-label="荧光笔高亮"
          aria-pressed={active.highlight}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setMarkPick((v) => !v)
            setColorPick(false)
            setTablePick(false)
          }}
        >
          <Highlighter size={13} />
        </button>
        <button
          type="button"
          className={active.table ? 'fmt-btn active' : 'fmt-btn'}
          title="插入表格"
          aria-label="插入表格"
          aria-pressed={active.table}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setTablePick((v) => !v)
            setColorPick(false)
            setMarkPick(false)
          }}
        >
          <TableIcon size={13} />
        </button>
        {active.table && (
          <>
            <button type="button" className="fmt-btn" title="下方插入行" onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().addRowAfter().run()}>＋行</button>
            <button type="button" className="fmt-btn" title="删除当前行" onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().deleteRow().run()}>－行</button>
            <button type="button" className="fmt-btn" title="右侧插入列" onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().addColumnAfter().run()}>＋列</button>
            <button type="button" className="fmt-btn" title="删除当前列" onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().deleteColumn().run()}>－列</button>
            <button type="button" className="fmt-btn" title="切换表头单元格" onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleHeaderCell().run()}><Heading size={13} /></button>
            <button type="button" className="fmt-btn" title="删除表格" onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().deleteTable().run()}>删表</button>
          </>
        )}
      </div>
      {mathDraft && (
        <div className="math-popover" role="dialog" aria-label="插入公式">
          <input
            ref={inputRef}
            className="math-popover-input"
            value={mathDraft.latex}
            placeholder={mathDraft.kind === 'inlineMath' ? '行内公式 LaTeX，如 x^2' : '块级公式 LaTeX，如 \\int_0^1 x^2 dx'}
            aria-label="LaTeX 公式"
            onChange={(e) => setMathDraft({ ...mathDraft, latex: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                confirmMath()
              } else if (e.key === 'Escape') {
                cancelMath()
              }
            }}
          />
          <button type="button" className="math-popover-ok" onClick={confirmMath}>
            确定
          </button>
          <button type="button" className="math-popover-cancel" onClick={cancelMath}>
            取消
          </button>
        </div>
      )}
      {colorPick && (
        <div className="palette-popover" role="dialog" aria-label="文字颜色">
          {TEXT_COLORS.map((c) => (
            <button
              key={c.label}
              type="button"
              className="palette-swatch"
              style={c.value ? { background: c.value } : undefined}
              title={c.label}
              aria-label={`文字颜色 ${c.label}`}
              onClick={() => {
                setColorPick(false)
                const chain = editor.chain().focus()
                if (c.value) chain.setColor(c.value).run()
                else chain.unsetColor().run()
              }}
            >
              {c.value ? '' : '⌀'}
            </button>
          ))}
        </div>
      )}
      {markPick && (
        <div className="palette-popover" role="dialog" aria-label="荧光笔高亮">
          {MARK_COLORS.map((c) => (
            <button
              key={c.label}
              type="button"
              className="palette-swatch"
              style={c.value ? { background: c.value } : undefined}
              title={c.label}
              aria-label={`高亮 ${c.label}`}
              onClick={() => {
                setMarkPick(false)
                const chain = editor.chain().focus()
                if (c.value) chain.setHighlight({ color: c.value }).run()
                else chain.unsetHighlight().run()
              }}
            >
              {c.value ? '' : '⌀'}
            </button>
          ))}
        </div>
      )}
      {tablePick && (
        <div className="table-popover" role="dialog" aria-label="插入表格">
          <div className="table-popover-grid">
            {Array.from({ length: 36 }, (_, i) => {
              const row = Math.floor(i / 6) + 1
              const col = (i % 6) + 1
              return (
                <button
                  key={i}
                  type="button"
                  className={row <= tableSize.rows && col <= tableSize.cols ? 'table-cell on' : 'table-cell'}
                  aria-label={`${row} 行 ${col} 列`}
                  onMouseEnter={() => setTableSize({ rows: row, cols: col })}
                  onClick={() => {
                    setTablePick(false)
                    editor.chain().focus().insertTable({ rows: row, cols: col, withHeaderRow: true }).run()
                  }}
                />
              )
            })}
          </div>
          <div className="table-popover-label">{tableSize.rows} × {tableSize.cols}</div>
        </div>
      )}
    </div>
  )
}

