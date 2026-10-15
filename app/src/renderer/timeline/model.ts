import { EngineEvent, EventType, isCounted } from '../../shared/types'

export interface View {
  duration: number
  start: number
  span: number
  width: number
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
