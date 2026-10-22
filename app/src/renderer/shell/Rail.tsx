import React from 'react'
import { LayoutGrid, Film, Video, Keyboard, SlidersHorizontal, Download, LogoMark } from '../components/icons'
import { QueueRing } from './QueueRing'
import { shellI18n } from '../i18n'
import { recordingI18n } from '../i18n'
import type { RecordingPhase } from '../../shared/recording'
import type { UpdateNotice } from './updateNotice'
import './recording.css'

export type RailView = 'library' | 'studio' | 'settings'

interface RailProps {
  /** Current page. */
  active: RailView | null
  projectCount: number
  onNavigate: (v: RailView) => void
  onShortcuts?: () => void
  onQueue?: () => void
  /** Whether the queue popover is open (aria-expanded). */
  queueOpen?: boolean
  /** Exclude the trigger button when the queue popover checks for outside clicks. */
  queueButtonRef?: React.Ref<HTMLButtonElement>
  recordingPhase?: RecordingPhase
  onRecording?: () => void
  /** A newer version available/downloading/downloaded, or an update that failed after one was seen; null when none. */
  updateNotice?: UpdateNotice
}

export function Rail({ active, projectCount, onNavigate, onShortcuts, onQueue, queueOpen = false, queueButtonRef, recordingPhase = 'idle', onRecording, updateNotice = null }: RailProps): JSX.Element {
  const t = shellI18n.rail
  const updateFailed = updateNotice?.kind === 'failed'
  const updateLabel = updateNotice === null
    ? null
    : updateNotice.kind === 'available'
      ? t.updateAvailable.replace('{version}', updateNotice.version)
      : t.updateFailed
  const btn = (view: RailView, tip: string, label: string, icon: JSX.Element, badge?: number) => (
    <button
      className={`rail-btn${active === view ? ' active' : ''}`}
      data-tip={tip}
      aria-label={label}
      aria-current={active === view ? 'page' : undefined}
      onClick={() => onNavigate(view)}
    >
      {icon}
      {badge ? <span className="badge">{badge}</span> : null}
    </button>
  )
  return (
    <nav className="rail" aria-label={t.mainNav}>
      <LogoMark className="logo" />
      {btn('library', t.library, t.library, <LayoutGrid className="ic lg" />)}
      {btn('studio', t.studio, t.studioLabel, <Film className="ic lg" />, projectCount)}
      <button type="button" className="rail-btn" data-tip={recordingI18n.title}
        aria-label={recordingPhase === 'recording' || recordingPhase === 'error' ? recordingI18n.phases[recordingPhase] : recordingI18n.title}
        aria-haspopup="dialog" onClick={onRecording}>
        <Video className="ic lg" />
        {(recordingPhase === 'recording' || recordingPhase === 'error') && <span className={`rec-dot${recordingPhase === 'error' ? ' error' : ''}`} aria-hidden="true" />}
      </button>
      <div className="rail-spacer" />
      {updateLabel !== null && (
        <button
          type="button"
          className="rail-btn"
          data-tip={updateLabel}
          aria-label={updateLabel}
          onClick={() => onNavigate('settings')}
        >
          <Download className="ic lg" />
          <span className={`update-dot${updateFailed ? ' failed' : ''}`} aria-hidden="true" />
        </button>
      )}
      <button
        className="rail-btn"
        data-tip={t.queue}
        aria-label={t.queue}
        aria-haspopup="dialog"
        aria-expanded={queueOpen}
        ref={queueButtonRef}
        onClick={onQueue}
      >
        <QueueRing />
      </button>
      <button
        type="button"
        className="rail-btn"
        data-tip={t.shortcuts}
        aria-label={t.shortcutsLabel}
        aria-haspopup="dialog"
        onClick={onShortcuts}
      >
        <Keyboard className="ic lg" />
      </button>
      {btn('settings', t.settings, t.settings, <SlidersHorizontal className="ic lg" />)}
    </nav>
  )
}
