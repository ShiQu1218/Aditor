import React, { useState } from 'react'
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
 * Recording timeline: match segments, event markers (reusing event shapes and color tokens), released ranges, and playhead.
 * The whole timeline is one slider: Left/Right move by 5 seconds, Home goes to the retained range start, and End jumps live; click or drag to seek.
 */
export function LiveTimeline({ current, end, retainStart, events, matches, onSeek, onJumpLive }: LiveTimelineProps): JSX.Element {
  const [drag, setDrag] = useState<{ pointerId: number; fraction: number } | null>(null)
  /** Fraction of the full timeline width under the pointer; null when the timeline has no width to seek in. */
  const fractionFromPointer = (e: React.PointerEvent<HTMLDivElement>): number | null => {
    const rect = e.currentTarget.getBoundingClientRect()
    if (rect.width <= 0) return null
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  }
  /** Clamp the drag preview to the retained range; the player resolves pruned gaps on release. */
  const seekTarget = (fraction: number): number => {
    const time = fraction * end
    return Math.min(Math.max(time, retainStart), Math.max(retainStart, end - 0.1))
  }
  const displayTime = drag ? seekTarget(drag.fraction) : current
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
      aria-valuenow={Math.round(displayTime)}
      aria-valuetext={fill(t.timelineValue, { cur: formatTime(displayTime), end: formatTime(end) })}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        const fraction = fractionFromPointer(e)
        if (fraction === null) return
        e.currentTarget.setPointerCapture?.(e.pointerId)
        setDrag({ pointerId: e.pointerId, fraction })
      }}
      onPointerMove={(e) => {
        if (drag?.pointerId !== e.pointerId) return
        // A pointerup that never reached the element (released outside the window) would otherwise keep the drag
        // alive and let plain hover moves drag the playhead around.
        if (e.buttons === 0) { setDrag(null); return }
        const fraction = fractionFromPointer(e)
        if (fraction === null) { setDrag(null); return }
        setDrag({ pointerId: e.pointerId, fraction })
      }}
      onPointerUp={(e) => {
        if (drag?.pointerId !== e.pointerId) return
        const fraction = fractionFromPointer(e)
        if (fraction !== null) onSeek(seekTarget(fraction))
        setDrag(null)
        e.currentTarget.releasePointerCapture?.(e.pointerId)
      }}
      onPointerCancel={(e) => { if (drag?.pointerId === e.pointerId) setDrag(null) }}
      onLostPointerCapture={() => setDrag(null)}
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
      <div className="live-playhead" style={{ left: `${pct(displayTime, end)}%` }} />
    </div>
  )
}
