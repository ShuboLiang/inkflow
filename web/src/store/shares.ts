import { supabase } from '../lib/supabase'
import { db } from '../lib/db'
import { dataUrlToBlob, ensureFileData } from './files'
import { isHtmlFile } from '../lib/importFile'

// 分享外链：shares 表只存映射（token → note/file）与撤销状态。
// 笔记内容实时读 notes 表（RPC 绕 RLS）；PDF 字节不可变，分享时复制到公共桶 shares。

export interface Share {
  token: string
  kind: 'note' | 'file'
  noteId: string | null
  fileId: string | null
  createdAt: number
}

interface ShareRow {
  token: string
  kind: 'note' | 'file'
  note_id: string | null
  file_id: string | null
  created_at: string
}

function rowToShare(row: ShareRow): Share {
  return {
    token: row.token,
    kind: row.kind,
    noteId: row.note_id,
    fileId: row.file_id,
    createdAt: new Date(row.created_at).getTime(),
  }
}

export async function getShareForNote(noteId: string): Promise<Share | null> {
  const { data } = await supabase
    .from('shares')
    .select('*')
    .eq('kind', 'note')
    .eq('note_id', noteId)
    .is('revoked_at', null)
    .maybeSingle()
  return data ? rowToShare(data as ShareRow) : null
}

export async function getShareForFile(fileId: string): Promise<Share | null> {
  const { data } = await supabase
    .from('shares')
    .select('*')
    .eq('kind', 'file')
    .eq('file_id', fileId)
    .is('revoked_at', null)
    .maybeSingle()
  return data ? rowToShare(data as ShareRow) : null
}

export async function createNoteShare(userId: string, noteId: string): Promise<Share> {
  const existing = await getShareForNote(noteId)
  if (existing) return existing
  const token = crypto.randomUUID()
  const { error } = await supabase.from('shares').insert({
    token,
    user_id: userId,
    kind: 'note',
    note_id: noteId,
  })
  // 并发双击等导致唯一索引冲突：返回已存在的那条
  if (error) {
    const again = await getShareForNote(noteId)
    if (again) return again
    throw error
  }
  return { token, kind: 'note', noteId, fileId: null, createdAt: Date.now() }
}

// PDF 字节不可变：从本地缓存（或私有桶）取内容上传到公共桶 shares/{token}，
// 之后打开链接实时查的是 files 表的文件名/删除状态。
// 部分环境（Windows/拖放）File.type 为空，按扩展名兜底 MIME，否则分享出去会被当纯文本展示
export async function createFileShare(userId: string, fileId: string): Promise<Share> {
  const existing = await getShareForFile(fileId)
  if (existing) return existing

  const file = await db.files.get(fileId)
  if (!file || file.deletedAt) throw new Error('file not found')
  const dataUrl = file.dataUrl ?? (await ensureFileData(fileId))
  if (!dataUrl) throw new Error('file content unavailable')

  const mime =
    file.mimeType ?? (isHtmlFile(file) ? 'text/html' : 'application/octet-stream')
  const token = crypto.randomUUID()
  // 注意必须传 ArrayBuffer：storage-js 对 Blob 会走 FormData 分支，
  // storage-api 从 multipart 里取不到 content-type，分享出去的 HTML 会被当 text/plain 展示
  const { error: upErr } = await supabase.storage
    .from('shares')
    .upload(token, await dataUrlToBlob(dataUrl, mime).arrayBuffer(), {
      contentType: mime,
      upsert: true,
    })
  if (upErr) throw upErr

  const { error } = await supabase.from('shares').insert({
    token,
    user_id: userId,
    kind: 'file',
    file_id: fileId,
  })
  if (error) {
    await supabase.storage.from('shares').remove([token])
    const again = await getShareForFile(fileId)
    if (again) return again
    throw error
  }
  return { token, kind: 'file', noteId: null, fileId, createdAt: Date.now() }
}

export async function revokeShare(share: Share): Promise<void> {
  const { error } = await supabase
    .from('shares')
    .update({ revoked_at: new Date().toISOString() })
    .eq('token', share.token)
  if (error) throw error
  if (share.kind === 'file') {
    await supabase.storage.from('shares').remove([share.token])
  }
}

export function shareUrl(token: string): string {
  return `${location.origin}${location.pathname}#/s/${token}`
}
