import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PDFDocumentProxy } from 'pdfjs-dist'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

// 中文 PDF 常见问题：作者没内嵌字体（如 LaTeX 的 FandolSong），靠查看器用系统字体兜底。
// 浏览器原生查看器能兜底，pdf.js 只会尝试 local(字体名)——本机没装就画空白。
// 解法：把应用自带的霞鹜文岸字体子集以这些常见字体名重新注册进 document.fonts，
// pdf.js 的 local() 替换即可命中（懒加载，只取实际用到的子集）。
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

let aliasesRegistered = false
async function registerFontAliases() {
  if (aliasesRegistered) return
  aliasesRegistered = true
  try {
    const link = document.querySelector<HTMLLinkElement>('link[rel="stylesheet"][href*="assets"]')
    if (!link) return
    const cssUrl = link.href
    const css = await (await fetch(cssUrl)).text()
    const blocks = [...css.matchAll(/@font-face\s*\{[^}]+\}/g)]
      .map((m) => m[0])
      .filter((b) => b.includes('LXGW WenKai'))
    for (const alias of FONT_ALIASES) {
      for (const b of blocks) {
        const url = /url\(([^)]+)\)/.exec(b)?.[1]
        const weight = /font-weight:\s*(\d+)/.exec(b)?.[1] ?? '400'
        const unicodeRange = /unicode-range:\s*([^;}]+)/.exec(b)?.[1]
        if (!url) continue
        document.fonts.add(
          new FontFace(alias, `url(${new URL(url, cssUrl).href})`, { weight, unicodeRange }),
        )
      }
    }
  } catch {
    // 字体别名注册失败不影响 PDF 打开，只是未内嵌字体的文档可能仍有缺字
  }
}

// PDF 查看器：逐页渲染到 canvas，宽度自适应容器，纵向触摸滚动。
// 替换原先的 <iframe dataUrl> 方案——浏览器内建查看器在手机上不缩放、不滚动。
export function PdfViewer({ src }: { src: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  // loaded / failed 都绑 src，切换文件时自动失效，无需在 effect 里手动清状态
  const [loaded, setLoaded] = useState<{ src: string; doc: PDFDocumentProxy } | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    let cancelled = false
    void registerFontAliases()
    const task = pdfjs.getDocument({
      url: src,
      cMapUrl: `${import.meta.env.BASE_URL}pdfjs/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${import.meta.env.BASE_URL}pdfjs/standard_fonts/`,
    })
    task.promise
      .then((d) => !cancelled && setLoaded({ src, doc: d }))
      .catch(() => !cancelled && setFailed(src))
    return () => {
      cancelled = true
      void task.destroy()
    }
  }, [src])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    // 取内容区宽度（剔除 .pdf-view 的 padding），渲染比例才恰好等于 dpr
    const measure = () => {
      const cs = getComputedStyle(el)
      setWidth(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight))
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el) // observe 会立即回调一次，初始宽度也有了
    return () => ro.disconnect()
  }, [])

  const doc = loaded && loaded.src === src ? loaded.doc : null
  const error = failed === src

  return (
    <div ref={containerRef} className="pdf-view">
      {error ? (
        <p className="file-view-fallback">PDF 加载失败，请尝试下载后查看。</p>
      ) : !doc ? (
        <p className="file-view-fallback">正在加载 PDF…</p>
      ) : (
        Array.from({ length: doc.numPages }, (_, i) => (
          <PdfPage key={i} doc={doc} pageNumber={i + 1} width={width} />
        ))
      )}
    </div>
  )
}

function PdfPage({ doc, pageNumber, width }: { doc: PDFDocumentProxy; pageNumber: number; width: number }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(false)
  const [aspect, setAspect] = useState(0) // 高/宽，用于占位避免布局跳动

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && setVisible(true),
      { rootMargin: '200px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  // 进入视口后先取页面高宽比（占位防跳动）；aspect 就绪后 canvas 才挂载
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    doc
      .getPage(pageNumber)
      .then((page) => {
        if (cancelled) return
        const base = page.getViewport({ scale: 1 })
        setAspect(base.height / base.width)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [visible, doc, pageNumber])

  // aspect 在 deps 里：canvas 挂载（重渲染）后本 effect 重跑，ref 才拿得到
  useEffect(() => {
    if (!visible || !width || !aspect) return
    const canvas = canvasRef.current
    if (!canvas) return
    let cancelled = false
    let renderTask: ReturnType<PDFPageProxy['render']> | null = null
    doc
      .getPage(pageNumber)
      .then((page) => {
        if (cancelled) return
        const base = page.getViewport({ scale: 1 })
        // 上限 3：iPhone 是 3x 屏，封顶 2 会导致文字发虚；再高内存/渲染耗时平方级上涨
        const dpr = Math.min(window.devicePixelRatio || 1, 3)
        const viewport = page.getViewport({ scale: (width / base.width) * dpr })
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        renderTask = page.render({ canvas, viewport })
        return renderTask.promise
      })
      .catch(() => {})
    return () => {
      cancelled = true
      renderTask?.cancel()
    }
  }, [visible, width, aspect, doc, pageNumber])

  return (
    <div ref={wrapRef} className="pdf-page" style={aspect ? { aspectRatio: `1 / ${aspect}` } : undefined}>
      {aspect > 0 ? <canvas ref={canvasRef} /> : null}
    </div>
  )
}

type PDFPageProxy = Awaited<ReturnType<PDFDocumentProxy['getPage']>>
