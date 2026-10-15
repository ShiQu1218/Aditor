import React from 'react'
import { EventType } from '../../shared/types'
import { formatTime } from '../../shared/time'
import { i18n } from '../i18n/zh-TW'
import { Pause, Play, SkipBack, SkipForward } from '../components/icons'
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
  onToggleFilter: (t: EventType) => void
}

/** 傳輸列：播放／上下事件／時間／速度、事件類型 chip（帶計數）、新增事件。 */
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
      <EventFilterChips counts={counts} filter={filter} onToggle={onToggleFilter} />
      <button type="button" className="btn-ghost" onClick={onAddEvent}>
        {t.addEvent} <kbd>M</kbd>
      </button>
    </div>
  )
}
