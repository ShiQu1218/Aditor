import { useEffect, useRef } from 'react'

export interface AutosaveOptions<T> {
  /** 停止輸入後多久寫入（ms）。 */
  delayMs: number
  /** 實際寫入函式（去抖後呼叫）。 */
  save: (state: T) => void
  /** 關閉時不寫入並取消待寫內容（對應 settings.projectAutosave）。 */
  enabled?: boolean
}

/**
 * 去抖自動儲存控制器（與 React 解耦，方便單元測試）。
 * `update(state)` 重設計時器；`flush()` 立即寫入待寫內容（關閉視窗用）；
 * `setEnabled(false)` 取消待寫；`dispose()` 清除計時器。
 */
export class AutosaveController<T> {
  private delayMs: number
  private save: (state: T) => void
  private enabled: boolean
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: T | null = null
  private hasPending = false

  constructor(opts: AutosaveOptions<T>) {
    this.delayMs = opts.delayMs
    this.save = opts.save
    this.enabled = opts.enabled !== false
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  update(state: T): void {
    if (!this.enabled) return
    this.pending = state
    this.hasPending = true
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      this.writePending()
    }, this.delayMs)
  }

  flush(): void {
    this.clearTimer()
    this.writePending()
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return
    this.enabled = enabled
    if (!enabled) {
      this.clearTimer()
      this.pending = null
      this.hasPending = false
    }
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

  private writePending(): void {
    if (!this.hasPending) return
    const state = this.pending as T
    this.pending = null
    this.hasPending = false
    this.save(state)
  }
}

/**
 * React 綁定：state 變更後去抖寫入（略過掛載首輪，初始狀態不算變更）；
 * `beforeunload`／`pagehide` 時 flush，卸載時 dispose。
 */
export function useAutosave<T>(
  state: T,
  opts: { delayMs: number; enabled: boolean; save: (state: T) => void }
): void {
  const saveRef = useRef(opts.save)
  saveRef.current = opts.save

  const controllerRef = useRef<AutosaveController<T> | null>(null)
  if (controllerRef.current === null) {
    controllerRef.current = new AutosaveController<T>({
      delayMs: opts.delayMs,
      enabled: opts.enabled,
      save: (state) => saveRef.current(state)
    })
  }

  useEffect(() => {
    controllerRef.current?.setEnabled(opts.enabled)
  }, [opts.enabled])

  const isFirstRun = useRef(true)
  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false
      return
    }
    controllerRef.current?.update(state)
  }, [state])

  useEffect(() => {
    const flush = (): void => controllerRef.current?.flush()
    window.addEventListener('beforeunload', flush)
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      window.removeEventListener('pagehide', flush)
      controllerRef.current?.dispose()
    }
  }, [])
}
