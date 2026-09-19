import StarterKit from '@tiptap/starter-kit'
import Typography from '@tiptap/extension-typography'
import Placeholder from '@tiptap/extension-placeholder'
import { InlineMath, BlockMath } from '@tiptap/extension-mathematics'
import Image from '@tiptap/extension-image'
import { InputRule, type Extensions } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import { cacheImageFromUrl, cachedImageDataUrl, imagePathFromUrl } from '../store/images'
import { openImageLightbox } from './lightbox'

// 图片节点：src 是 Storage 公共桶 URL。在线直接加载；加载失败（离线/未传完）
// 回退到 Dexie 本地缓存并周期性重试原 URL，恢复后自动切回；加载成功则顺手缓存备离线。
const ResolvedImage = Image.extend({
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('img')
      let current = node.attrs.src as string
      dom.src = current
      let retryTimer: ReturnType<typeof setTimeout> | null = null
      let retries = 0

      // 原 URL 暂时不可用（未上传完成/断网）时，稍后重试，最多 3 次
      const scheduleRetry = () => {
        if (retries >= 3 || !imagePathFromUrl(current)) return
        retries++
        retryTimer = setTimeout(() => {
          retryTimer = null
          if (dom.isConnected) dom.src = current
        }, 20000)
      }

      // 单击选中图片（ProseMirror 默认行为，便于删除/剪切）；双击看大图
      dom.addEventListener('dblclick', () => openImageLightbox(dom.src))
      dom.setAttribute('title', '双击看大图')
      dom.addEventListener('error', () => {
        if (dom.dataset.fallback === '1') return // 回退图本身出错不再处理
        const path = imagePathFromUrl(current)
        if (!path) return
        void cachedImageDataUrl(path).then((dataUrl) => {
          if (!dom.isConnected) return
          if (dataUrl) {
            dom.dataset.fallback = '1'
            dom.src = dataUrl
          }
          scheduleRetry()
        })
      })
      dom.addEventListener('load', () => {
        if (dom.dataset.fallback === '1' && dom.src === current) {
          // 重试后原 URL 恢复可用，结束回退
          delete dom.dataset.fallback
        } else if (!dom.dataset.fallback) {
          void cacheImageFromUrl(current)
        }
      })
      return {
        dom,
        update(updated) {
          if (updated.attrs.src !== current) {
            current = updated.attrs.src as string
            if (retryTimer) clearTimeout(retryTimer)
            retries = 0
            delete dom.dataset.fallback
            dom.src = current
          }
          return true
        },
        destroy() {
          if (retryTimer) clearTimeout(retryTimer)
        },
      }
    }
  },
})

// 点击已有公式 → 广播编辑事件（携带节点区间与现有 LaTeX），
// 由 Toolbar 的公式浮层接管：预填内容、确认后原地替换。事件挂在 window 上，
// 因为 onClick 回调拿不到 React 里的编辑器实例，用事件解耦。
function mathEditHandler(kind: 'inlineMath' | 'blockMath') {
  return (node: PMNode, pos: number) => {
    window.dispatchEvent(
      new CustomEvent('inkflow:edit-math', {
        detail: { kind, latex: node.attrs.latex as string, from: pos, to: pos + node.nodeSize },
      }),
    )
  }
}

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
}).configure({ katexOptions: { throwOnError: false }, onClick: mathEditHandler('inlineMath') })

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
}).configure({ katexOptions: { throwOnError: false, displayMode: true }, onClick: mathEditHandler('blockMath') })

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
    // 图片以 Storage 公共 URL 存储（ResolvedImage 的 NodeView 负责离线回退与缓存），
    // 仍保留 allowBase64 以兼容迁移前的 data URL 内容
    ResolvedImage.configure({ allowBase64: true, inline: false }),
  ]
}
