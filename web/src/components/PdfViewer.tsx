import { useMemo, useRef } from 'react'

// PDF 查看器：iframe 嵌入 pdf.js 官方 viewer（Firefox 内置同款，静态资源在 public/pdfjs/viewer/）。
// 替换之前的手写 canvas 渲染器——官方 viewer 自带缩放重渲染、文本层、查找、
// 页面内存管理（离屏页面自动释放位图），手机上放大不会糊也不会 OOM 崩溃。

// 中文 PDF 常见问题：作者没内嵌字体（如 LaTeX 的 FandolSong），靠查看器用系统字体兜底。
// 官方 viewer 跑在 iframe 里，document.fonts 与父页独立，需要往 iframe 里注入
// 以常见字体名注册的 @font-face（复用应用自带的霞鹜文岸子集，懒加载只取用到的字）。
// canvas 按字体族名匹配：pdf.js 用 local() 兜底失败后，浏览器会命中同名注册字体。
const FONT_ALIASES = [
  'FandolSong', 'FandolSong-Regular', 'FandolSong-Bold', 'FandolHei', 'FandolHei-Regular', 'FandolHei-Bold',
  'FandolFang', 'FandolKai',
  'STSong-Light', 'STSongStd-Light', 'SimSun', 'NSimSun', 'SimHei', 'KaiTi', 'FangSong',
  'Microsoft YaHei', 'DengXian', 'Songti SC', 'Heiti SC', 'STHeiti', 'Hiragino Sans GB',
  'PingFang SC', 'PingFangSC-Regular', 'PingFangSC-Bold',
  'Source Han Sans SC', 'Source Han Serif SC', 'Noto Sans CJK SC', 'Noto Serif CJK SC',
  'WenQuanYi Micro Hei', 'WenQuanYi Zen Hei', 'AR PL UMing CN', 'Droid Sans Fallback',
  'Adobe Song Std', 'Adobe Heiti Std', 'Adobe Kaiti Std', 'Adobe Fangsong Std',
  'TeXGyrePagella', 'TeXGyrePagella-Regular', 'TeXGyrePagella-Bold', 'TeXGyrePagella-Italic',
  'TeXGyreHeros', 'TeXGyreHeros-Regular', 'TeXGyreHeros-Bold',
]

async function injectFontAliases(doc: Document) {
  try {
    const link = document.querySelector<HTMLLinkElement>('link[rel="stylesheet"][href*="assets"]')
    if (!link) return
    const cssUrl = link.href
    const css = await (await fetch(cssUrl)).text()
    const blocks = [...css.matchAll(/@font-face\s*\{[^}]+\}/g)]
      .map((m) => m[0])
      .filter((b) => b.includes('LXGW WenKai'))
    const rules: string[] = []
    for (const alias of FONT_ALIASES) {
      for (const b of blocks) {
        const url = /url\(([^)]+)\)/.exec(b)?.[1]
        const weight = /font-weight:\s*(\d+)/.exec(b)?.[1] ?? '400'
        const range = /unicode-range:\s*([^;}]+)/.exec(b)?.[1]
        if (!url) continue
        rules.push(
          `@font-face{font-family:"${alias}";src:url(${new URL(url, cssUrl).href});` +
            `font-weight:${weight};${range ? `unicode-range:${range};` : ''}}`,
        )
      }
    }
    if (!rules.length) return
    const style = doc.createElement('style')
    style.textContent = rules.join('\n')
    doc.head.appendChild(style)
  } catch {
    // 注入失败不影响 PDF 打开，只是未内嵌字体的文档可能仍有缺字
  }
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [head, b64] = dataUrl.split(',')
  const mime = /data:([^;,]+)/.exec(head)?.[1] || 'application/pdf'
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

// src(data: URL) → blob: URL 会话级缓存，避免重复打开同一 PDF 时重复 base64 解码
const blobUrlCache = new Map<string, string>()

export function PdfViewer({ src }: { src: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null)

  const isData = src.startsWith('data:')

  // data: URL 太长，不能直接塞进 viewer.html?file=，转成 blob: URL；
  // 同一文件重复打开时复用已转换的 blob（base64 解码只做一次，会话内常驻）；
  // http(s) 地址（分享页）或直接 blob: URL 直接交给 viewer 自己拉取
  const blobUrl = useMemo(() => {
    if (!isData) return null
    const cached = blobUrlCache.get(src)
    if (cached) return cached
    try {
      const url = URL.createObjectURL(dataUrlToBlob(src))
      blobUrlCache.set(src, url)
      return url
    } catch {
      return null
    }
  }, [src, isData])

  const fileUrl = !isData ? src : blobUrl
  const viewerUrl = fileUrl
    ? `${import.meta.env.BASE_URL}pdfjs/viewer/web/viewer.html?file=${encodeURIComponent(fileUrl)}#zoom=page-width&pagemode=none`
    : null

  if (isData && !blobUrl) {
    return <p className="file-view-fallback">PDF 加载失败，请尝试下载后查看。</p>
  }
  if (!viewerUrl) {
    return <p className="file-view-fallback">正在加载 PDF…</p>
  }
  return (
    <iframe
      ref={frameRef}
      className="file-view-frame"
      title="PDF 查看器"
      src={viewerUrl}
      onLoad={() => {
        const doc = frameRef.current?.contentDocument
        if (doc) void injectFontAliases(doc)
      }}
    />
  )
}
