import React from 'react'
import { EventType } from '../../shared/types'
import { formatTime } from '../../shared/time'
import { i18n } from '../i18n'
import { Pause, Play, Scissors, SkipBack, SkipForward, Sparkles } from '../components/icons'
import { EventFilterChips } from './EventFilterChips'

interface TransportBarProps {
  playing: boolean
  currentTime: number
  duration: number
  speed: number
  counts: Record<EventType, number>
  filter: Set<EventType>
  onTogglePlay: () => void
  onCycleSpeed: () => void
  onPrevEvent: () => void
  onNextEvent: () => void
  onAddEvent: () => void
  onQuick: () => void
  bladeMode: boolean
  onAutoClip: () => void
  autoClipOpen: boolean
  onToggleFilter: (t: EventType) => void
}

  /** Transport bar: playback, previous/next event, time/speed, quick clip/AI, event-type chips with counts, and add event. */
export function TransportBar({
  playing,
  currentTime,
  duration,
  speed,
  counts,
  filter,
  onTogglePlay,
  onCycleSpeed,
  onPrevEvent,
  onNextEvent,
  onAddEvent,
  onQuick,
  bladeMode,
  onAutoClip,
  autoClipOpen,
  onToggleFilter
}: TransportBarProps): JSX.Element {
  const t = i18n.studio.transport
  return (
    <div className="transport">
      <button type="button" className="play-btn" aria-label={playing ? t.pause : t.play} onClick={onTogglePlay}>
        {playing ? <Pause className="ic" /> : <Play className="ic" />}
      </button>
      <button type="button" className="icon-btn" aria-label={t.prevEvent} onClick={onPrevEvent}>
        <SkipBack className="ic" />
      </button>
      <button type="button" className="icon-btn" aria-label={t.nextEvent} onClick={onNextEvent}>
        <SkipForward className="ic" />
      </button>
      <span className="transport-time mono">
        {formatTime(currentTime)} / {formatTime(duration)}
      </span>
      <button type="button" className="speed-btn mono" onClick={onCycleSpeed}>
        {speed}x
      </button>
      <div className="transport-spacer" />
      <button
        type="button"
        className="btn-ghost"
        aria-pressed={bladeMode}
        title={i18n.timeline.bladeHint}
        onClick={onQuick}
      >
        <Scissors className="ic sm" /> {i18n.studio.quickClip} <kbd>{i18n.studio.quickClipKey}</kbd>
      </button>
      <button
        type="button"
        className="btn-ghost"
        data-autoclip="toggle"
        aria-haspopup="dialog"
        aria-expanded={autoClipOpen}
        onClick={onAutoClip}
      >
        <Sparkles className="ic sm" /> {i18n.studio.autoClip}
      </button>
      <EventFilterChips counts={counts} filter={filter} onToggle={onToggleFilter} />
      <button type="button" className="btn-ghost" onClick={onAddEvent}>
        {t.addEvent} <kbd>M</kbd>
      </button>
    </div>
  )
}
