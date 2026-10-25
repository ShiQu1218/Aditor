import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle } from '../components/icons'
import { i18n } from '../i18n'
import { createLowPerfPrompt } from './lowPerfPrompt'

/** First-run low-performance prompt (non-modal, in-page); shown once when no hardware decoding is detected. */
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
