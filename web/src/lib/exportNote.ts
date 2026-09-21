import { toBlob } from 'html-to-image'

interface TipTapNode {
  type: string
  text?: string
  attrs?: Record<string, unknown>
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>
  content?: TipTapNode[]
}

/**
 * 将 TipTap / ProseMirror JSON 节点递归转换为标准 Markdown 文本
 */
export function docToMarkdown(doc: unknown, title?: string): string {
  if (!doc || typeof doc !== 'object') {
    return title ? `# ${title}\n\n` : ''
  }

  const root = doc as TipTapNode
  const lines: string[] = []

  if (title && title.trim()) {
    lines.push(`# ${title.trim()}\n`)
  }

  function serializeMarks(text: string, marks?: Array<{ type: string; attrs?: Record<string, unknown> }>): string {
    if (!marks || marks.length === 0) return text
    let res = text
    for (const mark of marks) {
      switch (mark.type) {
        case 'bold':
          res = `**${res}**`
          break
        case 'italic':
          res = `*${res}*`
          break
        case 'strike':
          res = `~~${res}~~`
          break
        case 'code':
          res = `\`${res}\``
          break
        case 'link': {
          const href = (mark.attrs?.href as string) || ''
          res = `[${res}](${href})`
          break
        }
        case 'math_inline': {
          const latex = (mark.attrs?.latex as string) || res
          res = `$${latex}$`
          break
        }
        case 'highlight':
          res = `==${res}==`
          break
      }
    }
    return res
  }

  function serializeInline(nodes?: TipTapNode[]): string {
    if (!nodes) return ''
    return nodes
      .map((node) => {
        if (node.type === 'text') {
          return serializeMarks(node.text || '', node.marks)
        }
        if (node.type === 'image') {
          const alt = (node.attrs?.alt as string) || ''
          const src = (node.attrs?.src as string) || ''
          return `![${alt}](${src})`
        }
        if (node.type === 'math_inline') {
          const latex = (node.attrs?.latex as string) || ''
          return `$${latex}$`
        }
        if (node.type === 'hardBreak') {
          return '  \n'
        }
        return ''
      })
      .join('')
  }

  function serializeBlock(node: TipTapNode, indent = ''): string {
    switch (node.type) {
      case 'heading': {
        const level = (node.attrs?.level as number) || 1
        const prefix = '#'.repeat(level)
        return `${prefix} ${serializeInline(node.content)}\n\n`
      }
      case 'paragraph': {
        const text = serializeInline(node.content)
        return text ? `${indent}${text}\n\n` : '\n'
      }
      case 'blockquote': {
        const inner = (node.content || []).map((c) => serializeBlock(c)).join('').trim()
        const quoted = inner
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n')
        return `${quoted}\n\n`
      }
      case 'codeBlock': {
        const lang = (node.attrs?.language as string) || ''
        const code = (node.content || []).map((c) => c.text || '').join('')
        return `\`\`\`${lang}\n${code}\n\`\`\`\n\n`
      }
      case 'math_display': {
        const latex = (node.attrs?.latex as string) || (node.content || []).map((c) => c.text || '').join('')
        return `$$\n${latex}\n$$\n\n`
      }
      case 'horizontalRule':
        return '---\n\n'
      case 'bulletList': {
        return (
          (node.content || [])
            .map((item) => {
              const itemText = (item.content || []).map((c) => serializeBlock(c)).join('').trim()
              const lines = itemText.split('\n')
              const first = `${indent}- ${lines[0]}`
              const rest = lines.slice(1).map((l) => `${indent}  ${l}`).join('\n')
              return rest ? `${first}\n${rest}` : first
            })
            .join('\n') + '\n\n'
        )
      }
      case 'orderedList': {
        let index = (node.attrs?.start as number) || 1
        return (
          (node.content || [])
            .map((item) => {
              const itemText = (item.content || []).map((c) => serializeBlock(c)).join('').trim()
              const lines = itemText.split('\n')
              const first = `${indent}${index++}. ${lines[0]}`
              const rest = lines.slice(1).map((l) => `${indent}   ${l}`).join('\n')
              return rest ? `${first}\n${rest}` : first
            })
            .join('\n') + '\n\n'
        )
      }
      case 'taskList': {
        return (
          (node.content || [])
            .map((item) => {
              const checked = item.attrs?.checked ? 'x' : ' '
              const itemText = (item.content || []).map((c) => serializeBlock(c)).join('').trim()
              const lines = itemText.split('\n')
              const first = `${indent}- [${checked}] ${lines[0]}`
              const rest = lines.slice(1).map((l) => `${indent}  ${l}`).join('\n')
              return rest ? `${first}\n${rest}` : first
            })
            .join('\n') + '\n\n'
        )
      }
      case 'table': {
        const rows = node.content || []
        if (rows.length === 0) return ''
        const tableLines: string[] = []
        rows.forEach((row, rowIndex) => {
          const cells = row.content || []
          const cellTexts = cells.map((cell) =>
            (cell.content || []).map((c) => serializeBlock(c)).join('').replace(/\n+/g, ' ').trim(),
          )
          tableLines.push(`| ${cellTexts.join(' | ')} |`)
          if (rowIndex === 0) {
            tableLines.push(`| ${cells.map(() => '---').join(' | ')} |`)
          }
        })
        return tableLines.join('\n') + '\n\n'
      }
      default: {
        if (node.content && node.content.length > 0) {
          return node.content.map((c) => serializeBlock(c, indent)).join('')
        }
        return ''
      }
    }
  }

  if (root.content) {
    for (const child of root.content) {
      lines.push(serializeBlock(child))
    }
  }

  return lines.join('').trim() + '\n'
}

