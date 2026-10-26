import { useEffect, useState } from 'react'
import { MAX_USER_REPORT_LENGTH } from '../../shared/telemetry'
import { settingsI18n } from '../i18n'
import { describedBy, type ControlIds } from './SettingControls'

const t = settingsI18n.row.report

type Phase = 'idle' | 'sending' | 'sent' | 'failed'

/** Manual problem report: sends free text through the main-process Sentry pipeline, so it needs diagnostics sharing on. */
export function ReportControl({ ids }: { ids: ControlIds }): JSX.Element {
  const [available, setAvailable] = useState(false)
  const [text, setText] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')

  useEffect(() => {
    void window.api?.telemetry?.enabled().then(setAvailable, () => setAvailable(false))
  }, [])

  const send = async (): Promise<void> => {
    setPhase('sending')
    let ok = false
    try {
      ok = (await window.api?.telemetry?.report(text)) === true
    } catch { /* surfaced through the failed state below */ }
    if (ok) setText('')
    setPhase(ok ? 'sent' : 'failed')
  }

  const statusId = `${ids.ctl}-status`
  const status = !available ? t.disabled : phase === 'sent' ? t.sent : phase === 'failed' ? t.failed : ''
  return (
    <div className="set-inline">
      <textarea
        id={ids.ctl}
        className="set-input"
        rows={3}
        maxLength={MAX_USER_REPORT_LENGTH}
        value={text}
        placeholder={t.placeholder}
        disabled={!available || phase === 'sending'}
        aria-describedby={describedBy(ids, statusId)}
        onChange={(e) => { setText(e.target.value); if (phase !== 'sending') setPhase('idle') }}
      />
      <button type="button" className="set-btn sm" disabled={!available || phase === 'sending' || !text.trim()} onClick={() => void send()}>
        {phase === 'sending' ? t.sending : t.send}
      </button>
      <span id={statusId} className={`set-value wrap${phase === 'failed' ? ' set-err' : ''}`} role="status" aria-live="polite">
        {status}
      </span>
    </div>
  )
}
