import { EventEmitter } from 'events'
import fs from 'fs'
import path from 'path'
import type { FSWatcher } from 'chokidar'
import { Library, SUPPORTED_EXTS, watchFolder } from './library'
import type { AnalysisQueue } from './queue'
import type { SettingsStore } from './settings'
import { tr } from '../shared/locale'

/** Default milliseconds the file size must remain stable and polling interval (used when WatchManagerOptions does not specify them). */
export const DEFAULT_STABILITY_MS = 2000
export const DEFAULT_POLL_MS = 200
/** Interval for retrying missing folders and detecting dead watchers (while the app is running). */
export const DEFAULT_RETRY_MS = 30000

export type WatcherFactory = (
  dir: string,
  onAdd: (paths: string[]) => void,
  opts: { stabilityMs: number; pollMs: number }
) => FSWatcher

export interface WatchManagerOptions {
  library: Library
  queue: AnalysisQueue
  settings: SettingsStore
  /** Milliseconds the file size must remain stable (default 2000; tests inject a smaller value). */
  stabilityMs?: number
  /** File-size polling interval in milliseconds (default 200). */
  pollMs?: number
  /** Retry interval for missing folders (default 30000; tests inject a smaller value). */
  retryMs?: number
  /** Watcher factory (defaults to the chokidar wrapper; tests can inject a fake). */
  createWatcher?: WatcherFactory
}

export type WatchDirErrorCode = 'relative' | 'missing' | 'not-directory'

export class WatchDirError extends Error {
  code: WatchDirErrorCode
  constructor(code: WatchDirErrorCode, message: string) {
    super(message)
    this.name = 'WatchDirError'
    this.code = code
  }
}

/**
 * Single validator for watched folders (shared by `add`/`start`/settings sync): must be an absolute path to an existing directory.
 * Return its `path.resolve` result when valid; otherwise throw a `WatchDirError` with a `code` (message can be displayed to the user).
 */
export function validateWatchDir(dir: unknown): string {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) {
    throw new WatchDirError('relative', tr('監看資料夾必須是絕對路徑：{dir}', { dir: String(dir) }))
  }
  const resolved = path.resolve(dir)
  let stat: fs.Stats
  try {
    stat = fs.statSync(resolved)
  } catch {
    throw new WatchDirError('missing', tr('資料夾不存在：{resolved}', { resolved }))
  }
  if (!stat.isDirectory()) {
    throw new WatchDirError('not-directory', tr('路徑不是資料夾：{resolved}', { resolved }))
  }
  return resolved
}

