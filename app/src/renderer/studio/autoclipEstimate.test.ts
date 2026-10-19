import { describe, expect, test } from 'vitest'
import type { AutoClipParams, Clip } from '../../shared/types'
import { canApply, estimateReducer, estimateView, initialEstimate, paramsEqual } from './autoclipEstimate'

const P1: AutoClipParams = { n: 3, gap: 20, before: 8, after: 4, max_len: 90 }
const P2: AutoClipParams = { ...P1, n: 4 }
const clip = (id: string, s: number, e: number): Clip => ({ id, start: s, end: e, origin: 'ai', event_ids: [] })

describe('autoclip estimate state machine', () => {
  test('paramsEqual compares by value', () => {
    expect(paramsEqual(P1, { ...P1 })).toBe(true)
    expect(paramsEqual(P1, P2)).toBe(false)
    expect(paramsEqual(null, P1)).toBe(false)
  })

test('idle, loading, and error never allow apply and show “Calculating”', () => {
    expect(canApply(initialEstimate, P1)).toBe(false)
    const loading = estimateReducer(initialEstimate, { type: 'request', seq: 1, params: P1 })
    expect(canApply(loading, P1)).toBe(false)
    const err = estimateReducer(loading, { type: 'reject', seq: 1 })
    expect(err.status).toBe('error')
    expect(canApply(err, P1)).toBe(false)
    expect(estimateView(err, P1)).toBeNull()
  })

  test('resolved result is applicable only for the params it was computed with', () => {
    let s = estimateReducer(initialEstimate, { type: 'request', seq: 1, params: P1 })
    s = estimateReducer(s, { type: 'resolve', seq: 1, clips: [clip('a', 0, 10), clip('b', 20, 35)] })
    expect(canApply(s, P1)).toBe(true)
    expect(estimateView(s, P1)).toEqual({ n: 2, total: 25 })
    // The user changed parameters (before debounce): the old result cannot be applied or shown.
    expect(canApply(s, P2)).toBe(false)
    expect(estimateView(s, P2)).toBeNull()
  })

  test('typing fast: stale response for old params is discarded; apply never uses an old result', () => {
    let s = estimateReducer(initialEstimate, { type: 'request', seq: 1, params: P1 })
    s = estimateReducer(s, { type: 'request', seq: 2, params: P2 }) // More input arrived.
    // The response for seq 1 arrived late.
    s = estimateReducer(s, { type: 'resolve', seq: 1, clips: [clip('old', 0, 10)] })
    expect(s.status).toBe('loading')
    expect(s.clips).toEqual([])
    expect(canApply(s, P2)).toBe(false)
    s = estimateReducer(s, { type: 'resolve', seq: 2, clips: [clip('new', 5, 9)] })
    expect(canApply(s, P2)).toBe(true)
    expect(s.clips.map((c) => c.id)).toEqual(['new'])
  })

  test('a new request clears the previous result; a late rejection of an old request is ignored', () => {
    let s = estimateReducer(initialEstimate, { type: 'request', seq: 1, params: P1 })
    s = estimateReducer(s, { type: 'resolve', seq: 1, clips: [clip('a', 0, 10)] })
    s = estimateReducer(s, { type: 'request', seq: 2, params: P2 })
    expect(s.clips).toEqual([])
    expect(s.status).toBe('loading')
    s = estimateReducer(s, { type: 'reject', seq: 1 })
    expect(s.status).toBe('loading')
  })
})
