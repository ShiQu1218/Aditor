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
    vi.advanceTimersByTime(249) // Only 249 ms have elapsed since the last update; nothing has been emitted yet.
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
    expect(emit).toHaveBeenCalledTimes(1) // Do not emit duplicates.

    d.update('b')
    d.dispose()
    vi.advanceTimersByTime(1000)
    expect(emit).toHaveBeenCalledTimes(1)

    d.flush() // Emit nothing when there is no pending value.
    expect(emit).toHaveBeenCalledTimes(1)
  })
})