/** Path comparison key: path.resolve (remove trailing separators) plus case-insensitive comparison on Windows, so alternate spellings do not create duplicate watchers. */
export function watchKey(dir: string): string {
  const resolved = path.resolve(dir)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

const defaultFactory: WatcherFactory = (dir, onAdd, opts) => watchFolder(dir, onAdd, opts)

interface Activating {
  promise: Promise<void>
  /** Immediately close a watcher that is still starting and release waiters (used by stop()/remove). */
  cancel: () => void
}

/**
 * Watched-folder manager (main):
 * - Settings (`settings.watchFolders`) are the single source of truth; `add`/`remove` update settings and sync watchers,
 *   and `start()` restores from settings (including direct external changes to `watchFolders` through Settings).
 * - Import new videos after their size stabilizes and Windows writers release them; enqueue automatically when `autoAnalyze` is enabled.
 * - Missing or removed folders do not throw; keep them in the list (`missing()` marks them missing) and warn only once.
 *   Retry quietly every `retryMs` (30 seconds by default) while the app is running and after each settings change.
 *   Close a watcher when its folder is deleted and create a new watcher if the folder is recreated.
 * - Close watchers that finish starting after `stop()` immediately (checked with a generation number); `stop()` also closes watchers that are still starting.
 *
 * Known limitation (startup scanning is intentionally omitted): the watcher uses `ignoreInitial: true`, so videos added to
 * watched folders while the app is closed are **not** imported automatically on next startup (use "Import folder"). Startup scanning is omitted
 * because videos removed from the library (without deleting their files) would reappear on every startup.
 */
export class WatchManager extends EventEmitter {
  private opts: WatchManagerOptions
  private watchers = new Map<string, { dir: string; watcher: FSWatcher }>()
  private activating = new Map<string, Activating>()
  private warned = new Set<string>()
  private unsubscribe: (() => void) | null = null
  private retryTimer: ReturnType<typeof setInterval> | null = null
  private started = false
  /** Incremented on every stop(); immediately close a starting watcher if the generation changed before it was ready. */
  private generation = 0

  constructor(opts: WatchManagerOptions) {
    super()
    this.opts = opts
  }

  /** Start watching from settings and subscribe to changes; repeated calls have no effect. */
  start(): void {
    if (this.started) {
      return
    }
    this.started = true
    this.syncFromSettings(this.opts.settings.get().watchFolders)
    this.unsubscribe = this.opts.settings.onChange((s) => this.syncFromSettings(s.watchFolders))
    this.ensureRetryTimer()
  }

  /**
   * Add a watched folder: validate with the shared validator (absolute path, exists, directory; otherwise throw an error with a reason),
   * update settings, and return only after the watcher is ready. Alternate spellings of the same folder are treated as one.
   * Returns false when settings could not be written; the change still applies in memory and a retry rewrites it.
   */
  async add(dir: string): Promise<boolean> {
    const resolved = validateWatchDir(dir)
    const key = watchKey(resolved)
    const current = this.opts.settings.get().watchFolders
    // Set even when already listed, so a retry rewrites settings left unsaved by a failed write.
    const { persisted } = this.opts.settings.set({ watchFolders: current.some((d) => watchKey(d) === key) ? current : [...current, resolved] })
    this.ensureRetryTimer()
    await this.activateIfPossible(key, resolved)
    this.emit('update')
    return persisted
  }

  /** Remove a watched folder (safe when it is not in the list): stop its watcher and remove it from settings. */
  async remove(dir: string): Promise<boolean> {
    if (typeof dir !== 'string') {
      return true
    }
    const key = watchKey(dir)
    const current = this.opts.settings.get().watchFolders
    const { persisted } = this.opts.settings.set({ watchFolders: current.filter((d) => watchKey(d) !== key) })
    this.deactivate(key)
    this.warned.delete(key)
    this.emit('update')
    return persisted
  }

  /** Watched-folder list (settings order; includes folders that are currently missing). */
  list(): string[] {
    return [...this.opts.settings.get().watchFolders]
  }

  /** Entries in the list that are currently missing or are not directories. */
  missing(): string[] {
    return this.list().filter((dir) => !isDirectory(dir))
  }

  /** Folders watched by active watchers (for diagnostics/tests). */
  activeDirs(): string[] {
    return [...this.watchers.values()].map((w) => w.dir)
  }

  /** Close all watchers, including those still starting; `start()` can be called again afterwards. */
  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.started = false
    this.generation++
    if (this.retryTimer) {
      clearInterval(this.retryTimer)
      this.retryTimer = null
    }
    for (const a of [...this.activating.values()]) {
      a.cancel()
    }
    this.activating.clear()
    for (const key of [...this.watchers.keys()]) {
      this.deactivate(key)
    }
  }

  /** Wait for all currently starting watchers to become ready (used by IPC/tests to avoid missing events). */
  async whenReady(): Promise<void> {
    while (this.activating.size > 0) {
      await Promise.all([...this.activating.values()].map((a) => a.promise))
    }
  }

  /** Sync watchers with the settings list: start added folders, close removed ones, and warn once then skip invalid/missing folders. */
  private syncFromSettings(dirs: string[]): void {
    const wanted = new Map<string, string>()
    for (const dir of dirs) {
      if (typeof dir !== 'string' || !path.isAbsolute(dir)) {
        this.warnOnce(`invalid:${String(dir)}`, `[Watch] 忽略無效的監看路徑（需為絕對路徑）：${String(dir)}`)
        continue
      }
      const key = watchKey(dir)
      if (!wanted.has(key)) {
        wanted.set(key, path.resolve(dir))
      }
    }
    for (const key of [...this.watchers.keys()]) {
      if (!wanted.has(key)) {
        this.deactivate(key)
      }
    }
    for (const [key, dir] of wanted) {
      void this.activateIfPossible(key, dir)
    }
  }

  /** Periodically detect vanished folders (close dead watchers) and retry missing ones. */
  private tick(): void {
    let changed = false
    const wanted = new Map<string, string>()
    for (const dir of this.opts.settings.get().watchFolders) {
      if (typeof dir === 'string' && path.isAbsolute(dir)) {
        wanted.set(watchKey(dir), path.resolve(dir))
      }
    }
    for (const [key, w] of [...this.watchers]) {
      if (!isDirectory(w.dir)) {
        this.deactivate(key)
        this.warnOnce(key, `[Watch] 資料夾已消失，保留清單並每 ${this.retryMs() / 1000} 秒重試：${w.dir}`)
        changed = true
      }
    }
    for (const [key, dir] of wanted) {
      if (!this.watchers.has(key) && !this.activating.has(key) && isDirectory(dir)) {
        void this.activateIfPossible(key, dir).then(() => this.emit('update'))
      }
    }
    if (changed) {
      this.emit('update')
    }
  }

  private retryMs(): number {
    return this.opts.retryMs ?? DEFAULT_RETRY_MS
  }

  private ensureRetryTimer(): void {
    if (this.retryTimer) {
      return
    }
    this.retryTimer = setInterval(() => this.tick(), this.retryMs())
    this.retryTimer.unref?.()
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) {
      return
    }
    this.warned.add(key)
    console.warn(message)
  }

  private activateIfPossible(key: string, dir: string): Promise<void> {
    const inFlight = this.activating.get(key)
    if (inFlight) {
      return inFlight.promise
    }
    if (this.watchers.has(key)) {
      return Promise.resolve()
    }
    let valid: string
    try {
      valid = validateWatchDir(dir)
    } catch (err) {
      this.warnOnce(key, `[Watch] ${(err as Error).message}（保留清單並標記缺失，之後安靜重試）`)
      return Promise.resolve()
    }
    const entry = this.activate(key, valid)
    this.activating.set(key, entry)
    return entry.promise
  }

  private activate(key: string, dir: string): Activating {
    const gen = this.generation
    const create = this.opts.createWatcher ?? defaultFactory
    const watcher = create(dir, (paths) => this.handleNewFiles(paths), {
      stabilityMs: this.opts.stabilityMs ?? DEFAULT_STABILITY_MS,
      pollMs: this.opts.pollMs ?? DEFAULT_POLL_MS
    })
    watcher.on('error', (err) => {
      console.warn(`[Watch] 監看錯誤（${dir}）：`, err)
    })
    let settled = false
    let resolveFn!: () => void
    const promise = new Promise<void>((resolve) => {
      resolveFn = resolve
    })
    // Safety net: do not leave the caller (IPC) blocked if ready never fires.
    const timer = setTimeout(() => finish(), 10000)
    const entry: Activating = {
      promise,
      cancel: () => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        void watcher.close()
        resolveFn()
      }
    }
    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (this.activating.get(key) === entry) {
        this.activating.delete(key)
      }
      const stillWanted = this.opts.settings
        .get()
        .watchFolders.some((d) => typeof d === 'string' && watchKey(d) === key)
      // Startup completed after stop(), or the folder was removed while starting: do not leave an orphan watcher.
      if (gen !== this.generation || !stillWanted) {
        void watcher.close()
      } else {
        this.watchers.set(key, { dir, watcher })
        this.warned.delete(key)
      }
      resolveFn()
    }
    watcher.once('ready', finish)
    return entry
  }

  private deactivate(key: string): void {
    const active = this.watchers.get(key)
    if (active) {
      this.watchers.delete(key)
      void active.watcher.close()
    }
    const pending = this.activating.get(key)
    if (pending) {
      this.activating.delete(key)
      pending.cancel()
    }
  }

  /** New file (after it stabilizes): import only supported extensions and enqueue when autoAnalyze is enabled. */
  private handleNewFiles(paths: string[]): void {
    const files = paths.filter((p) =>
      !p.split(/[\\/]/).some((part) => part.toLowerCase() === '.sessions') &&
      !/\.(?:part|partial)\.[^.\/]+$/i.test(p) &&
      SUPPORTED_EXTS.has(path.extname(p).toLowerCase()))
    if (files.length === 0) {
      return
    }
    const added = this.opts.library.add(files)
    if (added.length === 0) {
      return
    }
    if (this.opts.settings.get().autoAnalyze) {
      for (const entry of added) {
        this.opts.queue.enqueue(entry.path)
      }
    }
    this.emit('update')
  }
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}
