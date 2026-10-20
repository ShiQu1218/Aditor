import React, { useEffect, useRef } from 'react'
import { View, timeToX } from './model'

export function playheadX(t: number, view: View): { x: number; visible: boolean } {
  const x = timeToX(t, view)
  return { x, visible: x >= 0 && x <= view.width }
}

  /** Always read live time (video.currentTime) during playback; props.time comes from ~4 Hz timeupdate events and can lag, causing the playhead to move backward. */
export function playheadTarget(a: { playing?: boolean; time: number; getTime?: () => number }): number {
  if (a.playing && a.getTime) {
    const t = a.getTime()
    if (typeof t === 'number' && Number.isFinite(t)) return t
  }
  return a.time
}

interface PlayheadProps {
  time: number
  view: View
  /** Read current time during playback via rAF (e.g. video.currentTime), without triggering React rerenders. */
  getTime?: () => number
  playing?: boolean
}

  /**
   * The playhead is a DOM element moved with style.transform; it does not trigger canvas redraws.
   * CSS draws its appearance (.tl-playhead) using --tl-playhead.
   */
export function Playhead({ time, view, getTime, playing }: PlayheadProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const viewRef = useRef(view)
  viewRef.current = view

  const place = (t: number): void => {
    const el = ref.current
    if (!el) return
    const { x, visible } = playheadX(t, viewRef.current)
    el.style.transform = `translateX(${x}px)`
    el.style.opacity = visible ? '1' : '0'
  }

  const getTimeRef = useRef(getTime)
  getTimeRef.current = getTime
  const hasGetTime = !!getTime

  // Reposition when time/view changes; during playback, read live time instead of the stale time prop.
  useEffect(() => {
    place(playheadTarget({ playing, time, getTime: getTimeRef.current }))
  }, [time, view.start, view.span, view.width, playing])

  // Start/stop the playback rAF loop only from playing (getTime reads from a ref, so an inline parent function does not restart it).
  useEffect(() => {
    if (!playing || !hasGetTime) return
    let id = 0
    const tick = (): void => {
      place(getTimeRef.current!())
      id = requestAnimationFrame(tick)
    }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [playing, hasGetTime])

  return <div ref={ref} className="tl-playhead" aria-hidden="true" />
}
