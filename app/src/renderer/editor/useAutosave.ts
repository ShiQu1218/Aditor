export interface AutosaveOptions<T> {
  /** Delay before writing after input stops (ms). */
  delayMs: number
  /** Write function, called after debounce. */
  save: (state: T) => void
  /** Version that returns only after writing, used on window close (ipcRenderer.sendSync); falls back to save when omitted. */
  saveSync?: (state: T) => void
  /** When disabled, skip writes and cancel pending content (corresponds to settings.projectAutosave). */
  enabled?: boolean
  /** Settings have not loaded: retain pending content without writing; decide whether to write or discard it when `setHeld(false)` is called. */
  held?: boolean
}

/**
 * Debounced autosave controller, decoupled from React for unit testing.
 * `update(state)` resets the timer; `flush()` immediately writes pending content with regular save (before switching projects).
 * `flushSync()` uses saveSync (on window close, ignoring hold so edits are not lost).
 * `setEnabled(false)` cancels pending writes; `setHeld(false)` releases accumulated pending content (writing only the latest); `dispose()` clears the timer.
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
        /* Do not throw again if a write fails during close; the previous file remains intact. */
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
