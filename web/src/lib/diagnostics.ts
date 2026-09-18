// 诊断信息收集：错误、未处理 rejection、长任务、主线程冻结。
// 正常情况只留在内存环形缓冲；出现严重事件（错误 / >3s 长任务 / >3s 冻结）时落 localStorage，
// 用户可通过顶栏"复制诊断"按钮导出。
interface DiagEvent {
  t: string
  kind: 'error' | 'rejection' | 'longtask' | 'freeze'
  detail: string
}

const STORAGE_KEY = 'inkflow:diagnostics'
const MAX_EVENTS = 50
const buffer: DiagEvent[] = []
let installed = false

function push(kind: DiagEvent['kind'], detail: string, severe: boolean) {
  buffer.push({ t: new Date().toISOString(), kind, detail: detail.slice(0, 500) })
  if (buffer.length > MAX_EVENTS) buffer.shift()
  if (severe) persist()
}

function persist() {
  try {
    const existing: DiagEvent[] = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    const merged = [...existing, ...buffer].slice(-MAX_EVENTS)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
  } catch {
    // localStorage 满/不可用则放弃持久化
  }
}

export function installDiagnostics(): void {
  if (installed) return
  installed = true

  window.addEventListener('error', (e) => {
    push('error', `${e.message} @ ${e.filename}:${e.lineno}`, true)
  })
  window.addEventListener('unhandledrejection', (e) => {
    push('rejection', String(e.reason), true)
  })

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration > 500) {
          push('longtask', `${Math.round(entry.duration)}ms`, entry.duration > 3000)
        }
      }
    }).observe({ entryTypes: ['longtask'] })
  } catch {
    // 浏览器不支持 longtask 则跳过
  }

  // rAF 看门狗：页面可见但 rAF 停摆 >3s 判定为冻结
  let rafCount = 0
  let lastSeen = 0
  let stalledSince: number | null = null
  const tick = () => {
    rafCount++
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  setInterval(() => {
    if (document.visibilityState !== 'visible') {
      lastSeen = rafCount
      stalledSince = null
      return
    }
    if (rafCount === lastSeen) {
      if (stalledSince === null) stalledSince = Date.now()
      else if (Date.now() - stalledSince > 3000) {
        push('freeze', `主线程冻结 >${Math.round((Date.now() - stalledSince) / 1000)}s`, true)
        stalledSince = Date.now() // 避免每次 tick 重复记
      }
    } else {
      lastSeen = rafCount
      stalledSince = null
    }
  }, 1000)
}

export function getDiagnostics(): string {
  let persisted: DiagEvent[] = []
  try {
    persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
  } catch {
    persisted = []
  }
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      url: location.href,
      currentSession: buffer,
      persisted,
    },
    null,
    2,
  )
}
