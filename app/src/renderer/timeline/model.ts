import { EngineEvent, EventType, isCounted } from '../../shared/types'

export interface View {
  duration: number
  start: number
  span: number
  width: number
}

export type ZoomMode = 'full' | 'detail' | 'custom'
export interface TimelineZoom {
  mode: ZoomMode
  customZoom: number
  view: View
}

export const DETAIL_SPAN = 30
const MIN_SPAN = 10

export function maxCustomZoom(duration: number): number {
  return Math.max(1, duration / MIN_SPAN)
}

function centeredView(view: View, span: number, time: number): View {
  const start = Math.max(0, Math.min(view.duration - span, time - span / 2))
  return view.span === span && view.start === start ? view : { ...view, span, start }
}

  /** Store the custom scale separately so switching overview/detail does not overwrite it. */
export function setZoomMode(state: TimelineZoom, mode: ZoomMode, time: number): TimelineZoom {
  const { view } = state
  const span = mode === 'full' ? view.duration : mode === 'detail'
    ? Math.min(DETAIL_SPAN, view.duration)
    : view.duration / Math.min(maxCustomZoom(view.duration), Math.max(1, state.customZoom))
  const next = centeredView(view, span, mode === 'full' ? 0 : time)
  return state.mode === mode && next === view ? state : { ...state, mode, view: next }
}

  /** Shared entry point for scrolling, wheel, and cluster zoom; no-op panning in overview preserves the mode. */
export function updateTimelineView(state: TimelineZoom, update: (view: View) => View): TimelineZoom {
  const view = update(state.view)
  if (view.start === state.view.start && view.span === state.view.span) return state
  return { mode: 'custom', customZoom: view.duration / view.span, view }
}

  /** Custom zoom (wheel, buttons, shortcuts, zoom slider): center the resulting window on `center` (the playhead), clamped at either end. */
export function zoomTimeline(state: TimelineZoom, factor: number, center: number): TimelineZoom {
  const view = centeredView(state.view, zoom(state.view, factor, center).span, center)
  return { mode: 'custom', customZoom: view.duration / view.span, view }
}

export function setCustomZoom(state: TimelineZoom, value: number, center: number): TimelineZoom {
  const multiplier = Math.max(1, Math.min(maxCustomZoom(state.view.duration), value))
  return zoomTimeline(state, state.view.duration / multiplier / state.view.span, center)
}

export function resizeTimeline(state: TimelineZoom, duration: number, width: number, time: number): TimelineZoom {
  const d = Math.max(1, duration)
  if (state.view.duration === d && state.view.width === width) return state
  const next = { ...state, view: { ...state.view, duration: d, width } }
  if (state.mode !== 'custom') return setZoomMode(next, state.mode, time)
  const span = d / Math.min(maxCustomZoom(d), Math.max(1, state.customZoom))
  return { ...next, view: { ...next.view, span, start: Math.max(0, Math.min(d - span, next.view.start)) } }
}

  /** Scrollbar size is measured in timeline-width pixels; in overview the thumb fills the track and cannot scroll. */
export function timelineScroll(view: View): { left: number; width: number; maxStart: number } {
  const width = Math.max(0, view.width)
  if (view.duration <= 0 || view.span >= view.duration) return { left: 0, width, maxStart: 0 }
  return {
    left: (view.start / view.duration) * width,
    width: (view.span / view.duration) * width,
    maxStart: view.duration - view.span
  }
}

export function scrollStartAt(view: View, x: number, grabOffset: number): number {
  if (view.width <= 0) return view.start
  return Math.max(0, Math.min(timelineScroll(view).maxStart, (x - grabOffset) / view.width * view.duration))
}

export function timeToX(t: number, view: View): number {
  if (view.span <= 0) return 0
  return ((t - view.start) / view.span) * view.width
}

export function xToTime(x: number, view: View): number {
  if (view.width <= 0) return view.start
  return view.start + (x / view.width) * view.span
}

export function zoom(view: View, factor: number, anchorT: number): View {
  const newSpan = Math.min(view.duration, Math.max(10, view.span * factor))
  const frac = view.span > 0 ? (anchorT - view.start) / view.span : 0
  const maxStart = Math.max(0, view.duration - newSpan)
  const newStart = Math.max(0, Math.min(maxStart, anchorT - frac * newSpan))
  return {
    ...view,
    start: newStart,
    span: newSpan
  }
}

export function pan(view: View, dt: number): View {
  const maxStart = Math.max(0, view.duration - view.span)
  const newStart = Math.max(0, Math.min(maxStart, view.start + dt))
  return {
    ...view,
    start: newStart
  }
}

export function heatmap(events: EngineEvent[], duration: number, bins: number): Float32Array {
  const counts = new Float32Array(bins)
  if (duration <= 0 || bins <= 0) {
    return counts
  }

  let max = 0
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (!isCounted(e)) {
      continue
    }
    const bin = Math.min(bins - 1, Math.max(0, Math.floor((e.t / duration) * bins)))
    counts[bin]++
    if (counts[bin] > max) {
      max = counts[bin]
    }
  }

  if (max > 0) {
    for (let i = 0; i < bins; i++) {
      counts[i] /= max
    }
  }
  return counts
}

export function hitTestEvent(
  events: EngineEvent[],
  x: number,
  view: View,
  tolPx = 6
): EngineEvent | null {
  let nearest: EngineEvent | null = null
  let minDist = Infinity

  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    const evX = timeToX(e.t, view)
    const dist = Math.abs(evX - x)
    if (dist <= tolPx && dist < minDist) {
      minDist = dist
      nearest = e
    }
  }
  return nearest
}

export function nextEvent(
  events: EngineEvent[],
  t: number,
  dir: 1 | -1,
  types: Set<EventType>
): EngineEvent | null {
  let best: EngineEvent | null = null

  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (!types.has(e.type as EventType)) {
      continue
    }

    if (dir === 1) {
      if (e.t > t + 0.001) {
        if (!best || e.t < best.t) {
          best = e
        }
      }
    } else {
      if (e.t < t - 0.001) {
        if (!best || e.t > best.t) {
          best = e
        }
      }
    }
  }
  return best
}
