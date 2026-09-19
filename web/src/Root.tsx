import { useEffect, useState } from 'react'
import App from './App.tsx'
import { SharePage } from './pages/SharePage.tsx'

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
  return token ? <SharePage token={token} /> : <App />
}
