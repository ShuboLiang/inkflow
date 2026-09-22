import { useEditor, EditorContent, useEditorState, type Editor as TipTapEditor } from '@tiptap/react'
import { TextSelection } from '@tiptap/pm/state'
import { marked } from 'marked'
import 'katex/dist/katex.min.css'
import { useEffect, useRef, useState } from 'react'
import { ListTree, X } from 'lucide-react'
import { Toolbar } from './Toolbar'
import { insertPastedImages, pastedImageFiles } from '../lib/pasteImage'
import { buildExtensions } from '../lib/editorExtensions'
import './Editor.css'

interface EditorProps {
  content: unknown
  onUpdate: (content: unknown) => void
  // 格式栏隐藏（全局偏好由 App 持有并持久化到云端）
  toolbarHidden?: boolean
  readOnly?: boolean
}

// 规范化外部内容：新建笔记和数据库默认值存的是 {}，不是合法 TipTap 文档
// （缺 type: 'doc'，setContent 会抛 "Unknown node type: undefined"），统一兜底为空文档
function toDoc(content: unknown): object {
  const c = content as { type?: string } | null | undefined
  if (c && typeof c === 'object' && c.type === 'doc') return c as object
  return { type: 'doc', content: [] }
}

export function Editor({ content, onUpdate, toolbarHidden, readOnly = false }: EditorProps) {
  // 记录编辑器最近一次发出的内容：prop 落后于它说明有未保存的本地输入（防抖未落盘），
  // 此时绝不能用旧 prop setContent 回滚（打开浮层/切换焦点导致 blur 时会触发）。
  const lastEmitted = useRef<string | null>(null)
  const unsaved = useRef(false)
  // handlePaste 配置先于 useEditor 创建执行，粘贴时通过 ref 拿到实例
  const editorRef = useRef<TipTapEditor | null>(null)

  // 剪贴板纯文本是否像 GFM 表格：≥2 行含 |，且有一行是 --- 分隔行（无 HTML 时才转换）
  const isMdTable = (text: string) => {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    if (lines.length < 2) return false
    const rows = lines.filter((l) => l.includes('|'))
    const sep = lines.some((l) => l.includes('-') && /^\|?[\s\-:|]+\|?$/.test(l))
    return sep && rows.length >= 2
  }

  const editor = useEditor({
    extensions: buildExtensions(),
    editable: !readOnly,
    editorProps: {
      // 拦截图片粘贴：clipboard 里的文件走自己的插入逻辑（压缩 + data URL），
      // 不拦截的粘贴（纯文本/HTML）继续走 ProseMirror 默认路径
      handlePaste: (view, event) => {
        const images = pastedImageFiles(event)
        if (!images.length) {
          const text = event.clipboardData?.getData('text/plain') ?? ''
          const hasHtml = !!event.clipboardData?.getData('text/html')
          if (text && !hasHtml && isMdTable(text)) {
            const html = marked.parse(text, { async: false }) as string
            if (html.includes('<table')) {
              event.preventDefault()
              editorRef.current?.chain().focus().insertContent(html).run()
              return true
            }
          }
          return false
        }
        event.preventDefault()
        void insertPastedImages(view, images)
        return true
      },
    },
    content: toDoc(content),
    onUpdate: ({ editor: e }) => {
      // 清理空 latex 的公式节点：不可见但占据文档位置，会让选区坐标映射错位
      let emptyPos: number | null = null
      e.state.doc.descendants((node, pos) => {
        if (
          (node.type.name === 'inlineMath' || node.type.name === 'blockMath') &&
          !(node.attrs.latex as string | undefined)?.trim()
        ) {
          emptyPos = pos
          return false
        }
        return true
      })
      if (emptyPos !== null) {
        const p = emptyPos
        queueMicrotask(() => {
          try {
            if (e.isDestroyed) return
            const node = e.state.doc.nodeAt(p)
            if (node && (node.type.name === 'inlineMath' || node.type.name === 'blockMath')) {
              e.chain().deleteRange({ from: p, to: p + node.nodeSize }).run()
            }
          } catch (err) {
            console.error('remove empty math node failed', err)
          }
        })
      }
      // 文档以块级节点（公式/代码块）结尾时，自动补一个空段落作为落脚点
      const last = e.state.doc.lastChild
      if (last && (last.type.name === 'blockMath' || last.type.name === 'codeBlock')) {
        queueMicrotask(() => {
          // 微任务执行时文档可能又变了（拖拽/同步），位置和类型都要重新取
          try {
            if (e.isDestroyed) return
            const cur = e.state.doc.lastChild
            if (cur && (cur.type.name === 'blockMath' || cur.type.name === 'codeBlock')) {
              e.chain().insertContentAt(e.state.doc.content.size, { type: 'paragraph' }).run()
            }
          } catch (err) {
            console.error('append trailing paragraph failed', err)
          }
        })
      }
      lastEmitted.current = JSON.stringify(e.getJSON())
      unsaved.current = true
      onUpdate(e.getJSON())
    },
  })

  useEffect(() => {
    editorRef.current = editor
    return () => {
      editorRef.current = null
    }
  }, [editor])

  // 动态同步编辑 / 阅读模式
  useEffect(() => {
    if (!editor) return
    editor.setEditable(!readOnly)
  }, [editor, readOnly])

  // 代码块复制按钮由 editorExtensions 的 widget decoration 渲染（见 CodeBlockWithCopy）；
  // 按钮点击通过事件冒泡到 handleShellClick 的 .code-copy-btn 分支处理。

  const [outlineOpen, setOutlineOpen] = useState(false)

  // 文档大纲：每次变更后重取标题列表（带位置，点击跳转）
  const headings = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const out: { level: number; text: string; pos: number }[] = []
      e.state.doc.descendants((node, pos) => {
        if (node.type.name === 'heading') {
          out.push({ level: node.attrs.level as number, text: node.textContent, pos })
        }
      })
      return out
    },
  })

  // 点击编辑区空白（内容下方、行左侧）时聚焦并定位光标到最近合理位置。
  // 注意不用 chain().focus()：它把 DOM 聚焦推迟到下一帧，期间按键会丢；
  // 这里先同步 view.focus()，再写入选区。纯公式文档没有合法文本位置，
  // setTextSelection 可能抛错，兜底用 Selection.atEnd（允许 NodeSelection）。
  // 只在"真正点击"时干预：mousedown 与 mouseup 位移 >5px 视为拖拽，不动选区。
  const downPos = useRef<{ x: number; y: number } | null>(null)
  const handleShellMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (readOnly) return
    downPos.current = { x: e.clientX, y: e.clientY }
  }
  const handleShellClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement

    // 代码块一键复制按钮（编辑模式与阅读模式通用）
    const copyBtn = target.closest<HTMLButtonElement>('.code-copy-btn')
    if (copyBtn) {
      e.preventDefault()
      e.stopPropagation()
      const pre = copyBtn.closest('pre')
      if (pre) {
        const code = pre.querySelector('code')
        const text = code ? code.innerText : pre.innerText
        const copySuccess = () => {
          copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg><span>已复制</span>`
          copyBtn.classList.add('copied')
          setTimeout(() => {
            if (copyBtn.isConnected) {
              copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg><span>复制</span>`
              copyBtn.classList.remove('copied')
            }
          }, 2000)
        }

        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(text).then(copySuccess).catch(() => {
            try {
              const ta = document.createElement('textarea')
              ta.value = text
              ta.style.position = 'fixed'
              ta.style.opacity = '0'
              document.body.appendChild(ta)
              ta.select()
              document.execCommand('copy')
              document.body.removeChild(ta)
              copySuccess()
            } catch (err) {
              console.error('Copy failed', err)
            }
          })
        } else {
          try {
            const ta = document.createElement('textarea')
            ta.value = text
            ta.style.position = 'fixed'
            ta.style.opacity = '0'
            document.body.appendChild(ta)
            ta.select()
            document.execCommand('copy')
            document.body.removeChild(ta)
            copySuccess()
          } catch (err) {
            console.error('Copy failed', err)
          }
        }
      }
      return
    }

    // 阅读模式下：点击超链接直接在新标签页打开
    if (readOnly) {
      const link = target.closest<HTMLAnchorElement>('a')
      if (link && link.href) {
        e.preventDefault()
        e.stopPropagation()
        window.open(link.href, '_blank', 'noopener,noreferrer')
      }
      return
    }

    if (!editor) return
    if (target.closest('.fmt-wrap') || target.closest('button') || target.closest('input')) return
    if (target.closest('.ProseMirror')) return // ProseMirror 自己处理内容区点击
    const down = downPos.current
    downPos.current = null
    if (down && (Math.abs(e.clientX - down.x) > 5 || Math.abs(e.clientY - down.y) > 5)) return
    e.preventDefault()
    // 坐标钳制到 ProseMirror 内容盒内，行左侧/下边缘外也能定位到最近文本位置
    const rect = editor.view.dom.getBoundingClientRect()
    const left = Math.min(Math.max(e.clientX, rect.left + 1), rect.right - 1)
    const top = Math.min(Math.max(e.clientY, rect.top + 1), rect.bottom - 1)
    editor.view.focus()
    try {
      const pos = editor.view.posAtCoords({ left, top })
      if (pos) {
        editor.commands.setTextSelection(pos.pos)
        return
      }
    } catch {
      // 纯块级节点文档没有文本位置，落到文末选区
    }
    editor.chain().command(({ tr, dispatch }) => {
      if (dispatch) tr.setSelection(TextSelection.atEnd(tr.doc))
      return true
    }).run()
  }

  // 外部内容变化（同步覆盖）时更新编辑器。编辑器聚焦（正在输入/IME 组合中）或
  // 存在未保存的本地输入时不覆盖，避免打字被回滚、光标跳动和输入法中断。
  useEffect(() => {
    if (!editor) return
    const apply = () => {
      const next = JSON.stringify(toDoc(content))
      if (next === lastEmitted.current) {
        unsaved.current = false
        return
      }
      if (unsaved.current) return
      const current = JSON.stringify(editor.getJSON())
      if (current !== next && !editor.isFocused) {
        // emitUpdate:false：setContent 默认会触发 onUpdate，旧 JSON 与 schema
        // round-trip 不完全一致的笔记每次打开都会被"重写"一遍——版本、updatedAt
        // 被无意义刷新，列表按更新时间排时笔记点开就跳到最前
        editor.commands.setContent(toDoc(content), { emitUpdate: false })
      }
    }
    apply()
    editor.on('blur', apply)
    return () => {
      editor.off('blur', apply)
    }
  }, [editor, content])

  return (
    <>
      {toolbarHidden || readOnly ? null : <Toolbar editor={editor} />}
      <div
        className={`editor-shell ${readOnly ? 'editor-reading-mode' : ''}`}
        onMouseDown={handleShellMouseDown}
        onClick={handleShellClick}
      >
        <div className="editor-body">
          <EditorContent editor={editor} />
        </div>
      </div>
      <button
        type="button"
        className={outlineOpen ? 'outline-toggle active' : 'outline-toggle'}
        title="文档大纲"
        aria-label="文档大纲"
        aria-pressed={outlineOpen}
        onClick={() => setOutlineOpen((v) => !v)}
      >
        <ListTree size={18} />
      </button>
      {outlineOpen && (
        <nav className="outline-panel" aria-label="文档大纲">
          <div className="outline-head">
            <span>大纲</span>
            <button type="button" className="outline-close" aria-label="关闭大纲" onClick={() => setOutlineOpen(false)}>
              <X size={16} />
            </button>
          </div>
          {headings && headings.length > 0 ? (
            headings.map((h, i) => (
              <button
                key={`${h.pos}-${i}`}
                type="button"
                className={`outline-item lv${h.level}`}
                title={h.text}
                onClick={() => {
                  // pos 是节点起点，+1 落到标题文本内。触屏设备或阅读模式不抢焦点：
                  // focus() 会拉起输入法键盘挡住半屏。但 ProseMirror 未聚焦时
                  // 不会把选区滚动同步到 DOM，chain 的 scrollIntoView 会失效，
                  // 因此改用 domAtPos 拿到标题元素后原生滚动定位；桌面精确
                  // 指针且编辑模式下保留「滚动 + 聚焦」，跳完可立即续写
                  if (!editor) return
                  const precise = window.matchMedia('(hover: hover) and (pointer: fine)').matches
                  if (precise && !readOnly) {
                    editor.chain().focus().setTextSelection(h.pos + 1).run()
                  } else {
                    editor.commands.setTextSelection(h.pos + 1)
                  }
                  const at = editor.view.domAtPos(h.pos + 1)
                  const el = at.node.nodeType === 1 ? (at.node as Element) : at.node.parentElement
                  if (el) {
                    // 仅滚动 .editor-scroll 内部容器，绝不调用 el.scrollIntoView()。
                    // 否则浏览器会遍历滚动 html/body/window，导致移动端顶部顶栏被顶出视口且无法恢复。
                    const container = el.closest<HTMLElement>('.editor-scroll')
                    if (container) {
                      const containerRect = container.getBoundingClientRect()
                      const elRect = el.getBoundingClientRect()
                      const offset = elRect.top - containerRect.top - 16
                      container.scrollBy({ top: offset, behavior: 'smooth' })
                    }
                  }
                  setOutlineOpen(false)
                }}
              >
                {h.text || '（空标题）'}
              </button>
            ))
          ) : (
            <p className="outline-empty">暂无标题，用 H1–H3 建立结构</p>
          )}
        </nav>
      )}
    </>
  )
}


