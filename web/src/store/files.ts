import { db, type FileEntry } from '../lib/db'
import { supabase } from '../lib/supabase'

// 文件存 Dexie files 表，内容以 data URL 内联；同步时二进制上传到 Supabase Storage
// 私有桶 files（路径 {userId}/{fileId}），元数据走 files 表 LWW 同步。
// 文件是文件夹的内容：folderId 与笔记同规则（null = 无文件夹），可拖到侧栏文件夹间移动。

export async function saveFile(file: File, folderId: string | null): Promise<FileEntry> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('read file failed'))
    reader.readAsDataURL(file)
  })
  const entry: FileEntry = {
    id: crypto.randomUUID(),
    folderId,
    filename: file.name,
    mimeType: file.type || null,
    size: file.size,
    storagePath: null,
    dataUrl,
    dirty: 1,
    updatedAt: Date.now(),
    syncedAt: null,
    deletedAt: null,
  }
  await db.files.add(entry)
  return entry
}

// 从未上云的本地文件：直接物理删除（服务器从未有过）。
// 已上云的文件：软删除（deletedAt + 清掉本地内容省空间），由同步引擎删除 Storage 对象和服务器行。
export async function deleteFile(id: string): Promise<void> {
  const file = await db.files.get(id)
  if (!file) return
  if (!file.storagePath) {
    await db.files.delete(id)
    return
  }
  await db.files.update(id, {
    deletedAt: Date.now(),
    dirty: 1,
    dataUrl: null,
  })
}

export async function moveFile(id: string, folderId: string | null): Promise<void> {
  const existing = await db.files.get(id)
  if (!existing || existing.deletedAt) return
  await db.files.update(id, { folderId, dirty: 1, updatedAt: Date.now() })
}

// 重命名：只改 filename，走文件 LWW 同步推上云；分享链接里的文件名也是实时查表，随之更新
export async function renameFile(id: string, filename: string): Promise<void> {
  const name = filename.trim()
  if (!name) return
  const existing = await db.files.get(id)
  if (!existing || existing.deletedAt || existing.filename === name) return
  await db.files.update(id, { filename: name, dirty: 1, updatedAt: Date.now() })
}

// 预览前确保本地有内容：新设备上 dataUrl 为空，按需从 Storage 下载并缓存进 Dexie。
// storagePath 本身已含 userId 前缀，无需再传用户 id。
export async function ensureFileData(id: string): Promise<string | null> {
  const file = await db.files.get(id)
  if (!file || file.deletedAt) return null
  if (file.dataUrl) return file.dataUrl
  if (!file.storagePath) return null
  const { data, error } = await supabase.storage.from('files').download(file.storagePath)
  if (error || !data) return null
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('read blob failed'))
    reader.readAsDataURL(data)
  })
  // 只缓存内容，不动 updatedAt/dirty——内容以服务器为准，不算本地修改
  const cur = await db.files.get(id)
  if (cur && !cur.dataUrl && !cur.deletedAt) {
    await db.files.update(id, { dataUrl })
  }
  return dataUrl
}

export function dataUrlToBlob(dataUrl: string, mimeType: string | null): Blob {
  const [head, b64] = dataUrl.split(',')
  const mimeFromUrl = head?.match(/data:(.*?)(;|$)/)?.[1]
  const bin = atob(b64 ?? '')
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mimeType ?? mimeFromUrl ?? 'application/octet-stream' })
}
