import { Clip, EngineEvent } from '../../shared/types'

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

export function mergeOverlapping(clips: Clip[]): Clip[] {
  if (clips.length <= 1) {
    return clips.map((c) => ({ ...c, event_ids: [...c.event_ids] }))
  }

  const sorted = [...clips].sort((a, b) => a.start - b.start)
  const result: Clip[] = []

  for (const c of sorted) {
    if (result.length === 0) {
      result.push({ ...c, event_ids: [...c.event_ids] })
      continue
    }

    const last = result[result.length - 1]
    if (c.start <= last.end) {
      last.end = Math.max(last.end, c.end)
      for (const id of c.event_ids) {
        if (!last.event_ids.includes(id)) {
          last.event_ids.push(id)
        }
      }
    } else {
      result.push({ ...c, event_ids: [...c.event_ids] })
    }
  }

  return result
}

export function supercut(
  events: EngineEvent[],
  selectedIds: Set<string>,
  before: number,
  after: number,
  duration: number
): Clip[] {
  const selected = events
    .filter((e) => selectedIds.has(e.id))
    .sort((a, b) => a.t - b.t)

  const rawClips: Clip[] = selected.map((e) => ({
    id: `c_${Math.round(e.t * 1000)}`,
    start: Math.max(0, e.t - before),
    end: Math.min(duration, e.t + after),
    origin: 'manual',
    event_ids: [e.id]
  }))

  return mergeOverlapping(rawClips)
}
