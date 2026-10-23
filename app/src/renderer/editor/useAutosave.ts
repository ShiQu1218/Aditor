type SaveResult = void | boolean | PromiseLike<unknown>

export interface AutosaveOptions<T> {
  /** Delay before writing after input stops (ms). */
  delayMs: number
  /** Write function, called after debounce. */
  save: (state: T) => SaveResult
  /** Version that returns only after writing, used on window close (ipcRenderer.sendSync); falls back to save when omitted. */
  saveSync?: (state: T) => SaveResult
  /** Called when a write throws or explicitly returns false; the pending state remains available for retry. */
  onError?: (error: unknown) => void
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
  private save: (state: T) => SaveResult
  private saveSync: ((state: T) => SaveResult) | undefined
  private onError: ((error: unknown) => void) | undefined
  private enabled: boolean
  private held: boolean
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: T | null = null
  private hasPending = false
  private pendingVersion = 0

  constructor(opts: AutosaveOptions<T>) {
    this.delayMs = opts.delayMs
    this.save = opts.save
    this.saveSync = opts.saveSync
    this.onError = opts.onError
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
    this.pendingVersion++
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

  flushSync(): boolean {
    this.clearTimer()
    return this.writePending((s) => (this.saveSync ?? this.save)(s), true)
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

  private writePending(write: (state: T) => SaveResult, sync = false): boolean {
    if (!this.hasPending) return true
    const state = this.pending as T
    const version = this.pendingVersion
    let result: SaveResult
    try {
      result = write(state)
    } catch (error) {
      this.failed(version, error)
      return false
    }
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(result).then((value) => {
        if (value === false) this.failed(version, new Error('Autosave failed'))
        else this.completed(version)
      }, (error) => this.failed(version, error))
      // A synchronous close cannot wait for a Promise; keep the edit pending and let the caller block/retry.
      return !sync
    }
    if (result === false) {
      this.failed(version, new Error('Autosave failed'))
      return false
    }
    this.completed(version)
    return true
  }

  private completed(version: number): void {
    if (version !== this.pendingVersion) return
    this.pending = null
    this.hasPending = false
  }

  private failed(version: number, error: unknown): void {
    if (version !== this.pendingVersion || !this.hasPending) return
    try {
      this.onError?.(error)
    } catch {
      // An error reporter must not interfere with retaining the pending edit.
    }
  }
}
