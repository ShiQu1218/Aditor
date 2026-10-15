import { describe, it, expect } from 'vitest'
import { normalizeClips, mergeOnReanalyze, suggestionCount } from './clips'
import type { Clip } from './types'

const c = (id: string, start: number, over: Partial<Clip> = {}): Clip => ({
  id,
  start,
  end: start + 10,
  origin: 'ai',
  event_ids: [],
  status: 'accepted',
  ...over
})

describe('normalizeClips', () => {
  it('legacy clips without status load as accepted', () => {
    const legacy = [{ id: 'a', start: 1, end: 5, origin: 'ai' }] as unknown as Clip[]
    const out = normalizeClips(legacy)
    expect(out[0].status).toBe('accepted')
    expect(out[0].event_ids).toEqual([])
  })
  it('handles undefined and drops duplicate ids', () => {
    expect(normalizeClips(undefined)).toEqual([])
    expect(normalizeClips([c('a', 1), c('a', 2)]).length).toBe(1)
  })
  it('keeps explicit status', () => {
    expect(normalizeClips([c('a', 1, { status: 'skipped' })])[0].status).toBe('skipped')
  })
})

describe('mergeOnReanalyze', () => {
  it('keeps manual clips untouched', () => {
    const m = c('m1', 5, { origin: 'manual' })
    const out = mergeOnReanalyze([m], [])
    expect(out).toEqual([m])
    expect(out[0].stale).toBeUndefined()
  })
  it('keeps accepted ai clip and marks stale', () => {
    const out = mergeOnReanalyze([c('a1', 10)], [])
    expect(out.length).toBe(1)
    expect(out[0].stale).toBe(true)
  })
  it('drops suggested and skipped ai clips', () => {
    const out = mergeOnReanalyze(
      [c('s1', 10, { status: 'suggested' }), c('k1', 30, { status: 'skipped' })],
      []
    )
    expect(out).toEqual([])
  })
  it('does not duplicate a new ai clip within 1s of a kept clip', () => {
    const out = mergeOnReanalyze(
      [c('a1', 10), c('m1', 100, { origin: 'manual' })],
      [c('n1', 10.5, { status: undefined }), c('n2', 100.9), c('n3', 50)]
    )
    expect(out.map((x) => x.id)).toEqual(['a1', 'n3', 'm1'])
    expect(out.find((x) => x.id === 'n3')?.status).toBe('suggested')
  })
  it('result is sorted by start and ids stay unique', () => {
    const out = mergeOnReanalyze(
      [c('a1', 40), c('m1', 5, { origin: 'manual' })],
      [c('a1', 80), c('n2', 20)]
    )
    expect(out.map((x) => x.start)).toEqual([5, 20, 40, 80])
    expect(new Set(out.map((x) => x.id)).size).toBe(out.length)
  })
})

describe('suggestionCount', () => {
  it('counts suggested only', () => {
    expect(
      suggestionCount([c('a', 1), c('b', 2, { status: 'suggested' }), c('d', 3, { status: 'suggested' })])
    ).toBe(2)
  })
})
