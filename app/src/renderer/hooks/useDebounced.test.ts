import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DebouncedEmitter } from './useDebounced'

describe('DebouncedEmitter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('useDebounced emits last value after delay', () => {
    const emit = vi.fn()
    const d = new DebouncedEmitter<number>(250, emit)

    d.update(1)
    vi.advanceTimersByTime(100)
    d.update(2)
    vi.advanceTimersByTime(249) // 距最後一次更新僅 249ms → 尚未發出
    expect(emit).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(2)
  })

  test('flush emits pending immediately and dispose cancels', () => {
    const emit = vi.fn()
    const d = new DebouncedEmitter<string>(250, emit)

    d.update('a')
    d.flush()
    expect(emit).toHaveBeenCalledWith('a')
    vi.advanceTimersByTime(1000)
    expect(emit).toHaveBeenCalledTimes(1) // 不重複發出

    d.update('b')
    d.dispose()
    vi.advanceTimersByTime(1000)
    expect(emit).toHaveBeenCalledTimes(1)

    d.flush() // 沒有 pending 時不發出
    expect(emit).toHaveBeenCalledTimes(1)
  })
})
