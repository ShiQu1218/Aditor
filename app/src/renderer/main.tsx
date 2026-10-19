import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/tokens.css'
import './styles/base.css'
import './styles/langFonts.css'
import './styles/shell.css'
import './styles/libraryTokens.css'
import './styles/library.css'
import './styles/settings.css'
import './styles/onboarding.css'
import './styles/fonts.css'
import './styles/lowperf.css'
import App from './App'
import { installGlobalDropGuard } from './lib/dropGuard'
import { installPauseOnHide } from './lib/pauseOnHide'

// 拖入檔案時不讓 Chromium 導航離開 App（I2）
installGlobalDropGuard()
// 縮到系統匣時暫停播放（瀏覽器預覽沒有 preload API，略過）
const onWindowHidden = window.api?.app?.onWindowHidden
if (typeof onWindowHidden === 'function') installPauseOnHide(onWindowHidden)

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
