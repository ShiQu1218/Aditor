export interface AutosaveOptions<T> {
  /** 停止輸入後多久寫入（ms）。 */
  delayMs: number
  /** 實際寫入函式（去抖後呼叫）。 */
  save: (state: T) => void
  /** 關閉視窗時用的「寫完才返回」版本（ipcRenderer.sendSync）；未提供則退回 save。 */
  saveSync?: (state: T) => void
  /** 關閉時不寫入並取消待寫內容（對應 settings.projectAutosave）。 */
  enabled?: boolean
  /** 設定尚未載入：先保留待寫內容但不寫入，`setHeld(false)` 時才決定寫或丟。 */
  held?: boolean
}

/**
 * 去抖自動儲存控制器（與 React 解耦，方便單元測試）。
 * `update(state)` 重設計時器；`flush()` 立即以一般 save 寫入待寫內容（切換專案前）；
 * `flushSync()` 以 saveSync 寫入（關閉視窗，忽略 hold 以免遺失編輯）；
 * `setEnabled(false)` 取消待寫；`setHeld(false)` 放行期間累積的待寫內容（只寫最新一次）；`dispose()` 清除計時器。
 */
export class AutosaveController<T> {
  private delayMs: number
  private save: (state: T) => void
  private saveSync: ((state: T) => void) | undefined
  private enabled: boolean
  private held: boolean
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: T | null = null
  private hasPending = false

  constructor(opts: AutosaveOptions<T>) {
    this.delayMs = opts.delayMs
    this.save = opts.save
    this.saveSync = opts.saveSync
    this.enabled = opts.enabled !== false
    this.held = opts.held === true
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  get hasPendingWrite(): boolean {
    return this.hasPending
  }

  update(state: T): void {
    if (!this.enabled) return
    this.pending = state
    this.hasPending = true
    this.clearTimer()
    if (this.held) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.writePending(this.save)
    }, this.delayMs)
  }

  flush(): void {
    this.clearTimer()
    this.writePending(this.save)
  }

  flushSync(): void {
    this.clearTimer()
    this.writePending((s) => {
      try {
        ;(this.saveSync ?? this.save)(s)
      } catch {
        /* 關閉途中寫入失敗不能再丟錯；上一版檔案仍完好 */
      }
    })
  }

  setHeld(held: boolean): void {
    if (this.held === held) return
    this.held = held
    if (!held && this.hasPending) {
      this.clearTimer()
      this.writePending(this.save)
    }
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
    this.cancelPending()
  }

  cancelPending(): void {
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

  private writePending(write: (state: T) => void): void {
    if (!this.hasPending) return
    const state = this.pending as T
    this.pending = null
    this.hasPending = false
    write(state)
  }
}
