import StarterKit from '@tiptap/starter-kit'
import Typography from '@tiptap/extension-typography'
import Placeholder from '@tiptap/extension-placeholder'
import { InlineMath, BlockMath } from '@tiptap/extension-mathematics'
import Image from '@tiptap/extension-image'
import { InputRule, type Extensions } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'

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

// 编辑器实例和文件导入管线共用同一组扩展，保证导入生成的文档和手动编辑的一致。
// Typography 里与 LaTeX 语法冲突的规则全部禁用：^2 ^3（上下标）、1/2 1/4 3/4（分数）、
// +- != 2x3 << >> -> <-（数学常用符号序列）。保留 --、...、引号、版权符号等散文排版规则。
export function buildExtensions(): Extensions {
  return [
    StarterKit,
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
    // 图片以 base64 data URL 内联存储（allowBase64），跟随笔记内容一起
    // 进 IndexedDB 与云同步，不依赖 Supabase Storage
    Image.configure({ allowBase64: true, inline: false }),
  ]
}
