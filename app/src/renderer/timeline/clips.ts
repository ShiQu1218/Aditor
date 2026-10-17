import { Clip } from '../../shared/types'

export function createClipAt(t: number, before: number, after: number, duration: number): Clip {
  const start = Math.max(0, t - before)
  const end = Math.min(duration, t + after)
  return {
    id: `c_${Math.round(start * 1000)}`,
    start,
    end,
    origin: 'manual',
    event_ids: []
  }
}

export function resizeClip(
  clip: Clip,
  edge: 'start' | 'end',
  t: number,
  duration: number,
  minLen = 1
): Clip {
  if (edge === 'start') {
    const newStart = Math.min(clip.end - minLen, Math.max(0, t))
    return {
      ...clip,
      start: newStart
    }
  } else {
    const newEnd = Math.max(clip.start + minLen, Math.min(duration, t))
    return {
      ...clip,
      end: newEnd
    }
  }
}
