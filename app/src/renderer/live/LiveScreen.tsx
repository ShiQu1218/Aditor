import React, { useCallback, useEffect, useRef, useState } from 'react'
import { isCounted } from '../../shared/types'
import { formatTime } from '../../shared/time'
import { ChevronLeft, Pause, Play, SkipBack, SkipForward } from '../components/icons'
import { i18n, liveI18n as t, recordingI18n as rt } from '../i18n'
import { useOptionalOverlay } from '../shell/OverlayHost'
import { useRecordingStatus } from '../shell/useRecordingStatus'
import { LIVE_EDGE_OFFSET, RETAIN_SEC } from './liveBuffer'
import { EVENT_LEAD_SEC, fill, liveEnd, SEEK_STEP_SEC } from './liveModel'
import { LiveTimeline } from './LiveTimeline'
import { useLivePlayer } from './useLivePlayer'
import { useLiveState } from './useLiveState'
import '../styles/live.css'
import { tr } from '../../shared/locale'

export interface LiveScreenProps {
  onBack: () => void
/** Open the output file in the studio after recording ends. */
  onOpenVideo: (path: string) => void
  onOpenLibrary: () => void
}

const typeName = (type: string): string => (i18n.timeline.types as Record<string, string>)[type] ?? type

/** Global shortcuts do not handle inputs, editable regions, or Space/Enter on buttons (the button handles those itself). */
function ignoreKey(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return true
  const target = e.target instanceof Element ? e.target : null
  if (target?.closest('input, textarea, select, [contenteditable="true"], [role="slider"]')) return true
  return (e.key === ' ' || e.key === 'Enter') && !!target?.closest('button, a')
}

/**
 * Watch an active recording (plan 7): play while recording via MSE, with a live event list and timeline (event markers and match segments).
 * StudioScreen is not reused because it assumes a fixed video duration; after recording ends, open the video in the studio from the library as usual.
 */
