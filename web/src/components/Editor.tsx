import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Typography from '@tiptap/extension-typography'
import Placeholder from '@tiptap/extension-placeholder'
import { InlineMath, BlockMath } from '@tiptap/extension-mathematics'
import { InputRule } from '@tiptap/core'
import 'katex/dist/katex.min.css'
import { useEffect, useRef } from 'react'
import { Toolbar } from './Toolbar'
import './Editor.css'

// 官方扩展 3.31.3 的 input rule 有误（行内规则匹配的是 $$…$$，块级要求 $$$…$$$），
// 这里用 extend 覆盖为常见的 $…$ 行内、$$…$$ 块级语法。
// 同时支持全角美元符号 ＄（U+FF04，中文输入法常见输出），公式内容统一按标准 LaTeX 存储。
const InlineMathRule = InlineMath.extend({
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
  addInputRules() {
    return [
      new InputRule({
        find: /(?<![$＄])[$＄]{2}([^$＄\n]+?)[$＄]{2}(?![$＄])$/,
        handler: ({ state, range, match }) => {
          const latex = match[1]
          if (!latex) return
          state.tr.replaceWith(range.from, range.to, this.type.create({ latex }))
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
      lastEmitted.current = JSON.stringify(e.getJSON())
      unsaved.current = true
      onUpdate(e.getJSON())
    },
  })

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
    <div className="editor-shell">
      <Toolbar editor={editor} />
      <div className="editor-body">
        <EditorContent editor={editor} />
      </div>
    </div>
  )
}

