import { useState, type FormEvent } from 'react'
import { Droplet } from 'lucide-react'
import { supabase } from '../lib/supabase'
import './Auth.css'

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
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="auth-brand-mark">
            <Droplet size={26} strokeWidth={1.75} />
          </div>
          <h1 className="auth-title">InkFlow</h1>
          <p className="auth-tagline">本地优先 · 云同步</p>
        </div>
        <div className="auth-tabs">
          {(['signin', 'signup'] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => switchMode(m)}
              className={`auth-tab${mode === m ? ' active' : ''}`}
            >
              {m === 'signin' ? '登录' : '注册'}
            </button>
          ))}
        </div>
        <form onSubmit={handleSubmit} className="auth-form">
          <input
            type="email"
            required
            placeholder="邮箱"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="auth-input"
          />
          <input
            type="password"
            required
            minLength={6}
            placeholder="密码（至少 6 位）"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="auth-input"
          />
          {error && <p className="auth-error">{error}</p>}
          {notice && <p className="auth-notice">{notice}</p>}
          <button type="submit" disabled={loading} className="auth-submit">
            {loading ? '请稍候…' : mode === 'signin' ? '登录' : '注册'}
          </button>
        </form>
      </div>
    </div>
  )
}
