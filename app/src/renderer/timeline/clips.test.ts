import { describe, it, expect } from 'vitest'
import { createClipAt, resizeClip } from './clips'

describe('Timeline Clips', () => {
  it('createClipAt clamps to [0,duration]', () => {
    // t=2, before=8, after=4, duration=100 -> start clamped to 0, end=6
    const c1 = createClipAt(2, 8, 4, 100)
    expect(c1.start).toBe(0)
    expect(c1.end).toBe(6)
    expect(c1.origin).toBe('manual')

    // t=98, before=8, after=4, duration=100 -> start=90, end clamped to 100
    const c2 = createClipAt(98, 8, 4, 100)
    expect(c2.start).toBe(90)
    expect(c2.end).toBe(100)
  })

  it('resizeClip enforces minLen and bounds', () => {
    const clip = { id: 'c1', start: 10, end: 20, origin: 'manual' as const, event_ids: [] }

    // Resize start to 5
    const r1 = resizeClip(clip, 'start', 5, 100, 2)
    expect(r1.start).toBe(5)
    expect(r1.end).toBe(20)

    // Resize start past end - minLen (e.g. t=19 when end=20, minLen=2 -> clamps start to 18)
    const r2 = resizeClip(clip, 'start', 19, 100, 2)
    expect(r2.start).toBe(18)

    // Resize start < 0 clamps to 0
    const r3 = resizeClip(clip, 'start', -5, 100, 2)
    expect(r3.start).toBe(0)

    // Resize end past duration clamps to duration
    const r4 = resizeClip(clip, 'end', 150, 100, 2)
    expect(r4.end).toBe(100)

    // Resize end < start + minLen
    const r5 = resizeClip(clip, 'end', 11, 100, 2)
    expect(r5.end).toBe(12)
  })
})
