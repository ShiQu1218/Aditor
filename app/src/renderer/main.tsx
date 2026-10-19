import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/tokens.css'
import './styles/base.css'
import './styles/langFonts.css'
import './styles/shell.css'
import './styles/libraryTokens.css'
import './styles/library.css'
import './styles/settings.css'
import './styles/fonts.css'
import './styles/lowperf.css'
import App from './App'
import { installGlobalDropGuard } from './lib/dropGuard'

// 拖入檔案時不讓 Chromium 導航離開 App（I2）
installGlobalDropGuard()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
