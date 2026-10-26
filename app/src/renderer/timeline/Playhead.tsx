import { useEffect, useRef } from 'react'
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

/** Delay between playback position checks: half a pixel of media time (so 2x speed stays within a pixel), clamped to 16-250 ms. */
export function playbackPollMs(view: View): number {
  return Math.min(250, Math.max(16, (view.span / Math.max(1, view.width)) * 500))
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
  const placed = useRef<{ x: number; visible: boolean } | null>(null)

  const place = (t: number): void => {
    const el = ref.current
    if (!el) return
    const { x, visible } = playheadX(t, viewRef.current)
    const px = Math.round(x)
    // Every style write forces a main-frame commit; skipping unchanged pixels keeps playback from recompositing the window each vsync.
    if (placed.current?.x === px && placed.current.visible === visible) return
    placed.current = { x: px, visible }
    el.style.transform = `translateX(${px}px)`
    el.style.opacity = visible ? '1' : '0'
  }

  const getTimeRef = useRef(getTime)
  getTimeRef.current = getTime
  const hasGetTime = !!getTime

  // Reposition when time/view changes; during playback, read live time instead of the stale time prop.
  useEffect(() => {
    place(playheadTarget({ playing, time, getTime: getTimeRef.current }))
  }, [time, view.start, view.span, view.width, playing])

  // Start/stop the playback loop only from playing (getTime reads from a ref, so an inline parent function does not restart it).
  // A pixel-paced timer instead of rAF: even an idle rAF loop commits a main frame every vsync, which starves video presentation on some PCs.
  useEffect(() => {
    if (!playing || !hasGetTime) return
    let id = 0
    const tick = (): void => {
      place(getTimeRef.current!())
      id = window.setTimeout(tick, playbackPollMs(viewRef.current))
    }
    id = window.setTimeout(tick, playbackPollMs(viewRef.current))
    return () => window.clearTimeout(id)
  }, [playing, hasGetTime])

  return <div ref={ref} className="tl-playhead" aria-hidden="true" />
}
