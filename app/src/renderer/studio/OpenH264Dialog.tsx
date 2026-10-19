import React from 'react'
import { i18n } from '../i18n'
import { OpenH264State } from './exportController'

export interface OpenH264DialogProps {
  state: OpenH264State
  onDecline: () => void
  onAccept: () => void
}

/** OpenH264 同意對話框（頁內，不用 window.confirm）：同意後才由呼叫端下載。 */
export function OpenH264Dialog({ state, onDecline, onAccept }: OpenH264DialogProps): JSX.Element {
  const t = i18n.export
  const downloading = state.step === 'downloading'
  const pct = Math.round(state.ratio * 100)
  return (
    <div className="xd-scrim">
      <div className="xd-consent" role="dialog" aria-modal="true" aria-labelledby="xd-h264-title" aria-describedby="xd-h264-desc">
        <h3 id="xd-h264-title">{t.h264Title}</h3>
        <div id="xd-h264-desc">
          <p className="xd-sub">{t.h264Why}</p>
          <p className="xd-muted">{t.h264License}</p>
          <p className="xd-muted">{t.h264Alt}</p>
        </div>
        {downloading && (
          <div className="xd-h264-prog">
            <div className="xd-bar" role="progressbar" aria-label={t.h264Title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
              <i style={{ width: `${pct}%` }} />
            </div>
            <div className="xd-muted">{t.h264Downloading.replace('{pct}', String(pct))}</div>
          </div>
        )}
        <div className="xd-live" aria-live="assertive" role="alert">
          {state.step === 'error' && <div className="xd-err-text">{t.h264Failed.replace('{msg}', state.error ?? '')}</div>}
        </div>
        <div className="xd-consent-foot">
          <button type="button" className="btn-ghost" onClick={onDecline} disabled={downloading}>
            {t.h264Decline}
          </button>
          <button type="button" className="btn-accent" onClick={onAccept} disabled={downloading}>
            {state.step === 'error' ? t.h264Retry : t.h264Accept}
          </button>
        </div>
      </div>
    </div>
  )
}
