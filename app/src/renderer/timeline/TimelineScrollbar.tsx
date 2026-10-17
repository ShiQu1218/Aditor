import React, { useRef } from 'react'
import { i18n } from '../i18n/zh-TW'
import { formatTime } from '../../shared/time'
import { View, scrollStartAt, timelineScroll } from './model'
import { pointerToX } from './useTimelineInteractions'

interface TimelineScrollbarProps {
  view: View
  controls: string
  onScroll: (start: number) => void
}

export function TimelineScrollbar({ view, controls, onScroll }: TimelineScrollbarProps): JSX.Element {
  const drag = useRef<{ id: number; offset: number } | null>(null)
  const scroll = timelineScroll(view)
  const localX = (e: React.PointerEvent<HTMLDivElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect()
    return pointerToX(e.clientX, rect.left, rect.width, view.width)
  }

  return (
    <div
      className="tl-scrollbar"
      role="scrollbar"
      tabIndex={0}
      aria-label={i18n.timeline.scrollbar}
      aria-controls={controls}
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={scroll.maxStart}
      aria-valuenow={view.start}
      aria-valuetext={formatTime(view.start)}
      aria-disabled={scroll.maxStart === 0}
      onPointerDown={(e) => {
        if (e.button !== 0 || scroll.maxStart === 0) return
        e.preventDefault()
        e.currentTarget.focus()
        const x = localX(e)
        const offset = x >= scroll.left && x <= scroll.left + scroll.width ? x - scroll.left : scroll.width / 2
        drag.current = { id: e.pointerId, offset }
        e.currentTarget.setPointerCapture(e.pointerId)
        onScroll(scrollStartAt(view, x, offset))
      }}
      onPointerMove={(e) => {
        if (drag.current?.id !== e.pointerId) return
        onScroll(scrollStartAt(view, localX(e), drag.current.offset))
      }}
      onPointerUp={(e) => {
        if (drag.current?.id !== e.pointerId) return
        drag.current = null
        e.currentTarget.releasePointerCapture(e.pointerId)
      }}
      onPointerCancel={() => { drag.current = null }}
      onLostPointerCapture={() => { drag.current = null }}
      onKeyDown={(e) => {
        if (e.ctrlKey || e.metaKey || e.altKey || e.nativeEvent.isComposing) return
        const delta = e.key === 'ArrowLeft' ? -view.span / 10 : e.key === 'ArrowRight' ? view.span / 10
          : e.key === 'PageUp' ? -view.span : e.key === 'PageDown' ? view.span : null
        const start = e.key === 'Home' ? 0 : e.key === 'End' ? scroll.maxStart : delta === null ? null : view.start + delta
        if (start === null) return
        e.preventDefault()
        e.stopPropagation()
        onScroll(Math.max(0, Math.min(scroll.maxStart, start)))
      }}
    >
      <div className="tl-scrollbar-thumb" style={{ left: scroll.left, width: scroll.width }} />
    </div>
  )
}
