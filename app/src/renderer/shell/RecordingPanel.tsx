import { useEffect, useRef, useState } from 'react'
import { useFocusTrap } from '../a11y/useFocusTrap'
import { X } from '../components/icons'
import { recordingI18n as t } from '../i18n'
import { formatBytes } from '../settings/settingsModel'
import { useRecordingStatus } from './useRecordingStatus'
import './recording.css'
import { tr } from '../../shared/locale'

function elapsedTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60].map((n) => String(n).padStart(2, '0')).join(':')
}

export function RecordingPanel({ onClose, onWatchLive }: { onClose: () => void; onWatchLive?: () => void }): JSX.Element {
  const { status, error, refresh } = useRecordingStatus()
  const [now, setNow] = useState(Date.now)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  useFocusTrap(boxRef, { onEscape: onClose, initialFocus: () => closeRef.current })
  useEffect(() => {
    if (status.phase !== 'recording') return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [status.phase, status.startedAt])
  const seconds = status.phase === 'recording' && status.startedAt !== null
    ? (now - status.startedAt) / 1000 : status.durationSec
  const run = async (action: 'start' | 'stop' | 'pause', paused?: boolean): Promise<void> => {
    const api = window.api?.recording
    if (!api || busy) return
    setBusy(true)
    setActionError(null)
    try {
      if (action === 'start') {
        if (!await api.startManual()) {
          // Show the failure reason (such as a recorder error) first; report that Apex was not found only when there is no error.
          const latest = await api.getStatus()
          setActionError(latest.error?.message ?? t.apexNotRunning)
        }
      } else if (action === 'stop') await api.stopManual()
      else await api.setPaused(paused!)
      await refresh()
    } catch (err) {
      setActionError(err instanceof Error ? `${t.actionFailed} ${err.message}` : t.actionFailed)
    } finally {
      setBusy(false)
    }
  }
  const rows: Array<[string, string | number]> = [
    [t.statusTitle, status.phase === 'recording' ? status.detectionOnly ? t.detectionOnly : status.backend === 'obs' ? status.obsRecording === false ? t.obsStandby : t.obsRecording : t.phases[status.phase] : t.phases[status.phase]],
    [t.elapsed, elapsedTime(seconds)],
    [t.segments, status.segments],
    [t.actualEncoder, status.encoder ?? t.unknown],
    [t.resolution, status.width !== null && status.height !== null ? `${status.width} × ${status.height}` : t.unknown],
    [t.dropped, status.droppedFrames],
    [t.matchIndex, status.matchIndex ?? '—'],
    [t.kills, status.kills],
    [t.diskFree, status.diskFreeBytes === null ? t.unknown : formatBytes(status.diskFreeBytes)]
  ]
  return (
    <div ref={boxRef} className="sc-dialog rec-panel" role="dialog" aria-modal="true" aria-labelledby="rec-title">
      <header className="sc-head">
        <h2 id="rec-title">{t.statusTitle}</h2>
        <button ref={closeRef} type="button" className="icon-btn" aria-label={t.close} onClick={onClose}><X className="ic" /></button>
      </header>
      <div className="sc-body">
        <dl className="rec-details">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        {(actionError || error || status.error) && <p className="rec-error" role="alert">{actionError ?? error ?? tr('{code}：{message}', { code: status.error?.code, message: status.error?.message })}</p>}
        <div className="rec-actions">
          <button type="button" className="lib-btn" disabled={busy || !!error || !['idle', 'error'].includes(status.phase)} onClick={() => void run('start')}>{t.start}</button>
          <button type="button" className="lib-btn" disabled={busy || !!error || !['starting', 'recording'].includes(status.phase)} onClick={() => void run('stop')}>{t.stop}</button>
          {onWatchLive && (
            <button type="button" className="lib-btn primary" disabled={status.phase !== 'recording'}
              title={status.phase === 'recording' ? undefined : t.watchLiveHint} onClick={onWatchLive}>{t.watchLive}</button>
          )}
          <label className="rec-pause"><input type="checkbox" checked={status.paused} disabled={busy || !!error} onChange={(e) => void run('pause', e.target.checked)} />{t.pauseAuto}</label>
        </div>
      </div>
    </div>
  )
}