/**
 * 触发文件下载
 */
export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * 导出笔记为 Markdown 文件并下载
 */
export function exportNoteToMarkdown(title: string, content: unknown) {
  const md = docToMarkdown(content, title)
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
  const filename = `${title.trim() || '无标题'}.md`
  downloadBlob(filename, blob)
}

/**
 * 导出笔记为高清主题图片（PNG）
 * - 高分辨率：pixelRatio 2 (retina 级)
 * - 样式与主题完全一致：继承当前 --paper / --ink-* / 霞鹜文岸字体
 */
export async function exportNoteToImage(title: string, editorBodyElement: HTMLElement): Promise<void> {
  const currentTheme = document.documentElement.dataset.theme || ''

  // 构造离屏包装容器，严格继承应用字体、主题变量与内边距
  const wrapper = document.createElement('div')
  wrapper.className = 'export-image-wrapper'
  if (currentTheme) {
    wrapper.dataset.theme = currentTheme
  }

  // 标题区
  const titleEl = document.createElement('h1')
  titleEl.className = 'export-image-title'
  titleEl.textContent = title.trim() || '无标题'
  wrapper.appendChild(titleEl)

  // 正文克隆
  const bodyWrap = document.createElement('div')
  bodyWrap.className = 'editor-body'
  const cloneBody = editorBodyElement.cloneNode(true) as HTMLElement
  // 清理不需要的临时 UI（如悬浮框、大纲开关等）
  cloneBody.querySelectorAll('.outline-toggle, .outline-panel, .floating-menu').forEach((el) => el.remove())
  bodyWrap.appendChild(cloneBody)
  wrapper.appendChild(bodyWrap)

  // 底部精致水印
  const footerEl = document.createElement('div')
  footerEl.className = 'export-image-footer'
  const dateStr = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
  footerEl.innerHTML = `<span>InkFlow</span> <span>·</span> <span>${dateStr}</span>`
  wrapper.appendChild(footerEl)

  const paperColor = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim() || '#f8f9f7'

  // 放置在底层以供正确计算布局与样式（坐标需从 0,0 开始，以保证 SVG 画布完整绘制）
  wrapper.style.position = 'fixed'
  wrapper.style.left = '0'
  wrapper.style.top = '0'
  wrapper.style.width = '780px'
  wrapper.style.zIndex = '-9999'
  wrapper.style.pointerEvents = 'none'
  wrapper.style.boxSizing = 'border-box'
  wrapper.style.backgroundColor = paperColor
  wrapper.style.color = 'var(--ink-900)'
  wrapper.style.fontFamily = 'var(--font-note)'
  wrapper.style.padding = '48px 56px 36px'

  document.body.appendChild(wrapper)

  try {
    // 渲染为高分辨率 Blob (2x 倍率)
    const blob = await toBlob(wrapper, {
      pixelRatio: 2,
      cacheBust: true,
      backgroundColor: paperColor,
    })

    if (!blob) throw new Error('生成图片失败')

    const filename = `${title.trim() || '无标题'}.png`
    downloadBlob(filename, blob)
  } finally {
    document.body.removeChild(wrapper)
  }
}

