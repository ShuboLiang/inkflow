import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'lxgw-wenkai-webfont/lxgwwenkai-regular.css'
import './styles/tokens.css'
import './styles/themes.css'
import './index.css'
import { Root } from './Root.tsx'
import { setThemeAttr, storedTheme, DEFAULT_THEME } from './lib/theme'

// 渲染前把主题写到 <html> 上，避免打开时先闪一下默认配色
setThemeAttr(storedTheme() ?? DEFAULT_THEME)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
