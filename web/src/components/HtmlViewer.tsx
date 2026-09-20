import { useEffect, useState } from 'react'
import { dataUrlToBlob } from '../store/files'

// HTML 文件查看器：dataUrl → blob URL 后用 iframe 原生渲染。
// sandbox 只放行脚本、不放行 same-origin：页面里的脚本能跑，
// 但拿不到应用同源的数据（localStorage 里的会话等），隔离外部 HTML
export function HtmlViewer({ src }: { src: string }) {
  const [url, setUrl] = useState<{ src: string; url: string } | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    let u: string | null = null
    try {
      u = URL.createObjectURL(dataUrlToBlob(src, 'text/html'))
      setUrl({ src, url: u })
    } catch {
      setFailed(src)
    }
    return () => {
      if (u) URL.revokeObjectURL(u)
    }
  }, [src])

  if (failed === src) {
    return <p className="file-view-fallback">HTML 加载失败，请尝试下载后查看。</p>
  }
  if (!url || url.src !== src) {
    return <p className="file-view-fallback">正在加载…</p>
  }
  return <iframe className="file-view-frame" title="HTML 预览" src={url.url} sandbox="allow-scripts" />
}
