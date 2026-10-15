import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createThrottle } from './throttle'

describe('createThrottle(ms) — 前緣＋尾端', () => {
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
    t.trigger() // 前緣
    vi.advanceTimersByTime(100)
    t.trigger()
    vi.advanceTimersByTime(100)
    t.trigger()
    expect(fn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(299)
    expect(fn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1) // 剛好 500 ms
    expect(fn).toHaveBeenCalledTimes(2)
    // 之後沒有多餘的觸發
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
      vi.advanceTimersByTime(50) // 3 秒內每 50 ms 一次
    }
    vi.advanceTimersByTime(1000)
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(500)
    }
    // 最後一次觸發發生在 t=2950，其尾端呼叫必須存在
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

    t.trigger() // 靜默 1 秒後 → 新的前緣
    t.trigger() // 視窗內 → 只排尾端
    expect(fn).toHaveBeenCalledTimes(3)
    t.cancel()
    vi.advanceTimersByTime(1000)
    expect(fn).toHaveBeenCalledTimes(3)
  })
})
