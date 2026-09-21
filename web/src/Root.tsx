import { useEffect, useState } from 'react'
import App from './App.tsx'
import { SharePage } from './pages/SharePage.tsx'
import { setThemeAttr, storedTheme, DEFAULT_THEME } from './lib/theme'

function shareTokenFromHash(hash: string): string | null {
  const m = /^#\/s\/([^/]+)$/.exec(hash)
  return m ? decodeURIComponent(m[1]) : null
}

// hash 路由：#/s/<token> 走公开分享页（无需登录），其余进主应用
export function Root() {
  const [token, setToken] = useState(() => shareTokenFromHash(location.hash))
  useEffect(() => {
    const onHash = () => setToken(shareTokenFromHash(location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  // 公开分享页对任何访客都呈现默认纸面；回到主应用时恢复本机所选主题
  useEffect(() => {
    if (token) setThemeAttr(DEFAULT_THEME)
    else setThemeAttr(storedTheme() ?? DEFAULT_THEME)
  }, [token])
  return token ? <SharePage token={token} /> : <App />
}
