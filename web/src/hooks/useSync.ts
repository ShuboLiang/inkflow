import { useCallback, useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import type { User } from '@supabase/supabase-js'
import { db } from '../lib/db'
import { syncEngine } from '../sync/syncEngine'
import type { SyncStatus } from '../components/SyncIndicator'

const PUSH_INTERVAL_MS = 5000

export function useSync(user: User | null): { status: SyncStatus; requestPush: () => void } {
  const [online, setOnline] = useState(navigator.onLine)
  const [syncing, setSyncing] = useState(false)
  const busy = useRef(false)

  const dirtyCount = useLiveQuery(async () => {
    const [noteCount, folderCount, fileCount] = await Promise.all([
      db.notes.where('dirty').equals(1).count(),
      db.folders.where('dirty').equals(1).count(),
      db.files.where('dirty').equals(1).count(),
    ])
    return noteCount + folderCount + fileCount
  }, [], 0)

  const push = useCallback(async () => {
    if (!user || !navigator.onLine || busy.current) return
    busy.current = true
    setSyncing(true)
    try {
      await syncEngine.pushChanges(user.id)
    } catch (err) {
      console.error('sync push failed', err)
    } finally {
      busy.current = false
      setSyncing(false)
    }
  }, [user])

  const pull = useCallback(async () => {
    if (!user || !navigator.onLine || busy.current) return
    busy.current = true
    setSyncing(true)
    try {
      await syncEngine.pullChanges(user.id)
    } catch (err) {
      console.error('sync pull failed', err)
    } finally {
      busy.current = false
      setSyncing(false)
    }
  }, [user])

  const requestPush = useCallback(() => {
    void push()
  }, [push])

  useEffect(() => {
    if (!user) return

    void (async () => {
      await pull()
      await push()
    })()

    const timer = setInterval(() => void push(), PUSH_INTERVAL_MS)
    const unsubscribe = syncEngine.subscribeChanges(user.id, () => void pull())

    const handleOnline = () => {
      setOnline(true)
      void (async () => {
        await pull()
        await push()
      })()
    }
    const handleOffline = () => setOnline(false)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      clearInterval(timer)
      unsubscribe()
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [user, push, pull])

  let status: SyncStatus = 'synced'
  if (!online) status = 'offline'
  else if (syncing) status = 'syncing'
  else if ((dirtyCount ?? 0) > 0) status = 'editing'

  return { status, requestPush }
}
