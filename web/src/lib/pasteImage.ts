import type { EditorView } from '@tiptap/pm/view'

// 粘贴图片内联进文档（以 data URL 存进 JSON 内容，跟随 Dexie 本地库和云同步走，
// 无需 Storage 服务）。截图常见尺寸很大，这里按最长边压缩，避免单篇笔记膨胀。
const MAX_EDGE = 1600
// 小于该体积且无需缩放的文件直接嵌入原始数据，避免无意义的重压缩
const ORIGINAL_LIMIT = 400 * 1024

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load failed'))
    img.src = url
  })
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('read file failed'))
    reader.readAsDataURL(file)
  })
}

// 转 data URL：超过最长边先等比缩放；非 PNG 统一转 JPEG（PNG 保留透明通道）。
// PNG 截图经 canvas 重绘仍是 PNG，清晰度无损。
async function fileToDataUrl(file: File): Promise<string> {
  const blobUrl = URL.createObjectURL(file)
  try {
    const img = await loadImage(blobUrl)
    const needResize = Math.max(img.width, img.height) > MAX_EDGE
    if (!needResize && file.size <= ORIGINAL_LIMIT) return await readAsDataUrl(file)
    const scale = needResize ? MAX_EDGE / Math.max(img.width, img.height) : 1
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.width * scale))
    canvas.height = Math.max(1, Math.round(img.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return await readAsDataUrl(file)
    const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
    if (mime === 'image/jpeg') {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL(mime, 0.85)
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}

// 供 editorProps.handlePaste 调用：view 上同步判断，异步读图后逐个插入。
// 插入用 replaceSelectionWith，选区自然落在图片之后，多图顺序正确。
export async function insertPastedImages(view: EditorView, files: File[]): Promise<void> {
  const type = view.state.schema.nodes.image
  if (!type) return
  for (const file of files) {
    try {
      const src = await fileToDataUrl(file)
      const node = type.create({ src })
      view.dispatch(view.state.tr.replaceSelectionWith(node))
    } catch (err) {
      console.error('insert pasted image failed', err)
    }
  }
}

export function pastedImageFiles(event: ClipboardEvent): File[] {
  const items = event.clipboardData?.files
  if (!items?.length) return []
  return Array.from(items).filter((f) => f.type.startsWith('image/'))
}
