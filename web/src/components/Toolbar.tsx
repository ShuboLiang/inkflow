import { useEffect, useRef, useState } from 'react'
import { useEditorState, type Editor } from '@tiptap/react'
import { TextSelection } from '@tiptap/pm/state'
import './Toolbar.css'

interface ToolbarProps {
  editor: Editor | null
  // 上传 .md/.html/.pdf：md/html 由外层解析插入，pdf 交给上层存附件
  onUpload?: (files: File[]) => void
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
}

interface MathDraft {
  kind: 'inlineMath' | 'blockMath'
  latex: string
  from: number
  to: number
}

export function Toolbar({ editor, onUpload }: ToolbarProps) {
  if (!editor) return null
  return <ToolbarInner editor={editor} onUpload={onUpload} />
}

function ToolbarInner({ editor, onUpload }: { editor: Editor; onUpload?: (files: File[]) => void }) {
  const [mathDraft, setMathDraft] = useState<MathDraft | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

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
      }) satisfies ActiveMap,
  })

  useEffect(() => {
    if (mathDraft) inputRef.current?.focus()
  }, [mathDraft])

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

  const items: { key: keyof ActiveMap; label: string; title: string; run: () => void }[] = [
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
      label: '🔗',
      title: '链接',
      run: () => {
        if (editor.isActive('link')) {
          editor.chain().focus().unsetLink().run()
          return
        }
        const url = window.prompt('链接地址')
        if (!url) return
        editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
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
        {onUpload && (
          <>
            <button
              type="button"
              className="fmt-btn"
              title="上传 md/html 导入为内容"
              aria-label="上传文件"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => fileInputRef.current?.click()}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 19V5M5 12l7-7 7 7" />
                <path d="M4 21h16" />
              </svg>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              hidden
              multiple
              accept=".md,.markdown,.html,.htm"
              onChange={(e) => {
                const files = e.target.files ? Array.from(e.target.files) : []
                e.target.value = ''
                if (files.length) onUpload(files)
              }}
            />
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
    </div>
  )
}

