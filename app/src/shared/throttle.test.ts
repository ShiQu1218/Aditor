import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createThrottle } from './throttle'

describe('createThrottle(ms) — leading and trailing edges', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('first call fires immediately (leading edge)', () => {
    const fn = vi.fn()
    const t = createThrottle(fn, 500)
    t.trigger()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('burst inside the window collapses into exactly one trailing call at the window end', () => {
    const fn = vi.fn()
    const t = createThrottle(fn, 500)
    t.trigger() // Leading edge
    vi.advanceTimersByTime(100)
    t.trigger()
    vi.advanceTimersByTime(100)
    t.trigger()
    expect(fn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(299)
    expect(fn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1) // Exactly 500 ms
    expect(fn).toHaveBeenCalledTimes(2)
    // No extra calls afterward.
    vi.advanceTimersByTime(5000)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test('the final update is always delivered (trailing edge) and never more often than every ms', () => {
    const fn = vi.fn()
    const times: number[] = []
    fn.mockImplementation(() => times.push(Date.now()))
    const t = createThrottle(fn, 500)
    for (let i = 0; i < 60; i++) {
      t.trigger()
      vi.advanceTimersByTime(50) // Once every 50 ms for 3 seconds.
    }
    vi.advanceTimersByTime(1000)
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(500)
    }
    // The final trigger occurs at t=2950, so its trailing call must be present.
    expect(times[times.length - 1]).toBeGreaterThanOrEqual(1_000_000 + 2950)
    expect(times.length).toBeLessThanOrEqual(7)
  })

  test('after a quiet period the next call is a fresh leading edge', () => {
    const fn = vi.fn()
    const t = createThrottle(fn, 500)
    t.trigger()
    vi.advanceTimersByTime(2000)
    t.trigger()
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test('flush() delivers a pending trailing call immediately; cancel() drops it', () => {
    const fn = vi.fn()
    const t = createThrottle(fn, 500)
    t.trigger()
    t.trigger()
    t.flush()
    expect(fn).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1000)
    expect(fn).toHaveBeenCalledTimes(2)

    t.trigger() // After 1 second of quiet, this is a new leading edge.
    t.trigger() // Inside the window, only schedule the trailing call.
    expect(fn).toHaveBeenCalledTimes(3)
    t.cancel()
    vi.advanceTimersByTime(1000)
    expect(fn).toHaveBeenCalledTimes(3)
  })
})
