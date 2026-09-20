import { supabase } from '../lib/supabase'

// 用户偏好：跨设备持久化的小设置（RLS 限定本人一行，prefs 是 JSONB 按需取键）。
// 目前只有 toolbarHidden——格式工具栏全局隐藏（任意笔记隐藏 = 所有笔记隐藏）。

export interface Prefs {
  toolbarHidden: boolean
}

export async function loadPrefs(): Promise<Prefs> {
  const { data } = await supabase.from('user_prefs').select('prefs').maybeSingle()
  const p = (data?.prefs ?? {}) as { toolbarHidden?: boolean }
  return { toolbarHidden: !!p.toolbarHidden }
}

export async function savePrefs(prefs: Prefs): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return
  await supabase.from('user_prefs').upsert(
    { user_id: user.id, prefs, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' },
  )
}