export function LiveScreen({ onBack, onOpenVideo, onOpenLibrary }: LiveScreenProps): JSX.Element {
  const live = useLiveState()
  const { status } = useRecordingStatus()
  const overlay = useOptionalOverlay()
  const state = live.state
  const obs = status.backend === 'obs'
  const end = state ? liveEnd(state) : 0
  const retainStart = Math.max(state?.segments[0]?.pts ?? 0, end - RETAIN_SEC)
  const boundsRef = useRef({ start: retainStart, end })
  boundsRef.current = { start: retainStart, end }
  const bounds = useCallback(() => boundsRef.current, [])
  const player = useLivePlayer({ sessionId: obs ? null : state?.sessionId ?? null, mime: obs ? null : state?.mime ?? null, segments: obs ? [] : state?.segments ?? [], bounds })
  const { addSegment, seek, togglePlay, jumpLive, current } = player
  useEffect(() => {
    live.onSegment.current = obs ? null : addSegment
    return () => { live.onSegment.current = null }
  }, [live.onSegment, addSegment, obs])

  const sameSession = state !== null && status.sessionId === state.sessionId
  // The status snapshot may arrive after the live snapshot; recording ends only after this job's status has been observed and then removed.
  const [seen, setSeen] = useState(false)
  useEffect(() => { if (sameSession) setSeen(true) }, [sameSession])
  const ended = live.finalized !== null || (seen && !sameSession)
  const currentRef = useRef(current)
  currentRef.current = current

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (obs || ignoreKey(e) || overlay?.isOpen) return
      if (e.key === ' ' || e.key === 'k' || e.key === 'K') togglePlay()
      else if (e.key === 'ArrowLeft') seek(currentRef.current - SEEK_STEP_SEC)
      else if (e.key === 'ArrowRight') seek(currentRef.current + SEEK_STEP_SEC)
      else if (e.key === 'End') jumpLive()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, seek, jumpLive, overlay?.isOpen, obs])

  const atLive = end - current <= LIVE_EDGE_OFFSET + 2
  const events = state?.events ?? []
  const killLabel = live.latestKill ? fill(t.newKill, { type: typeName(live.latestKill.type), time: formatTime(live.latestKill.t) }) : ''
  const finalPath = live.finalized?.[0]

  let message: JSX.Element | null = null
  if (live.load === 'loading') message = <div className="live-message">{t.loading}</div>
  else if (live.load === 'none') message = (
    <div className="live-message">
      <p>{t.notRecording}</p>
      <div className="live-message-actions"><button type="button" className="lib-btn" onClick={onBack}>{t.back}</button></div>
    </div>
  )
  else if (sameSession && status.phase === 'error' && status.error) message = (
    <div className="live-message error" role="alert">
      <p>{tr('{code}：{message}', { code: status.error.code, message: status.error.message })}</p>
      <div className="live-message-actions"><button type="button" className="lib-btn" onClick={onOpenLibrary}>{t.openLibrary}</button></div>
    </div>
  )
  else if (ended) message = (
    <div className="live-message" role="status">
      <p>{t.ended}</p>
      <div className="live-message-actions">
        {finalPath
          ? <button type="button" className="lib-btn primary" onClick={() => onOpenVideo(finalPath)}>{t.openStudio}</button>
          : <button type="button" className="lib-btn primary" onClick={onOpenLibrary}>{t.openLibrary}</button>}
      </div>
    </div>
  )
  else if (obs) message = <div className="live-message" role="status">{status.detectionOnly ? t.detectionOnly : status.obsRecording === false ? rt.obsStandby : t.obsRecording}</div>
  else if (player.error?.kind === 'unsupported') message = <div className="live-message error" role="alert">{fill(t.unsupported, { mime: player.error.mime })}</div>
  else if (player.error?.kind === 'load') message = <div className="live-message error" role="alert">{fill(t.loadFailed, { message: player.error.message })}</div>
  else if (state && !state.mime) message = <div className="live-message">{t.waitingInit}</div>

  return (
    <section className="live-screen" aria-labelledby="live-title">
      <header className="live-head">
        <button type="button" className="icon-btn" aria-label={t.back} onClick={onBack}><ChevronLeft className="ic" /></button>
        <h1 id="live-title">{t.title}</h1>
        <div className="live-badges">
          {sameSession && status.phase === 'recording' && <span className="live-badge rec">{status.detectionOnly ? rt.detectionOnly : obs ? status.obsRecording === false ? rt.obsStandby : rt.obsRecording : t.recording}</span>}
          <span className="live-badge">{sameSession && status.matchIndex !== null ? fill(t.match, { n: status.matchIndex }) : t.noMatch}</span>
          <span className="live-badge">{fill(t.kills, { n: sameSession ? status.kills : 0 })}</span>
        </div>
      </header>
      <div className="live-main">
        <div className="live-stage">
          {!obs && <video ref={player.videoRef} aria-label={t.video} playsInline />}
          {message}
        </div>
        {!obs && (
          <>
            <div className="live-controls">
              <button type="button" className="icon-btn" aria-label={player.playing ? t.pause : t.play} onClick={togglePlay} disabled={!state}>
                {player.playing ? <Pause className="ic" /> : <Play className="ic" />}
              </button>
              <button type="button" className="icon-btn" aria-label={t.back5} onClick={() => seek(current - SEEK_STEP_SEC)} disabled={!state}><SkipBack className="ic" /></button>
              <button type="button" className="icon-btn" aria-label={t.forward5} onClick={() => seek(current + SEEK_STEP_SEC)} disabled={!state}><SkipForward className="ic" /></button>
              <button type="button" className="lib-btn sm" onClick={jumpLive} disabled={!state || atLive}>{atLive ? t.atLive : t.jumpLive}</button>
              <span className="live-time">{fill(t.time, { cur: formatTime(current), end: formatTime(end) })}</span>
              <span className="live-keys">{t.keys}</span>
            </div>
            <LiveTimeline current={current} end={end} retainStart={retainStart} events={events}
              matches={state?.matches ?? []} onSeek={seek} onJumpLive={jumpLive} />
            {retainStart > 0 && <p className="live-released-note">{t.released}</p>}
          </>
        )}
      </div>
      <aside className="live-aside" aria-labelledby="live-events-title">
        <h2 id="live-events-title">{t.events}</h2>
        {events.length === 0
          ? <p className="live-empty">{t.noEvents}</p>
          : (
            <ul className="live-events">
              {[...events].reverse().map((e) => {
                const counted = isCounted(e)
                const label = fill(t.eventItem, { type: typeName(e.type), time: formatTime(e.t) }) + (counted ? '' : t.uncounted)
                return (
                  <li key={e.id}>
                    <button type="button" aria-label={label} disabled={obs} onClick={() => seek(e.t - EVENT_LEAD_SEC)}>
                      <span className={`live-glyph${counted ? '' : ' uncounted'}`} data-type={e.type} aria-hidden="true" />
                      <span className={counted ? undefined : 'uncounted-text'}>{label}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
      </aside>
      <div className="sr-only-live" aria-live="polite" aria-atomic="true">{killLabel}</div>
    </section>
  )
}
