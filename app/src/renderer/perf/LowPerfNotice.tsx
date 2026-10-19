import React, { useEffect, useMemo, useState } from 'react'
import { AlertTriangle } from '../components/icons'
import { i18n } from '../i18n'
import { createLowPerfPrompt } from './lowPerfPrompt'

/** 首次啟動的低效能詢問（非模態、頁內）：偵測到無硬體解碼時顯示一次。 */
export function LowPerfNotice(): JSX.Element | null {
  const [visible, setVisible] = useState(false)
  const prompt = useMemo(
    () =>
      createLowPerfPrompt(
        {
          getSettings: async () => (await window.api?.settings?.get?.()) ?? { lowPerfAsked: true, lowPerfMode: false },
          setSettings: async (partial) => window.api?.settings?.set?.(partial),
          mediaCapabilities: typeof navigator !== 'undefined' ? navigator.mediaCapabilities : undefined
        },
        setVisible
      ),
    []
  )
  useEffect(() => {
    void prompt.start()
  }, [prompt])

  if (!visible) return null
  return (
    <div className="notice notice-info lowperf-notice" role="status">
      <AlertTriangle className="ic" aria-hidden="true" />
      <div className="notice-text">
        <strong>{i18n.lowPerf.askText}</strong>
      </div>
      <div className="notice-actions">
        <button type="button" className="btn-accent" onClick={() => void prompt.accept()}>
          {i18n.lowPerf.enable}
        </button>
        <button type="button" className="btn-ghost" onClick={() => void prompt.dismiss()}>
          {i18n.lowPerf.dismiss}
        </button>
      </div>
    </div>
  )
}
