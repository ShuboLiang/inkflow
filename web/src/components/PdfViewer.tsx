import { useEffect, useMemo, useRef } from 'react'

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

export interface PdfSavedState {
  page: number
  zoom: string | number
  scrollLeft: number
  scrollTop: number
  rotation?: number
}

interface PDFLocation {
  pageNumber?: number
  scale?: number | string
  left?: number
  top?: number
  rotation?: number
}

interface PDFViewerApp {
  initializedPromise?: Promise<void>
  pdfViewer?: {
    pagesRotation?: number
    _location?: PDFLocation
  }
  eventBus?: {
    on: (name: string, listener: (evt: { location?: PDFLocation }) => void) => void
    off: (name: string, listener: (evt: { location?: PDFLocation }) => void) => void
  }
}

function getStorageKey(fileId?: string, src?: string): string | null {
  if (fileId) return `inkflow:pdf:${fileId}`
  if (!src) return null
  let h = 0
  for (let i = 0; i < Math.min(src.length, 500); i++) {
    h = (Math.imul(31, h) + src.charCodeAt(i)) | 0
  }
  return `inkflow:pdf:src_${Math.abs(h)}`
}

function loadSavedState(key: string | null): PdfSavedState | null {
  if (!key) return null
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PdfSavedState>
    if (typeof parsed?.page === 'number' && parsed.page >= 1) {
      return {
        page: parsed.page,
        zoom: parsed.zoom ?? 'page-width',
        scrollLeft: Number(parsed.scrollLeft) || 0,
        scrollTop: Number(parsed.scrollTop) || 0,
        rotation: typeof parsed.rotation === 'number' ? parsed.rotation : 0,
      }
    }
  } catch {
    // 忽略解析错误
  }
  return null
}

function savePdfState(key: string | null, state: PdfSavedState) {
  if (!key) return
  try {
    localStorage.setItem(key, JSON.stringify(state))
  } catch {
    // 忽略存储超限异常
  }
}

function buildInitialHash(saved: PdfSavedState | null): string {
  if (!saved) {
    // 默认视角：适合页宽，不展开目录侧边栏（解决移动端/桌面端默认 page-fit 过小问题）
    return '#zoom=page-width&pagemode=none'
  }
  let zoomParam = 'page-width'
  if (saved.zoom) {
    if (typeof saved.zoom === 'number') {
      zoomParam = saved.zoom <= 10 ? String(Math.round(saved.zoom * 100)) : String(Math.round(saved.zoom))
    } else if (saved.zoom === 'page-fit') {
      zoomParam = 'Fit'
    } else {
      zoomParam = String(saved.zoom)
    }
  }
  const x = Math.round(saved.scrollLeft || 0)
  const y = Math.round(saved.scrollTop || 0)
  return `#page=${saved.page}&zoom=${zoomParam},${x},${y}&pagemode=none`
}

export function PdfViewer({ src, fileId }: { src: string; fileId?: string }) {
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

  const storageKey = useMemo(() => getStorageKey(fileId, src), [fileId, src])
  const savedState = useMemo(() => loadSavedState(storageKey), [storageKey])
  const initialHash = useMemo(() => buildInitialHash(savedState), [savedState])

  const viewerUrl = fileUrl
    ? `${import.meta.env.BASE_URL}pdfjs/viewer/web/viewer.html?file=${encodeURIComponent(fileUrl)}${initialHash}`
    : null

  const latestStateRef = useRef<PdfSavedState | null>(savedState)
  const saveTimerRef = useRef<number | null>(null)

  const scheduleSave = (state: PdfSavedState) => {
    latestStateRef.current = state
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current)
    }
    saveTimerRef.current = window.setTimeout(() => {
      savePdfState(storageKey, state)
      saveTimerRef.current = null
    }, 400)
  }

  // 离开组件或窗口关闭时，同步冲刷当前最新阅读进度
  useEffect(() => {
    const handleBeforeUnload = () => {
      const win = frameRef.current?.contentWindow as (Window & { PDFViewerApplication?: PDFViewerApp }) | null
      const loc = win?.PDFViewerApplication?.pdfViewer?._location
      if (loc?.pageNumber && storageKey) {
        savePdfState(storageKey, {
          page: loc.pageNumber,
          zoom: loc.scale ?? 'page-width',
          scrollLeft: Math.round(loc.left ?? 0),
          scrollTop: Math.round(loc.top ?? 0),
          rotation: loc.rotation ?? 0,
        })
      } else if (latestStateRef.current && storageKey) {
        savePdfState(storageKey, latestStateRef.current)
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      handleBeforeUnload()
    }
  }, [storageKey])

  const handleFrameLoad = (e: React.SyntheticEvent<HTMLIFrameElement>) => {
    const iframe = e.currentTarget
    const doc = iframe.contentDocument
    if (doc) void injectFontAliases(doc)

    const win = iframe.contentWindow as (Window & { PDFViewerApplication?: PDFViewerApp }) | null
    if (win?.PDFViewerApplication) {
      const app = win.PDFViewerApplication
      void (async () => {
        try {
          if (app.initializedPromise) {
            await app.initializedPromise
          }
          // 恢复旋转（若有且非 0）
          if (savedState?.rotation && app.pdfViewer && app.pdfViewer.pagesRotation !== savedState.rotation) {
            app.pdfViewer.pagesRotation = savedState.rotation
          }
          const onUpdateViewarea = (evt: { location?: PDFLocation }) => {
            const loc = evt?.location
            if (!loc || !loc.pageNumber) return
            scheduleSave({
              page: loc.pageNumber,
              zoom: loc.scale ?? 'page-width',
              scrollLeft: Math.round(loc.left ?? 0),
              scrollTop: Math.round(loc.top ?? 0),
              rotation: loc.rotation ?? 0,
            })
          }
          app.eventBus?.on('updateviewarea', onUpdateViewarea)
        } catch {
          // 容错处理
        }
      })()
    }
  }

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
      onLoad={handleFrameLoad}
    />
  )
}
