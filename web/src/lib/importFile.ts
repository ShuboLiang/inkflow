import { Editor as HeadlessEditor, type Editor } from '@tiptap/core'
import { marked } from 'marked'
import { buildExtensions } from './editorExtensions'
import { alertDialog } from './dialog'

// 文件导入管线：md/html → 转成 TipTap 文档插入当前光标处。
// 转换用无头 TipTap 实例（与编辑器同一组扩展）：HTML 里 schema 不认识的标签、
// 属性（含 on* 事件）会被直接丢弃，天然起到清洗作用；script 标签不会进入文档。
// PDF 等二进制不走这里：请从侧栏「文件」上传，作为独立文件预览。

export type DocKind = 'markdown' | 'html' | 'binary'

// 按文件名判断内容类型（列表里已有的文件没有 File 对象，只有 filename/mimeType）
export function kindOfName(name: string): DocKind {
  const n = name.toLowerCase()
  if (n.endsWith('.md') || n.endsWith('.markdown')) return 'markdown'
  if (n.endsWith('.html') || n.endsWith('.htm')) return 'html'
  return 'binary'
}

export function kindOfFile(file: File): DocKind {
  if (file.type === 'text/markdown') return 'markdown'
  if (file.type === 'text/html') return 'html'
  return kindOfName(file.name)
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('read file failed'))
    reader.readAsText(file)
  })
}

// ---- 数学转换 ----
// 输入规则只在打字时触发，静态导入要自己把 $…$ / $$…$$ 转成公式节点，
// 规则与编辑器 input rule 保持一致（含全角＄；行内内容不含 $ 和换行）。

interface DocNode {
  type: string
  text?: string
  attrs?: Record<string, unknown>
  marks?: unknown[]
  content?: DocNode[]
}

function textOf(node: DocNode): string {
  if (node.text !== undefined) return node.text
  return (node.content ?? []).map(textOf).join('')
}

// 段落整段文本是 $$（多空格也认）视为公式块定界符
function isDelim(node: DocNode): boolean {
  return node.type === 'paragraph' && /^[$＄]{2}$/.test(textOf(node).trim())
}

function blockMathNode(latex: string): DocNode {
  return { type: 'blockMath', attrs: { latex } }
}

function hasCodeMark(node: DocNode): boolean {
  return (
    Array.isArray(node.marks) &&
    node.marks.some((m) => (m as { type?: string }).type === 'code')
  )
}

// 行内 $…$ 拆成 [text, inlineMath, text, …]；代码标记内的文本不动
function splitInlineMath(nodes: DocNode[]): DocNode[] {
  const out: DocNode[] = []
  for (const node of nodes) {
    const text = node.text
    if (node.type !== 'text' || !text || hasCodeMark(node)) {
      out.push(node)
      continue
    }
    const re = /(?<![$＄])[$＄]([^$＄\n]+?)[$＄](?![$＄])/g
    const parts: DocNode[] = []
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parts.push({ ...node, text: text.slice(last, m.index) })
      parts.push({ type: 'inlineMath', attrs: { latex: m[1] } })
      last = m.index + m[0].length
    }
    if (parts.length === 0) {
      out.push(node)
      continue
    }
    if (last < text.length) parts.push({ ...node, text: text.slice(last) })
    out.push(...parts)
  }
  return out
}

// 逐层处理内容数组：多段落 $$ 块（[$$][正文段落…][$$]，中间必须全是段落）、
// 整段单段 $$…$$、段落内行内 $…$
function processChildren(children: DocNode[]): DocNode[] {
  const out: DocNode[] = []
  let i = 0
  while (i < children.length) {
    const node = children[i]
    if (node.type === 'paragraph') {
      if (isDelim(node)) {
        let j = -1
        for (let k = i + 1; k < children.length; k++) {
          if (isDelim(children[k])) {
            j = k
            break
          }
        }
        const inner = j > i ? children.slice(i + 1, j) : []
        if (j > i && inner.every((c) => c.type === 'paragraph')) {
          const latex = inner.map(textOf).join('\n').trim()
          if (latex) out.push(blockMathNode(latex))
          i = j + 1
          continue
        }
      }
      const whole = textOf(node).trim()
      const wm = whole.length > 4 ? /^[$＄]{2}([\s\S]+?)[$＄]{2}$/.exec(whole) : null
      if (wm && wm[1].trim()) {
        out.push(blockMathNode(wm[1].trim()))
        i++
        continue
      }
      out.push({ ...node, content: splitInlineMath(node.content ?? []) })
      i++
      continue
    }
    if (node.content) {
      out.push({ ...node, content: processChildren(node.content) })
      i++
      continue
    }
    out.push(node)
    i++
  }
  return out
}

export function transformMath(doc: DocNode): DocNode {
  return { ...doc, content: processChildren(doc.content ?? []) }
}

// HTML（或 markdown 转出的 HTML）→ TipTap 文档 JSON（含数学转换）。无头实例用完即毁。
export function htmlToDocJson(html: string): object {
  const headless = new HeadlessEditor({
    extensions: buildExtensions(),
    content: html,
  })
  try {
    return transformMath(headless.getJSON() as DocNode) as object
  } finally {
    headless.destroy()
  }
}

export async function fileToDocJson(file: File): Promise<object> {
  const text = await readAsText(file)
  const html = kindOfFile(file) === 'markdown' ? (marked.parse(text, { async: false }) as string) : text
  return htmlToDocJson(html)
}

// 逐个处理上传文件：md/html 解析插入光标处；pdf 提示走侧栏「文件」。
export async function importFilesIntoEditor(editor: Editor, files: File[]): Promise<void> {
  for (const file of files) {
    if (kindOfFile(file) === 'binary') {
      await alertDialog({ title: '无法导入', message: 'PDF 等文件请从列表页「上传文件」处上传，可在侧栏直接预览' })
      continue
    }
    try {
      const json = await fileToDocJson(file)
      editor.chain().focus().insertContent(json).run()
    } catch (err) {
      console.error('import file failed', file.name, err)
      await alertDialog({ title: '导入失败', message: `导入 ${file.name} 失败：无法解析内容` })
    }
  }
}
