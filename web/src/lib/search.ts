// 笔记搜索的文本工具：把 TipTap 文档 JSON 提成纯文本，
// 并从正文截取「命中词前后」的片段用于列表高亮展示。

interface TipTapNode {
  type?: string
  text?: string
  content?: TipTapNode[]
}

// 与列表摘要一致：公式/图片不占词，换成空格避免前后文字粘连
export function plainTextOf(content: unknown): string {
  const walk = (node: TipTapNode): string => {
    if (node.type === 'text') return node.text ?? ''
    if (node.type === 'inlineMath' || node.type === 'blockMath' || node.type === 'image') return ' '
    return (node.content ?? []).map(walk).join('')
  }
  const root = content as TipTapNode | null
  return (root?.content ?? []).map(walk).join('\n')
}

export interface MatchSnippet {
  before: string
  hit: string
  after: string
  /** 片段前后是否被截断（显示省略号） */
  beforeCut: boolean
  afterCut: boolean
}

const SNIPPET_RADIUS = 40

// 在正文纯文本里找第一个命中（大小写不敏感），截取前后各一段；
// 截断处去掉半个词。命中在标题的笔记没有内容片段，返回 null（列表回退普通摘要）。
export function matchSnippet(content: unknown, query: string): MatchSnippet | null {
  const q = query.trim().toLowerCase()
  if (!q) return null
  const text = plainTextOf(content)
  const idx = text.toLowerCase().indexOf(q)
  if (idx < 0) return null

  const beforeCut = idx > SNIPPET_RADIUS
  const afterCut = text.length - (idx + q.length) > SNIPPET_RADIUS

  let before = text.slice(Math.max(0, idx - SNIPPET_RADIUS), idx)
  let after = text.slice(idx + q.length, Math.min(text.length, idx + q.length + SNIPPET_RADIUS))
  // 截断侧去掉不完整的半个词
  if (beforeCut) {
    const i = before.indexOf(' ')
    if (i >= 0) before = before.slice(i + 1)
  }
  if (afterCut) {
    const i = after.lastIndexOf(' ')
    if (i >= 0) after = after.slice(0, i)
  }
  return { before, hit: text.slice(idx, idx + q.length), after, beforeCut, afterCut }
}
