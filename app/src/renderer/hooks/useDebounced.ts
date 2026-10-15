import { useEffect, useRef, useState } from 'react'

/**
 * 去抖值控制器（與 React 解耦，方便單元測試）：
 * `update(v)` 重設計時器，停止變動 delayMs 後以最後一個值呼叫 emit；
 * `flush()` 立即發出待發值（無待發值時不動作）；`dispose()` 取消計時器。
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
 * 回傳 `value` 停止變動 `delayMs` 後的值（首次掛載直接回傳初始值、不觸發去抖）。
 * 供 AI 浮層「預計產生 N 段」等即時預覽使用。
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
