import { db } from '../lib/db'
import { supabase } from '../lib/supabase'

// 笔记图片管线：正文 img 的 src 是 Storage 公共桶 images 的 URL；
// 本地 Dexie images 表缓存 data URL，供离线/新设备未下载时显示。
// 粘贴即写本地缓存（离线也能立刻看到），联网后由同步引擎 uploadPendingImages 传桶。

const BUCKET = 'images'

export function publicImageUrl(path: string): string {
  const base = (import.meta.env.VITE_SUPABASE_URL as string).replace(/\/$/, '')
  return `${base}/storage/v1/object/public/${BUCKET}/${encodeURIComponent(path)}`
}

// 从公共 URL 还原桶内路径；不是本桶的 URL（如旧 data URL）返回 null
export function imagePathFromUrl(src: string): string | null {
  const marker = `/storage/v1/object/public/${BUCKET}/`
  const i = src.indexOf(marker)
  if (i < 0) return null
  try {
    return decodeURIComponent(src.slice(i + marker.length))
  } catch {
    return null
  }
}

export function newImagePath(mime: string): string {
  const ext = mime === 'image/png' ? 'png' : 'jpg'
  return `${crypto.randomUUID()}.${ext}`
}

// 粘贴时调用：写本地缓存（标记待上传），返回公共 URL 作为 src
export async function stageImage(path: string, dataUrl: string): Promise<string> {
  await db.images.put({ path, dataUrl, dirty: 1, createdAt: Date.now() })
  return publicImageUrl(path)
}

// 同步引擎每轮调用：把待上传的图片传桶。失败不阻塞笔记同步，下一轮重试。
export async function uploadPendingImages(): Promise<void> {
  const pending = await db.images.where('dirty').equals(1).toArray()
  for (const img of pending) {
    const cur = await db.images.get(img.path)
    if (!cur || cur.dirty === 0) continue
    try {
      const { dataUrl } = cur
      const mime = dataUrl.startsWith('data:image/png') ? 'image/png' : 'image/jpeg'
      const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1))
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(cur.path, new Blob([bytes], { type: mime }), { contentType: mime, upsert: true })
      if (error) throw error
      const now = await db.images.get(cur.path)
      if (now && now.dirty === 1) await db.images.update(cur.path, { dirty: 0 })
    } catch (err) {
      console.error('upload image failed', cur.path, err)
    }
  }
}

// 离线/加载失败时的本地缓存；没有则返回 null（调用方应显示裂图占位）
export async function cachedImageDataUrl(path: string): Promise<string | null> {
  const row = await db.images.get(path)
  return row?.dataUrl ?? null
}

// 图片加载成功后顺手缓存，供离线使用（CORS 失败静默跳过）
export async function cacheImageFromUrl(src: string): Promise<void> {
  const path = imagePathFromUrl(src)
  if (!path) return
  const existing = await db.images.get(path)
  if (existing) return
  try {
    const res = await fetch(src)
    if (!res.ok) return
    const blob = await res.blob()
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(new Error('read failed'))
      reader.readAsDataURL(blob)
    })
    await db.images.put({ path, dataUrl, dirty: 0, createdAt: Date.now() })
  } catch {
    // 离线或 CORS 受限：跳过缓存，显示不受影响
  }
}

interface TipTapNode {
  type?: string
  attrs?: { src?: string }
  content?: TipTapNode[]
}

function walkImages(node: TipTapNode, visit: (src: string) => void) {
  if (node.type === 'image' && node.attrs?.src) visit(node.attrs.src)
  for (const child of node.content ?? []) walkImages(child, visit)
}

export function noteImageSrcs(content: unknown): string[] {
  const srcs: string[] = []
  walkImages(content as TipTapNode, (src) => srcs.push(src))
  return srcs
}

// 存量迁移：正文里的 data URL 图片 → 传桶 + 替换为公共 URL。
// 返回迁移后的内容；没有内联图片或迁移失败返回原内容。
export async function migrateInlineImages(content: unknown): Promise<unknown> {
  const root = content as TipTapNode | null
  if (!root?.content) return content
  const srcs = noteImageSrcs(content).filter((s) => s.startsWith('data:'))
  if (!srcs.length) return content

  const replacements = new Map<string, string>()
  for (const dataUrl of srcs) {
    try {
      const mime = dataUrl.startsWith('data:image/png') ? 'image/png' : 'image/jpeg'
      const path = newImagePath(mime)
      await db.images.put({ path, dataUrl, dirty: 1, createdAt: Date.now() })
      await uploadPendingImages()
      replacements.set(dataUrl, publicImageUrl(path))
    } catch (err) {
      console.error('migrate image failed', err)
    }
  }
  if (!replacements.size) return content

  const clone = (node: TipTapNode): TipTapNode => ({
    ...node,
    attrs: node.type === 'image' && node.attrs?.src ? { ...node.attrs, src: replacements.get(node.attrs.src) ?? node.attrs.src } : node.attrs,
    content: node.content?.map(clone),
  })
  return { ...root, content: root.content.map(clone) }
}
