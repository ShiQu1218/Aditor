import React from 'react'
import type { LiveEvent, LiveMatch } from '../../shared/recording'
import { isCounted } from '../../shared/types'
import { formatTime } from '../../shared/time'
import { liveI18n as t } from '../i18n'
import { fill, pct, SEEK_STEP_SEC } from './liveModel'

interface LiveTimelineProps {
  current: number
  end: number
  retainStart: number
  events: LiveEvent[]
  matches: LiveMatch[]
  onSeek: (t: number) => void
  onJumpLive: () => void
}

/**
 * 錄影時間軸：對局起訖區段、事件標記（沿用事件形狀與顏色 token）、已釋放區段、播放頭。
 * 整條是一個 slider：←／→ 前後 5 秒、Home 到保留範圍起點、End 跳到最新；點擊或拖曳跳轉。
 */
export function LiveTimeline({ current, end, retainStart, events, matches, onSeek, onJumpLive }: LiveTimelineProps): JSX.Element {
  const seekFromPointer = (e: React.PointerEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    if (rect.width <= 0) return
    onSeek(((e.clientX - rect.left) / rect.width) * end)
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -SEEK_STEP_SEC : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? SEEK_STEP_SEC : 0
    if (step) onSeek(current + step)
    else if (e.key === 'Home') onSeek(retainStart)
    else if (e.key === 'End') onJumpLive()
    else return
    e.preventDefault()
    e.stopPropagation()
  }
  return (
    <div
      className="live-timeline"
      role="slider"
      tabIndex={0}
      aria-label={t.timeline}
      aria-valuemin={0}
      aria-valuemax={Math.round(end)}
      aria-valuenow={Math.round(current)}
      aria-valuetext={fill(t.timelineValue, { cur: formatTime(current), end: formatTime(end) })}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId)
        seekFromPointer(e)
      }}
      onPointerMove={(e) => { if (e.buttons === 1) seekFromPointer(e) }}
    >
      {retainStart > 0 && <div className="live-released" style={{ width: `${pct(retainStart, end)}%` }} title={t.released} />}
      {matches.map((m, i) => {
        const stop = m.end ?? end
        const label = fill(t.matchRange, { n: i + 1, start: formatTime(m.start), end: m.end === null ? t.matchOngoing : formatTime(m.end) })
        return (
          <div key={i} className={`live-match${m.end === null ? ' ongoing' : ''}`} title={label}
            style={{ left: `${pct(m.start, end)}%`, width: `${Math.max(0.3, pct(stop, end) - pct(m.start, end))}%` }} />
        )
      })}
      {events.map((e) => (
        <span key={e.id} className={`live-marker${isCounted(e) ? '' : ' uncounted'}`} data-type={e.type}
          style={{ left: `${pct(e.t, end)}%` }} aria-hidden="true" />
      ))}
      <div className="live-playhead" style={{ left: `${pct(current, end)}%` }} />
    </div>
  )
}
