import { useEffect, useState, lazy, Suspense } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import 'katex/dist/katex.min.css'
import { supabase } from '../lib/supabase'
import { buildExtensions } from '../lib/editorExtensions'
import { kindOfName } from '../lib/importFile'
import './SharePage.css'

// pdf.js 体积大，懒加载
const PdfViewer = lazy(() =>
  import('../components/PdfViewer').then((m) => ({ default: m.PdfViewer })),
)

// 公开分享页：无需登录，按 token 拉取当前最新内容。
// 笔记 → 只读 TipTap 渲染；PDF → pdf.js 逐页渲染（宽度自适应、可触摸滚动）。

type LoadState =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'note'; title: string; content: unknown }
  | { status: 'file'; filename: string; url: string }

export function SharePage({ token }: { token: string }) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // 笔记优先，其次文件；都无 → 失效/撤销
      const { data: note } = await supabase.rpc('get_shared_note', { p_token: token })
      if (cancelled) return
      if (note && (note as { title?: string }[]).length > 0) {
        const row = (note as { title: string; content: unknown }[])[0]
        setState({ status: 'note', title: row.title, content: row.content })
        return
      }
      const { data: file } = await supabase.rpc('get_shared_file', { p_token: token })
      if (cancelled) return
      if (file && (file as { filename?: string }[]).length > 0) {
        const row = file as { filename: string; storage_path: string }[]
        // 分享对象复制在公共桶 shares/{token}（见 store/shares.ts），
        // files.storage_path 是私有桶路径，不能直接用
        const base = (import.meta.env.VITE_SUPABASE_URL as string).replace(/\/$/, '')
        const url = `${base}/storage/v1/object/public/shares/${token}?render=1`
        setState({ status: 'file', filename: row[0].filename, url })
        return
      }
      setState({ status: 'missing' })
    })().catch((err) => {
      console.error('load shared content failed', err)
      if (!cancelled) setState({ status: 'missing' })
    })
    return () => {
      cancelled = true
    }
  }, [token])

  const isHtmlShare = state.status === 'file' && kindOfName(state.filename) === 'html'

  // HTML 分享不用 iframe（微信内置浏览器等环境不支持）：校验分享有效后直接顶层跳转，
  // 网关 /share-raw/<token> 代取字节并强制 text/html + CSP sandbox
  useEffect(() => {
    if (isHtmlShare) window.location.replace(`/share-raw/${encodeURIComponent(token)}`)
  }, [isHtmlShare, token])

  return (
    <div className="share-page">
      <div className={state.status === 'file' ? 'share-sheet share-sheet-file' : 'share-sheet'}>
        {state.status === 'loading' && <p className="share-status">载入中…</p>}
        {state.status === 'missing' && (
          <div className="share-status">
            <p>链接已失效或分享已被撤销</p>
            <a className="share-home" href="./">
              回到 InkFlow
            </a>
          </div>
        )}
        {state.status === 'note' && <SharedNote title={state.title} content={state.content} />}
        {state.status === 'file' && (
          <div className="share-file">
            <h1 className="share-file-name">{state.filename}</h1>
            {kindOfName(state.filename) === 'html' ? (
              <p className="share-status">正在打开…</p>
            ) : (
              <Suspense fallback={<p className="share-status">正在加载 PDF…</p>}>
                <PdfViewer src={state.url} />
              </Suspense>
            )}
          </div>
        )}
      </div>
      <footer className="share-footer">由 InkFlow 分享 · 内容以打开时的最新版本为准</footer>
    </div>
  )
}

function SharedNote({ title, content }: { title: string; content: unknown }) {
  const editor = useEditor({
    extensions: buildExtensions(),
    editable: false,
    content: content as object,
  })

  return (
    <article className="share-doc">
      <h1 className="share-doc-title">{title || '无标题'}</h1>
      <EditorContent editor={editor} className="share-doc-body" />
    </article>
  )
}
