import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'

type Mode = 'signin' | 'signup'

export function Auth() {
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setNotice(null)
    try {
      if (mode === 'signin') {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password })
        if (err) throw err
      } else {
        const { data, error: err } = await supabase.auth.signUp({ email, password })
        if (err) throw err
        if (data.session) return // auto-confirmed, onAuthStateChange takes over
        // No session: email confirmation is enabled, or signup needs a retry.
        // Try signing in directly in case the instance auto-confirms without a session.
        const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password })
        if (signInErr) {
          setNotice('注册成功，请查收验证邮件后再登录（本地开发可开启 ENABLE_EMAIL_AUTOCONFIRM 跳过验证）。')
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  const switchMode = (next: Mode) => {
    setMode(next)
    setError(null)
    setNotice(null)
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>InkFlow</h1>
        <div style={styles.tabs}>
          {(['signin', 'signup'] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => switchMode(m)}
              style={{
                ...styles.tab,
                ...(mode === m ? styles.tabActive : {}),
              }}
            >
              {m === 'signin' ? '登录' : '注册'}
            </button>
          ))}
        </div>
        <form onSubmit={handleSubmit} style={styles.form}>
          <input
            type="email"
            required
            placeholder="邮箱"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={styles.input}
          />
          <input
            type="password"
            required
            minLength={6}
            placeholder="密码（至少 6 位）"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={styles.input}
          />
          {error && <p style={styles.error}>{error}</p>}
          {notice && <p style={styles.notice}>{notice}</p>}
          <button type="submit" disabled={loading} style={styles.submit}>
            {loading ? '请稍候…' : mode === 'signin' ? '登录' : '注册'}
          </button>
        </form>
      </div>
    </div>
  )
}

// 登录页跟随主题：内联样式里引用 CSS 变量（与主应用共用一套令牌）
const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--paper)',
    color: 'var(--ink-900)',
    fontFamily: 'var(--font-ui)',
  },
  card: {
    width: 340,
    padding: 32,
    background: 'var(--surface)',
    borderRadius: 'var(--radius)',
    boxShadow: '0 4px 24px color-mix(in srgb, var(--ink-900) 8%, transparent)',
  },
  title: {
    margin: '0 0 20px',
    textAlign: 'center',
    fontSize: 22,
    fontFamily: 'var(--font-note)',
  },
  tabs: { display: 'flex', marginBottom: 20, borderBottom: '1px solid var(--ink-200)' },
  tab: {
    flex: 1,
    padding: '8px 0',
    border: 'none',
    background: 'none',
    cursor: 'pointer',
    fontSize: 14,
    color: 'var(--ink-500)',
    borderBottom: '2px solid transparent',
  },
  tabActive: { color: 'var(--ink-900)', fontWeight: 600, borderBottomColor: 'var(--qing)' },
  form: { display: 'flex', flexDirection: 'column', gap: 12 },
  input: {
    padding: '10px 12px',
    border: '1px solid var(--ink-200)',
    borderRadius: 'var(--radius-s)',
    background: 'var(--paper)',
    color: 'var(--ink-900)',
    fontSize: 14,
  },
  submit: {
    padding: '10px 0',
    border: 'none',
    borderRadius: 'var(--radius-s)',
    background: 'var(--qing)',
    color: 'var(--paper)',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },
  error: { margin: 0, fontSize: 13, color: 'var(--danger)' },
  notice: { margin: 0, fontSize: 13, color: 'var(--qing)' },
}
