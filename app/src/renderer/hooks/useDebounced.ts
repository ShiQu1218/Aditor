import { useEffect, useRef, useState } from 'react'

/**
 * Debounced value controller, decoupled from React for unit testing:
 * `update(v)` resets the timer and calls emit with the latest value after delayMs without changes.
 * `flush()` emits the pending value immediately (does nothing when none is pending); `dispose()` cancels the timer.
 */
export class DebouncedEmitter<T> {
  private delayMs: number
  private emit: (value: T) => void
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: T | null = null
  private hasPending = false

  constructor(delayMs: number, emit: (value: T) => void) {
    this.delayMs = delayMs
    this.emit = emit
  }

  update(value: T): void {
    this.pending = value
    this.hasPending = true
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, this.delayMs)
  }

  flush(): void {
    this.clearTimer()
    if (!this.hasPending) return
    const value = this.pending as T
    this.pending = null
    this.hasPending = false
    this.emit(value)
  }

  dispose(): void {
    this.clearTimer()
    this.pending = null
    this.hasPending = false
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}

/**
 * Return `value` after it has stopped changing for delayMs (on first mount, return the initial value without debouncing).
 * Used for live previews such as the AI popover's “estimated N clips.”
 */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)

  const emitterRef = useRef<DebouncedEmitter<T> | null>(null)
  if (emitterRef.current === null) {
    emitterRef.current = new DebouncedEmitter<T>(delayMs, setDebounced)
  }

  const isFirstRun = useRef(true)
  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false
      return
    }
    emitterRef.current?.update(value)
  }, [value])

  useEffect(() => () => emitterRef.current?.dispose(), [])

  return debounced
}
