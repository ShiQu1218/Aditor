import { Clip } from '../../shared/types'

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
