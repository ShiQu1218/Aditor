import { describe, expect, test, vi } from 'vitest'
import { createQueueStore } from './queueStore'
import type { QueuePayload } from '../../shared/queueState'

const payload = (progress = 0.5): QueuePayload => ({
  queue: { analyzing: 'D:/v/a.mp4', queued: ['D:/v/b.mp4'] },
  current: { path: 'D:/v/a.mp4', progress, analyzingSince: 1_000_000 }
})

describe('queue store (one shared source for ring, strip, popover and every card)', () => {
  test('starts empty: nothing analyzing/queued, every path idle', () => {
    const store = createQueueStore(() => 0)
    expect(store.getSummary().total).toBe(0)
    expect(store.stateOf('D:/v/a.mp4')).toBe('idle')
    expect(store.etaOf('D:/v/a.mp4')).toBeNull()
  })

  test('set() publishes the summary; strip, popover and card read identical ETA values', () => {
    let now = 1_060_000
    const store = createQueueStore(() => now)
    store.set(payload())
    const s = store.getSummary()
    expect(s.total).toBe(2)
    expect(store.stateOf('D:/v/a.mp4')).toBe('analyzing')
    expect(store.stateOf('D:/v/b.mp4')).toBe('queued')
    expect(store.stateOf('D:/v/other.mp4')).toBe('idle')
    // The strip/popover summary and card use the same ETA source.
    expect(s.analyzing?.etaMs).toBeCloseTo(60000)
    expect(store.etaOf('D:/v/a.mp4')).toBe(s.analyzing?.etaMs)
    expect(store.etaOf('D:/v/b.mp4')).toBeNull()
    now += 1000
  })

  test('subscribers are notified on set(); unsubscribe stops notifications; summary identity changes per update', () => {
    const store = createQueueStore(() => 1_060_000)
    const fn = vi.fn()
    const off = store.subscribe(fn)
    const before = store.getSummary()
    store.set(payload(0.3))
    expect(fn).toHaveBeenCalledTimes(1)
    expect(store.getSummary()).not.toBe(before)
    off()
    store.set(payload(0.4))
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('finishing (payload with empty queue) returns to the empty summary — the strip hides', () => {
    const store = createQueueStore(() => 1_060_000)
    store.set(payload())
    store.set({ queue: { analyzing: null, queued: [] }, current: null })
    expect(store.getSummary().total).toBe(0)
    expect(store.stateOf('D:/v/a.mp4')).toBe('idle')
  })

  test('ignores malformed payloads (treated as empty)', () => {
    const store = createQueueStore(() => 0)
    store.set(payload())
    store.set(undefined as unknown as QueuePayload)
    expect(store.getSummary().total).toBe(0)
  })
})
