// 字数统计：每个 CJK 字符计 1，连续英文/数字串计 1 个词；公式按 latex 源码计入
interface TextNode {
  type?: string
  text?: string
  attrs?: { latex?: string }
  content?: TextNode[]
}

function collectText(node: TextNode, out: string[]): void {
  if (node.type === 'text' && node.text) out.push(node.text)
  if ((node.type === 'inlineMath' || node.type === 'blockMath') && node.attrs?.latex) {
    out.push(node.attrs.latex)
  }
  node.content?.forEach((child) => collectText(child, out))
}

export function countWords(content: unknown): number {
  const parts: string[] = []
  if (content && typeof content === 'object') collectText(content as TextNode, parts)
  const text = parts.join(' ')
  const cjk = text.match(/[一-鿿㐀-䶿]/g)?.length ?? 0
  const words = text.match(/[a-zA-Z0-9'’_-]+/g)?.length ?? 0
  return cjk + words
}

export function firstLine(content: unknown): string {
  const parts: string[] = []
  if (content && typeof content === 'object') {
    const doc = content as TextNode
    const first = doc.content?.[0]
    if (first) collectText(first, parts)
  }
  return parts.join('').trim()
}
