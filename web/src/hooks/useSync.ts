import { useCallback, useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import type { User } from '@supabase/supabase-js'
import { db } from '../lib/db'
import { syncEngine } from '../sync/syncEngine'
import type { SyncStatus } from '../components/SyncIndicator'

const PUSH_INTERVAL_MS = 5000
// 连续失败后的推送退避上限：从 5s 起步逐次翻倍（5→10→20→40→60），成功即复位
const PUSH_MAX_BACKOFF_MS = 60000
// 实时链路静默失效（网关掐空闲连接、移动网络切换后 WebSocket 假死等）时不会有
// 任何事件到达，靠周期性增量 pull 兜底
const PULL_INTERVAL_MS = 30000

// 本地有没有真正要推的东西（脏行或待传图片）。空闲时推送定时器直接跳过：
// 不发请求、不点亮「同步中」，指示器稳定停在「已同步」
async function hasPendingWork(): Promise<boolean> {
  const [noteCount, folderCount, fileCount, imageCount] = await Promise.all([
    db.notes.where('dirty').equals(1).count(),
    db.folders.where('dirty').equals(1).count(),
    db.files.where('dirty').equals(1).count(),
    db.images.where('dirty').equals(1).count(),
  ])
  return noteCount + folderCount + fileCount + imageCount > 0
}

export function useSync(user: User | null): { status: SyncStatus; requestPush: () => void } {
  const [online, setOnline] = useState(navigator.onLine)
  const [syncing, setSyncing] = useState(false)
  const [failed, setFailed] = useState(false)
  const busy = useRef(false)
  // 自排程的推送定时器 + 当前退避延时（失败翻倍、成功复位）
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pushDelay = useRef(PUSH_INTERVAL_MS)
  // schedulePush 与 push 互相引用，用最新引用 ref 解环，保证 user 变化后仍调到新闭包
  const pushRef = useRef<() => void>(() => {})

  const dirtyCount = useLiveQuery(async () => {
    const [noteCount, folderCount, fileCount] = await Promise.all([
      db.notes.where('dirty').equals(1).count(),
      db.folders.where('dirty').equals(1).count(),
      db.files.where('dirty').equals(1).count(),
    ])
    return noteCount + folderCount + fileCount
  }, [], 0)

  const schedulePush = useCallback(() => {
    if (pushTimer.current) clearTimeout(pushTimer.current)
    pushTimer.current = setTimeout(() => pushRef.current(), pushDelay.current)
  }, [])

  const push = useCallback(async () => {
    if (!user || !navigator.onLine || busy.current) return
    if (!(await hasPendingWork())) {
      // 空闲：不发请求不亮灯，按正常间隔继续下一轮
      pushDelay.current = PUSH_INTERVAL_MS
      schedulePush()
      return
    }
    busy.current = true
    setSyncing(true)
    try {
      await syncEngine.pushChanges(user.id)
      setFailed(false)
      pushDelay.current = PUSH_INTERVAL_MS
    } catch (err) {
      console.error('sync push failed', err)
      setFailed(true)
      pushDelay.current = Math.min(pushDelay.current * 2, PUSH_MAX_BACKOFF_MS)
    } finally {
      busy.current = false
      setSyncing(false)
      schedulePush()
    }
  }, [user, schedulePush])

  useEffect(() => {
    pushRef.current = () => void push()
  }, [push])

  // silent = 定时器兜底拉取：不点亮指示器（后台体检）；
  // 实时事件 / 回前台 / 断网恢复触发的拉取带指示（确实有或可能有变更要落地）
  const pull = useCallback(
    async (silent: boolean) => {
      if (!user || !navigator.onLine || busy.current) return
      busy.current = true
      if (!silent) setSyncing(true)
      try {
        await syncEngine.pullChanges(user.id)
        setFailed(false)
      } catch (err) {
        console.error('sync pull failed', err)
        setFailed(true)
      } finally {
        busy.current = false
        setSyncing(false)
      }
    },
    [user],
  )

  const requestPush = useCallback(() => {
    pushDelay.current = PUSH_INTERVAL_MS
    void push()
  }, [push])

  useEffect(() => {
    if (!user) return

    void (async () => {
      await pull(false)
      await push()
    })()

    const pullTimer = setInterval(() => void pull(true), PULL_INTERVAL_MS)
    const unsubscribe = syncEngine.subscribeChanges(user.id, () => void pull(false))

    const handleOnline = () => {
      setOnline(true)
      void (async () => {
        await pull(false)
        await push()
      })()
    }
    const handleOffline = () => setOnline(false)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    // 手机息屏/切后台时页面被冻结、WebSocket 随之断开，期间别端的修改事件全部
    // 丢失且 realtime 不会重放；回前台必须立刻补拉
    const handleVisible = () => {
      if (document.visibilityState !== 'visible') return
      void (async () => {
        await pull(false)
        await push()
      })()
    }
    document.addEventListener('visibilitychange', handleVisible)

    return () => {
      if (pushTimer.current) clearTimeout(pushTimer.current)
      clearInterval(pullTimer)
      unsubscribe()
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      document.removeEventListener('visibilitychange', handleVisible)
    }
  }, [user, push, pull])

  let status: SyncStatus = 'synced'
  if (!online) status = 'offline'
  else if (failed) status = 'error'
  else if (syncing) status = 'syncing'
  else if ((dirtyCount ?? 0) > 0) status = 'editing'

  return { status, requestPush }
}
