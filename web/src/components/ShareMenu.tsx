import { useEffect, useRef, useState } from 'react'
import { Share2 } from 'lucide-react'
import {
  createFileShare,
  createNoteShare,
  getShareForFile,
  getShareForNote,
  revokeShare,
  shareUrl,
  type Share,
} from '../store/shares'
import { alertDialog, confirmDialog, promptDialog } from '../lib/dialog'
import './ShareMenu.css'

// 「分享」按钮 + 弹出卡片：创建/复制/撤销外链。一个对象最多一条有效分享。
export function ShareMenu({
  userId,
  target,
}: {
  userId: string
  target: { kind: 'note'; noteId: string } | { kind: 'file'; fileId: string }
}) {
  const [open, setOpen] = useState(false)
  const [share, setShare] = useState<Share | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const refresh = async () => {
    setLoading(true)
    try {
      const s =
        target.kind === 'note'
          ? await getShareForNote(target.noteId)
          : await getShareForFile(target.fileId)
      setShare(s)
    } catch (err) {
      console.error('load share failed', err)
    } finally {
      setLoading(false)
    }
  }

  const toggle = () => {
    const next = !open
    setOpen(next)
    setCopied(false)
    if (next) void refresh()
  }

  const create = async () => {
    setLoading(true)
    try {
      const s =
        target.kind === 'note'
          ? await createNoteShare(userId, target.noteId)
          : await createFileShare(userId, target.fileId)
      setShare(s)
      await copy(s.token)
    } catch (err) {
      console.error('create share failed', err)
      await alertDialog({ title: '创建失败', message: '创建分享链接失败（文件需要先同步上云才能分享）' })
    } finally {
      setLoading(false)
    }
  }

  const copy = async (token: string) => {
    try {
      await navigator.clipboard.writeText(shareUrl(token))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      await promptDialog({
        title: '复制链接',
        message: '自动复制失败，请手动复制：',
        input: { defaultValue: shareUrl(token) },
      })
    }
  }

  const revoke = async () => {
    if (!share) return
    const ok = await confirmDialog({
      title: '撤销分享',
      message: '撤销后链接立即失效，确定？',
      confirmText: '撤销',
      danger: true,
    })
    if (!ok) return
    setLoading(true)
    try {
      await revokeShare(share)
      setShare(null)
    } catch (err) {
      console.error('revoke share failed', err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="share-menu" ref={rootRef}>
      <button
        type="button"
        className="tool-btn share-btn"
        title="分享"
        aria-label="分享"
        onClick={() => void toggle()}
      >
        <Share2 size={14} />
        <span>分享</span>
      </button>
      {open && (
        <div className="share-card">
          {loading ? (
            <p className="share-hint">处理中…</p>
          ) : share ? (
            <>
              <input className="share-link" readOnly value={shareUrl(share.token)} onFocus={(e) => e.target.select()} />
              <div className="share-actions">
                <button
                  type="button"
                  onClick={() => window.open(shareUrl(share.token), '_blank', 'noopener')}
                >
                  打开
                </button>
                <button type="button" onClick={() => void copy(share.token)}>
                  {copied ? '已复制 ✓' : '复制链接'}
                </button>
                <button type="button" className="share-revoke" onClick={() => void revoke()}>
                  撤销分享
                </button>
              </div>
              <p className="share-hint">任何人打开链接即可查看当前最新内容</p>
            </>
          ) : (
            <>
              <p className="share-hint">创建后任何人可通过链接查看当前最新内容</p>
              <button type="button" className="share-create" onClick={() => void create()}>
                创建分享链接
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