/**
 * 调起原生矢量打印以导出为 PDF
 * - 纯净排版，自动去除顶栏、侧栏及工具栏
 * - 保留字体、公式与当前主题配色
 */
export function printNoteToPdf(title: string, editorBodyElement: HTMLElement) {
  const iframe = document.createElement('iframe')
  iframe.style.position = 'fixed'
  iframe.style.right = '0'
  iframe.style.bottom = '0'
  iframe.style.width = '0'
  iframe.style.height = '0'
  iframe.style.border = 'none'
  document.body.appendChild(iframe)

  const doc = iframe.contentDocument || iframe.contentWindow?.document
  if (!doc) return

  // 拷贝当前页面的所有外部样式与内联样式
  const styleTags = Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))
    .map((el) => el.outerHTML)
    .join('\n')

  const themeAttr = document.documentElement.dataset.theme ? `data-theme="${document.documentElement.dataset.theme}"` : ''

  // 克隆正文内容并去除工具元素
  const clone = editorBodyElement.cloneNode(true) as HTMLElement
  clone.querySelectorAll('.outline-toggle, .outline-panel').forEach((el) => el.remove())

  doc.open()
  doc.write(`
    <!DOCTYPE html>
    <html ${themeAttr}>
    <head>
      <meta charset="utf-8">
      <title>${title.trim() || '无标题'}</title>
      ${styleTags}
      <style>
        @page {
          margin: 16mm 18mm;
          size: A4 portrait;
        }
        html, body {
          height: auto !important;
          overflow: visible !important;
          position: static !important;
          background: var(--paper) !important;
          color: var(--ink-900) !important;
          font-family: var(--font-note) !important;
        }
        body {
          padding: 20px 24px !important;
          max-width: 820px;
          margin: 0 auto !important;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        .pdf-export-title {
          font-family: var(--font-note);
          font-size: 28px;
          font-weight: 700;
          line-height: 1.3;
          color: var(--ink-900);
          margin: 0 0 20px 0;
          padding-bottom: 12px;
          border-bottom: 1px solid var(--ink-200);
        }
        .pdf-export-footer {
          margin-top: 36px;
          padding-top: 12px;
          border-top: 1px solid var(--ink-200);
          font-size: 11px;
          color: var(--ink-500);
          text-align: right;
          font-family: var(--font-ui);
        }
        pre, blockquote, table, figure, .math-node {
          break-inside: avoid;
          page-break-inside: avoid;
        }
      </style>
    </head>
    <body>
      <h1 class="pdf-export-title">${title.trim() || '无标题'}</h1>
      ${clone.outerHTML}
      <div class="pdf-export-footer">由 InkFlow 生成</div>
    </body>
    </html>
  `)
  doc.close()

  // 等待样式和字体在 iframe 内部完成计算
  iframe.onload = () => {
    setTimeout(() => {
      try {
        iframe.contentWindow?.focus()
        iframe.contentWindow?.print()
      } finally {
        setTimeout(() => {
          if (document.body.contains(iframe)) {
            document.body.removeChild(iframe)
          }
        }, 2000)
      }
    }, 200)
  }
}
