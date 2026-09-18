import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Typography from '@tiptap/extension-typography'
import Placeholder from '@tiptap/extension-placeholder'
import { InlineMath, BlockMath } from '@tiptap/extension-mathematics'
import { InputRule } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import 'katex/dist/katex.min.css'
import { useEffect, useRef } from 'react'
import { Toolbar } from './Toolbar'
import './Editor.css'

// 官方扩展 3.31.3 的 input rule 有误（行内规则匹配的是 $$…$$，块级要求 $$$…$$$），
// 这里用 extend 覆盖为常见的 $…$ 行内、$$…$$ 块级语法。
// 同时支持全角美元符号 ＄（U+FF04，中文输入法常见输出），公式内容统一按标准 LaTeX 存储。
const InlineMathRule = InlineMath.extend({
  // 禁用拖放：公式只能选中，不能拖拽换位（用户拖放 atom 节点疑似导致卡死，
  // 用剪切粘贴代替）。PM 的 dnd 路径由 node.type.spec.draggable 控制。
  draggable: false,
  addInputRules() {
    return [
      new InputRule({
        find: /(?<![$＄])[$＄]([^$＄\n]+?)[$＄](?![$＄])$/,
        handler: ({ state, range, match }) => {
          const latex = match[1]
          if (!latex) return
          state.tr.replaceWith(range.from, range.to, this.type.create({ latex }))
        },
      }),
    ]
  },
}).configure({ katexOptions: { throwOnError: false } })

const BlockMathRule = BlockMath.extend({
  draggable: false,
  addInputRules() {
    return [
      // 单行：$$…$$
      new InputRule({
        find: /(?<![$＄])[$＄]{2}([^$＄\n]+?)[$＄]{2}(?![$＄])$/,
        handler: ({ state, range, match }) => {
          const latex = match[1]
          if (!latex) return
          state.tr.replaceWith(range.from, range.to, this.type.create({ latex }))
        },
      }),
      // 多行：$$ 独占一行 \n 内容 \n $$ 独占一行（input rule 只能匹配当前文本块，
      // 闭合时向前找最近的独立 $$ 段落，中间段落拼成 latex）
      new InputRule({
        find: /^[$＄]{2}$/,
        handler: ({ state, range }) => {
          const $from = state.doc.resolve(range.from)
          if ($from.depth !== 1) return // 只处理顶层段落
          const doc = state.doc
          const curIndex = $from.index(0)
          let openIndex = -1
          let openPos = -1
          let pos = 0
          for (let i = 0; i < curIndex; i++) {
            const child = doc.child(i)
            if (child.type.name === 'paragraph' && /^[$＄]{2}$/.test(child.textContent.trim())) {
              openIndex = i
              openPos = pos
            }
            pos += child.nodeSize
          }
          if (openIndex < 0) return
          const latexLines: string[] = []
          for (let i = openIndex + 1; i < curIndex; i++) {
            latexLines.push(doc.child(i).textContent)
          }
          const latex = latexLines.join('\n').trim()
          if (!latex) return
          const endPos = $from.after(1) // 当前 $$ 段落结束
          const node = this.type.create({ latex })
          const tr = state.tr.replaceWith(openPos, endPos, node)
          tr.setSelection(
            TextSelection.near(tr.doc.resolve(Math.min(openPos + node.nodeSize, tr.doc.content.size)), 1),
          )
        },
      }),
    ]
  },
}).configure({ katexOptions: { throwOnError: false, displayMode: true } })

interface EditorProps {
  content: unknown
  onUpdate: (content: unknown) => void
}

export function Editor({ content, onUpdate }: EditorProps) {
  // 记录编辑器最近一次发出的内容：prop 落后于它说明有未保存的本地输入（防抖未落盘），
  // 此时绝不能用旧 prop setContent 回滚（打开浮层/切换焦点导致 blur 时会触发）。
  const lastEmitted = useRef<string | null>(null)
  const unsaved = useRef(false)

  const editor = useEditor({
    extensions: [
      StarterKit,
      // Typography 里与 LaTeX 语法冲突的规则全部禁用：^2 ^3（上下标）、1/2 1/4 3/4（分数）、
      // +- != 2x3 << >> -> <-（数学常用符号序列）。保留 --、...、引号、版权符号等散文排版规则。
      Typography.configure({
        superscriptTwo: false,
        superscriptThree: false,
        oneHalf: false,
        oneQuarter: false,
        threeQuarters: false,
        plusMinus: false,
        notEqual: false,
        multiplication: false,
        laquo: false,
        raquo: false,
        leftArrow: false,
        rightArrow: false,
      }),
      Placeholder.configure({ placeholder: '开始书写…' }),
      InlineMathRule,
      BlockMathRule,
    ],
    content: content as object | undefined,
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

  // 点击编辑区空白（内容下方、行左侧）时聚焦并定位光标到最近合理位置。
  // 注意不用 chain().focus()：它把 DOM 聚焦推迟到下一帧，期间按键会丢；
  // 这里先同步 view.focus()，再写入选区。纯公式文档没有合法文本位置，
  // setTextSelection 可能抛错，兜底用 Selection.atEnd（允许 NodeSelection）。
  // 只在"真正点击"时干预：mousedown 与 mouseup 位移 >5px 视为拖拽，不动选区。
  const downPos = useRef<{ x: number; y: number } | null>(null)
  const handleShellMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    downPos.current = { x: e.clientX, y: e.clientY }
  }
  const handleShellClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!editor) return
    const target = e.target as HTMLElement
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
      const next = JSON.stringify(content ?? {})
      if (next === lastEmitted.current) {
        unsaved.current = false
        return
      }
      if (unsaved.current) return
      const current = JSON.stringify(editor.getJSON())
      if (current !== next && !editor.isFocused) {
        editor.commands.setContent(content as object)
      }
    }
    apply()
    editor.on('blur', apply)
    return () => {
      editor.off('blur', apply)
    }
  }, [editor, content])

  return (
    <div className="editor-shell" onMouseDown={handleShellMouseDown} onClick={handleShellClick}>
      <Toolbar editor={editor} />
      <div className="editor-body">
        <EditorContent editor={editor} />
      </div>
    </div>
  )
}


