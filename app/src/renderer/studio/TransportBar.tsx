import React from 'react'
import { EventType } from '../../shared/types'
import { formatTime } from '../../shared/time'
import { i18n } from '../i18n'
import { Pause, Play, Scissors, SkipBack, SkipForward, Sparkles, Volume2, VolumeX } from '../components/icons'
import { EventFilterChips } from './EventFilterChips'

interface TransportBarProps {
  playing: boolean
  currentTime: number
  duration: number
  speed: number
  volume: number
  muted: boolean
  audioDisabled: boolean
  onVolumeChange: (volume: number) => void
  onToggleMute: () => void
  counts: Record<EventType, number>
  /** Event types shown as filter chips for this video's game. */
  chipTypes?: EventType[]
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
  volume,
  muted,
  audioDisabled,
  onVolumeChange,
  onToggleMute,
  counts,
  chipTypes,
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
      <div className="preview-volume">
        <button type="button" className="icon-btn" aria-label={muted || volume === 0 ? t.unmute : t.mute}
          aria-pressed={muted || volume === 0} disabled={audioDisabled} onClick={onToggleMute}>
          {muted || volume === 0 ? <VolumeX className="ic" aria-hidden="true" /> : <Volume2 className="ic" aria-hidden="true" />}
        </button>
        <input type="range" min={0} max={100} step={1} value={volume} disabled={audioDisabled}
          aria-label={t.volume} aria-valuetext={`${volume}%`}
          onChange={(e) => onVolumeChange(Number(e.currentTarget.value))} />
        <span className="mono">{volume}%</span>
      </div>
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
      <EventFilterChips counts={counts} filter={filter} onToggle={onToggleFilter} types={chipTypes} />
      <button type="button" className="btn-ghost" onClick={onAddEvent}>
        {t.addEvent} <kbd>M</kbd>
      </button>
    </div>
  )
}
