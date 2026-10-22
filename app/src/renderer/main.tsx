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
import { initializeRendererTelemetry } from './telemetry'

// Prevent Chromium from navigating away from the app when files are dropped (I2).
installGlobalDropGuard()
// Pause playback when hidden or minimized (skip browser previews, which do not have the preload API).
const onWindowHidden = window.api?.app?.onWindowHidden
if (typeof onWindowHidden === 'function') installPauseOnHide(onWindowHidden)

void initializeRendererTelemetry().finally(() => ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
))
