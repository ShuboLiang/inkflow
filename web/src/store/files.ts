import { db, type FileEntry } from '../lib/db'
import { supabase } from '../lib/supabase'

// 文件纯云端方案（方案 A）：
// 1. Dexie files 表只存元数据（文件名、大小、分类、标签等），不持久化庞大的文件内容，释放本地磁盘；
// 2. 预览文件时从 Supabase Storage 私有桶 files 按需流式拉取到内存（Blob URL），看完即走；
// 3. 上传时直接写入 Storage 并在内存中建立 Blob URL 供当次会话立即可读；
// 4. 删除时保留墓碑软同步，清理云端对象并通知各端清除元数据。

// 内存级 Blob URL 会话缓存，生命周期仅限于当前网页会话，不落盘、不占 IndexedDB
const fileBlobUrlCache = new Map<string, string>()

export function getCachedFileUrl(id: string): string | null {
  return fileBlobUrlCache.get(id) ?? null
}

export function revokeFileUrl(id: string): void {
  const url = fileBlobUrlCache.get(id)
  if (url) {
    URL.revokeObjectURL(url)
    fileBlobUrlCache.delete(id)
  }
}

export async function saveFile(
  file: File,
  folderId: string | null,
  userId?: string | null,
): Promise<FileEntry> {
  const ext = file.name.split('.').pop()?.toLowerCase()
  const fallbackMime =
    ext === 'pdf' ? 'application/pdf' : ext === 'html' || ext === 'htm' ? 'text/html' : null
  const mimeType = file.type || fallbackMime
  // 上传时去除 .pdf / .html / .htm 后缀名
  const cleanName = file.name.replace(/\.(pdf|html|htm)$/i, '').trim() || file.name
  const id = crypto.randomUUID()

  // 内存中立即可看：创建会话级 Blob URL
  const blobUrl = URL.createObjectURL(file)
  fileBlobUrlCache.set(id, blobUrl)

  let storagePath: string | null = null
  let dirty: 0 | 1 = 1
  let syncedAt: number | null = null

  if (userId) {
    const path = `${userId}/${id}`
    const { error: upErr } = await supabase.storage.from('files').upload(path, file, {
      contentType: mimeType ?? 'application/octet-stream',
      upsert: true,
    })
    if (upErr) {
      console.warn('direct upload to storage failed, will retry in sync push', upErr)
    } else {
      storagePath = path
    }
  }

  const entry: FileEntry = {
    id,
    folderId,
    filename: cleanName,
    mimeType,
    size: file.size,
    storagePath,
    tags: [],
    dirty,
    updatedAt: Date.now(),
    syncedAt,
    deletedAt: null,
  }
  await db.files.add(entry)
  return entry
}

// 从未上云的本地文件：直接物理删除。
// 已上云的文件：软删除（deletedAt + updatedAt 刷新 + dirty=1），由同步引擎同步墓碑与清理 Storage 对象。
export async function deleteFile(id: string): Promise<void> {
  const file = await db.files.get(id)
  if (!file) return

  // 释放会话级 Blob URL
  revokeFileUrl(id)

  if (!file.storagePath && file.syncedAt === null) {
    await db.files.delete(id)
    return
  }
  const now = Date.now()
  await db.files.update(id, {
    deletedAt: now,
    updatedAt: now,
    dirty: 1,
  })
}

export async function moveFile(id: string, folderId: string | null): Promise<void> {
  const existing = await db.files.get(id)
  if (!existing || existing.deletedAt) return
  await db.files.update(id, { folderId, dirty: 1, updatedAt: Date.now() })
}

// 重命名：只改 filename，走文件 LWW 同步推上云；分享链接里的文件名也是实时查表，随之更新
export async function renameFile(id: string, filename: string): Promise<void> {
  const name = filename.trim().replace(/\.(pdf|html|htm)$/i, '').trim()
  if (!name) return
  const existing = await db.files.get(id)
  if (!existing || existing.deletedAt || existing.filename === name) return
  await db.files.update(id, { filename: name, dirty: 1, updatedAt: Date.now() })
}

// 设置标签（与笔记标签同一命名空间，大小写不敏感去重由 TagInput 保证）
export async function setFileTags(id: string, tags: string[]): Promise<void> {
  const existing = await db.files.get(id)
  if (!existing || existing.deletedAt) return
  await db.files.update(id, { tags, dirty: 1, updatedAt: Date.now() })
}

// 预览前按需获取文件 Blob URL：
// 优先使用内存缓存；未命中时从 Storage 下载并创建临时 Object URL（不写入本地数据库）
export async function acquireFileUrl(id: string): Promise<string | null> {
  const cached = fileBlobUrlCache.get(id)
  if (cached) return cached

  const file = await db.files.get(id)
  if (!file || file.deletedAt || !file.storagePath) return null

  const { data, error } = await supabase.storage.from('files').download(file.storagePath)
  if (error || !data) return null

  // Storage 下发的 content-type 不可靠（fs 驱动 xattr 元数据丢失会以 text/plain 下发，
  // 实测如此），HTML 预览会因此只显示源码不渲染；以下发类型可疑为准，按数据库
  // 记录的 mime_type 重建 Blob
  const servedUnreliable = !data.type || data.type === 'text/plain' || data.type === 'application/octet-stream'
  const blob =
    servedUnreliable && file.mimeType && file.mimeType !== 'application/octet-stream'
      ? new Blob([data], { type: file.mimeType })
      : data
  const url = URL.createObjectURL(blob)
  fileBlobUrlCache.set(id, url)
  return url
}

export function dataUrlToBlob(dataUrl: string, mimeType: string | null): Blob {
  const [head, b64] = dataUrl.split(',')
  const mimeFromUrl = head?.match(/data:(.*?)(;|$)/)?.[1]
  const bin = atob(b64 ?? '')
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mimeType ?? mimeFromUrl ?? 'application/octet-stream' })
}
