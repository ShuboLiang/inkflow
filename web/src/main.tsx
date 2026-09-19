import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'lxgw-wenkai-webfont/lxgwwenkai-regular.css'
import './styles/tokens.css'
import './index.css'
import { Root } from './Root.tsx'
import { installDiagnostics } from './lib/diagnostics'

installDiagnostics()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
