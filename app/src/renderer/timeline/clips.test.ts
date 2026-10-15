import { describe, it, expect } from 'vitest'
import { createClipAt, resizeClip, supercut, mergeOverlapping } from './clips'
import { EngineEvent } from '../../shared/types'

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

  it('supercut merges overlapping windows', () => {
    // Events at 100, 105. with before=8, after=4:
    // Event 100: [92, 104]
    // Event 105: [97, 109]
    // Overlapping, should merge to [92, 109]
    const events: EngineEvent[] = [
      { id: 'e1', t: 100, type: 'knock', counted: true, counted_override: null, score: 0.9, damage_line: true, name_sig: null, counted_reason: '', source: 'auto' },
      { id: 'e2', t: 105, type: 'knock', counted: true, counted_override: null, score: 0.9, damage_line: true, name_sig: null, counted_reason: '', source: 'auto' },
      { id: 'e3', t: 150, type: 'knock', counted: true, counted_override: null, score: 0.9, damage_line: true, name_sig: null, counted_reason: '', source: 'auto' }
    ]

    const selectedIds = new Set(['e1', 'e2'])
    const clips = supercut(events, selectedIds, 8, 4, 200)
    expect(clips.length).toBe(1)
    expect(clips[0].start).toBe(92)
    expect(clips[0].end).toBe(109)
    expect(clips[0].event_ids).toEqual(['e1', 'e2'])
  })

  it('mergeOverlapping combines clips and event_ids', () => {
    const clips = [
      { id: 'c1', start: 10, end: 20, origin: 'manual' as const, event_ids: ['e1'] },
      { id: 'c2', start: 18, end: 30, origin: 'manual' as const, event_ids: ['e2'] },
      { id: 'c3', start: 40, end: 50, origin: 'manual' as const, event_ids: ['e3'] }
    ]
    const merged = mergeOverlapping(clips)
    expect(merged.length).toBe(2)
    expect(merged[0]).toEqual({
      id: 'c1',
      start: 10,
      end: 30,
      origin: 'manual',
      event_ids: ['e1', 'e2']
    })
    expect(merged[1]).toEqual({
      id: 'c3',
      start: 40,
      end: 50,
      origin: 'manual',
      event_ids: ['e3']
    })
  })
})
