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

const MIN_ZOOM = 1
const MAX_ZOOM = 4
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
// 桌面端页宽上限；放大时同比例放宽
const PAGE_MAX_WIDTH = 900
// 单页 canvas 像素上限：iOS Safari 单张 canvas 约 1670 万像素封顶，
// 且多页常驻内存易 OOM（渲染进程被杀 = “无法打开此页”），留足余量
const MAX_CANVAS_PIXELS = 12_000_000

// PDF 查看器：逐页渲染到 canvas，宽度自适应容器，纵向触摸滚动。
// 替换原先的 <iframe dataUrl> 方案——浏览器内建查看器在手机上不缩放、不滚动。
// 缩放：双击/双指捏合/Ctrl+滚轮；canvas 按缩放后的尺寸重渲染，任意倍率下文字都清晰。
export function PdfViewer({ src }: { src: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  // loaded / failed 都绑 src，切换文件时自动失效，无需在 effect 里手动清状态
  const [loaded, setLoaded] = useState<{ src: string; doc: PDFDocumentProxy } | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [width, setWidth] = useState(0)
  // zoom 立即作用于布局（捏合时跟着手），renderZoom 防抖后触发 canvas 重绘，
  // 手势过程中canvas先拉伸、松手后变清晰——避免连续重绘卡顿
  const [zoom, setZoom] = useState(1)
  const [renderZoom, setRenderZoom] = useState(1)
  const zoomRef = useRef(1)

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

  // 切换文件时重置缩放
  useEffect(() => {
    zoomRef.current = 1
    setZoom(1)
    setRenderZoom(1)
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

  useEffect(() => {
    // 手势进行中只改布局不触发重绘（手上有指针时跳过，捏合结束由 endPointer 立即触发）
    const t = setTimeout(() => {
      if (pointers.current.size === 0) setRenderZoom(zoomRef.current)
    }, 220)
    return () => clearTimeout(t)
  }, [zoom])

  const applyZoom = (z: number) => {
    const c = clampZoom(z)
    zoomRef.current = c
    setZoom(c)
  }

  // 缩放后保持 (cx, cy)（相对滚动视口）下的内容不动
  const zoomAt = (nextZoom: number, cx: number, cy: number) => {
    const el = containerRef.current
    if (!el) return
    const k = clampZoom(nextZoom) / zoomRef.current
    if (k === 1) return
    const sl = el.scrollLeft
    const st = el.scrollTop
    applyZoom(zoomRef.current * k)
    el.scrollLeft = (sl + cx) * k - cx
    el.scrollTop = (st + cy) * k - cy
  }

  // ---- 触摸手势：单指拖动（放大时）、双指捏合 ----
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ span: number; zoom: number; cx: number; cy: number; sl: number; st: number } | null>(null)
  const pan = useRef<{ x: number; y: number } | null>(null)

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = containerRef.current
    if (!el) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      const rect = el.getBoundingClientRect()
      pinch.current = {
        span: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        zoom: zoomRef.current,
        cx: (a.x + b.x) / 2 - rect.left,
        cy: (a.y + b.y) / 2 - rect.top,
        sl: el.scrollLeft,
        st: el.scrollTop,
      }
      pan.current = null
    } else if (pointers.current.size === 1 && zoomRef.current > 1) {
      pan.current = { x: e.clientX, y: e.clientY }
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pointers.current.get(e.pointerId)
    const el = containerRef.current
    if (!p || !el) return
    p.x = e.clientX
    p.y = e.clientY
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      const span = Math.hypot(a.x - b.x, a.y - b.y) || 1
      const g = pinch.current
      const next = clampZoom(g.zoom * (span / g.span))
      const k = next / g.zoom
      zoomRef.current = next
      setZoom(next)
      el.scrollLeft = (g.sl + g.cx) * k - g.cx
      el.scrollTop = (g.st + g.cy) * k - g.cy
    } else if (pan.current && pointers.current.size === 1) {
      el.scrollLeft -= e.clientX - pan.current.x
      el.scrollTop -= e.clientY - pan.current.y
      pan.current = { x: e.clientX, y: e.clientY }
    }
  }

  const endPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    if (pointers.current.size === 0) {
      pan.current = null
      // 捏合/平移结束：立即按最终尺寸重绘，不等防抖
      setRenderZoom(zoomRef.current)
    }
  }

  // 双击/双击触控：1x ↔ 2.5x，缩向点击处；iOS 双触可靠性差，用双 tap 间隔兜底
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null)
  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    zoomAt(zoomRef.current > 1 ? 1 : 2.5, cx, cy)
  }
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    endPointer(e)
    if (e.pointerType !== 'touch' || pointers.current.size > 0) return
    const now = Date.now()
    const el = containerRef.current
    if (lastTap.current && now - lastTap.current.t < 350 && el) {
      const rect = el.getBoundingClientRect()
      zoomAt(zoomRef.current > 1 ? 1 : 2.5, e.clientX - rect.left, e.clientY - rect.top)
      lastTap.current = null
    } else {
      lastTap.current = { t: now, x: e.clientX, y: e.clientY }
    }
  }

  // 桌面触控板捏合（Ctrl+滚轮）；React 的 wheel 是被动监听，这里用原生 + preventDefault
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      zoomAt(zoomRef.current * Math.exp(-e.deltaY * 0.015), e.clientX - rect.left, e.clientY - rect.top)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const doc = loaded && loaded.src === src ? loaded.doc : null
  const error = failed === src

  return (
    <div
      ref={containerRef}
      className="pdf-view"
      style={{ touchAction: zoom > 1 ? 'none' : 'pan-y', cursor: zoom > 1 ? 'grab' : 'default' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={endPointer}
      onDoubleClick={onDoubleClick}
    >
      {error ? (
        <p className="file-view-fallback">PDF 加载失败，请尝试下载后查看。</p>
      ) : !doc ? (
        <p className="file-view-fallback">正在加载 PDF…</p>
      ) : (
        Array.from({ length: doc.numPages }, (_, i) => (
          <PdfPage key={i} doc={doc} pageNumber={i + 1} renderWidth={width * renderZoom} zoom={zoom} />
        ))
      )}
    </div>
  )
}

function PdfPage({
  doc,
  pageNumber,
  renderWidth,
  zoom,
}: {
  doc: PDFDocumentProxy
  pageNumber: number
  renderWidth: number
  zoom: number
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(false)
  const [aspect, setAspect] = useState(0) // 高/宽，用于占位避免布局跳动

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    // 进出视口都更新：离开的页要释放位图，否则放大后所有页常驻内存直接 OOM
    const io = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)), {
      rootMargin: '100px',
    })
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

  // renderWidth 变化（容器宽度 / 缩放 settle）即重绘，保证任意倍率下文字清晰；
  // 像素总量超限（高倍放大）时按比例降 scale，超出的部分拉伸显示——宁微虚不崩溃。
  // 页离开视口时把 canvas 清零释放位图（aspect-ratio 样式占位不变，回视口会重绘）。
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (!visible || !renderWidth || !aspect) {
      canvas.width = 0
      canvas.height = 0
      return
    }
    let cancelled = false
    let renderTask: ReturnType<PDFPageProxy['render']> | null = null
    doc
      .getPage(pageNumber)
      .then((page) => {
        if (cancelled) return
        const base = page.getViewport({ scale: 1 })
        // 上限 3：iPhone 是 3x 屏，封顶 2 会导致文字发虚；再高内存/渲染耗时平方级上涨
        const dpr = Math.min(window.devicePixelRatio || 1, 3)
        let scale = (renderWidth / base.width) * dpr
        scale = Math.min(scale, Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height)))
        const viewport = page.getViewport({ scale })
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
  }, [visible, renderWidth, aspect, doc, pageNumber])

  return (
    <div
      ref={wrapRef}
      className="pdf-page"
      style={{
        aspectRatio: aspect ? `1 / ${aspect}` : undefined,
        // 缩放时页宽跟手势即时变化；canvas 重绘前会先被拉伸（settle 后恢复清晰）
        width: `${zoom * 100}%`,
        maxWidth: zoom * PAGE_MAX_WIDTH,
      }}
    >
      {aspect > 0 ? <canvas ref={canvasRef} /> : null}
    </div>
  )
}

type PDFPageProxy = Awaited<ReturnType<PDFDocumentProxy['getPage']>>
