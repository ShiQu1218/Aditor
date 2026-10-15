import { EventEmitter } from 'events'
import fs from 'fs'
import path from 'path'
import type { FSWatcher } from 'chokidar'
import { Library, SUPPORTED_EXTS, watchFolder } from './library'
import type { AnalysisQueue } from './queue'
import type { SettingsStore } from './settings'

/** 檔案大小需穩定的預設毫秒數與輪詢間隔（`WatchManagerOptions` 未指定時採用） */
export const DEFAULT_STABILITY_MS = 2000
export const DEFAULT_POLL_MS = 200
/** 缺失資料夾的重試／死 watcher 偵測間隔（App 執行期間） */
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
  /** 檔案大小需穩定的毫秒數（預設 2000；測試注入較小值） */
  stabilityMs?: number
  /** 大小檢查的輪詢間隔毫秒數（預設 200） */
  pollMs?: number
  /** 缺失資料夾的重試間隔（預設 30000；測試注入較小值） */
  retryMs?: number
  /** watcher 建立函式（預設 chokidar 包裝；測試可注入假的） */
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
 * 監看資料夾的唯一驗證器（`add`／`start`／設定同步共用）：必須是絕對路徑、存在、且為資料夾。
 * 通過時回傳 `path.resolve` 後的路徑；否則丟出帶 `code` 的 `WatchDirError`（訊息可直接顯示給使用者）。
 */
export function validateWatchDir(dir: unknown): string {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) {
    throw new WatchDirError('relative', `監看資料夾必須是絕對路徑：${String(dir)}`)
  }
  const resolved = path.resolve(dir)
  let stat: fs.Stats
  try {
    stat = fs.statSync(resolved)
  } catch {
    throw new WatchDirError('missing', `資料夾不存在：${resolved}`)
  }
  if (!stat.isDirectory()) {
    throw new WatchDirError('not-directory', `路徑不是資料夾：${resolved}`)
  }
  return resolved
}

/** 路徑比對用的鍵：path.resolve（去尾端分隔符）＋ Windows 不分大小寫，兩種拼法不會開兩個 watcher。 */
export function watchKey(dir: string): string {
  const resolved = path.resolve(dir)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

const defaultFactory: WatcherFactory = (dir, onAdd, opts) => watchFolder(dir, onAdd, opts)

interface Activating {
  promise: Promise<void>
  /** 立刻關閉尚在啟動中的 watcher 並放行等待者（stop()／移除時用） */
  cancel: () => void
}

/**
 * 監看資料夾管理（main）：
 * - 設定清單（`settings.watchFolders`）為唯一真實來源；`add`／`remove` 寫入設定並同步 watcher，
 *   `start()` 依設定恢復（含外部經設定畫面直接修改 `watchFolders` 的情況）。
 * - 新影片需「大小穩定」後才匯入（chokidar awaitWriteFinish）；`autoAnalyze` 開啟時自動排入佇列。
 * - 資料夾不存在或被移除：不丟錯，清單保留（`missing()` 標記缺失），只警告一次；
 *   App 執行期間每 `retryMs`（預設 30 秒）與每次設定變更都會安靜地重試；
 *   資料夾被刪除時關閉失效的 watcher，重建後會得到全新的 watcher。
 * - `stop()` 之後才完成啟動的 watcher 會立刻被關閉（以 generation 世代號判斷），`stop()` 也會關閉啟動中的 watcher。
 *
 * 已知限制（刻意不做啟動掃描）：watcher 使用 `ignoreInitial: true`，所以 App 關閉期間放進
 * 監看資料夾的影片，下次啟動時**不會**自動匯入（請用「匯入資料夾」）。不做啟動掃描的原因：
 * 使用者從影片庫移除（不刪檔）的影片會在每次啟動時復活。
 */
export class WatchManager extends EventEmitter {
  private opts: WatchManagerOptions
  private watchers = new Map<string, { dir: string; watcher: FSWatcher }>()
  private activating = new Map<string, Activating>()
  private warned = new Set<string>()
  private unsubscribe: (() => void) | null = null
  private retryTimer: ReturnType<typeof setInterval> | null = null
  private started = false
  /** stop() 每次 +1；啟動中的 watcher 完成時若世代已變，立刻關閉 */
  private generation = 0

  constructor(opts: WatchManagerOptions) {
    super()
    this.opts = opts
  }

  /** 依設定啟動監看並訂閱設定變更；重複呼叫無效。 */
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
   * 新增監看資料夾：以共用驗證器檢查（絕對路徑、存在、為資料夾，否則丟出含原因的錯誤），
   * 寫入設定並等待 watcher 就緒後才回傳。同一資料夾的不同拼法視為同一個。
   */
  async add(dir: string): Promise<void> {
    const resolved = validateWatchDir(dir)
    const key = watchKey(resolved)
    const current = this.opts.settings.get().watchFolders
    if (!current.some((d) => watchKey(d) === key)) {
      this.opts.settings.set({ watchFolders: [...current, resolved] })
    }
    this.ensureRetryTimer()
    await this.activateIfPossible(key, resolved)
    this.emit('update')
  }

  /** 移除監看資料夾（清單沒有時仍安全）：停止 watcher 並從設定移除。 */
  async remove(dir: string): Promise<void> {
    if (typeof dir !== 'string') {
      return
    }
    const key = watchKey(dir)
    const current = this.opts.settings.get().watchFolders
    if (current.some((d) => watchKey(d) === key)) {
      this.opts.settings.set({ watchFolders: current.filter((d) => watchKey(d) !== key) })
    }
    this.deactivate(key)
    this.warned.delete(key)
    this.emit('update')
  }

  /** 監看清單（依設定順序；包含目前不存在的資料夾）。 */
  list(): string[] {
    return [...this.opts.settings.get().watchFolders]
  }

  /** 清單中目前不存在或不是資料夾的項目。 */
  missing(): string[] {
    return this.list().filter((dir) => !isDirectory(dir))
  }

  /** 目前實際運作中的 watcher 所監看的資料夾（診斷／測試用）。 */
  activeDirs(): string[] {
    return [...this.watchers.values()].map((w) => w.dir)
  }

  /** 所有 watcher（含啟動中者）關閉；之後 `start()` 可重新啟動。 */
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

  /** 等待目前所有啟動中的 watcher 就緒（供 IPC／測試確保事件不漏接）。 */
  async whenReady(): Promise<void> {
    while (this.activating.size > 0) {
      await Promise.all([...this.activating.values()].map((a) => a.promise))
    }
  }

  /** 依設定清單同步 watcher：新增者啟動、移除者關閉；無效／不存在者只警告一次並略過。 */
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

  /** 定時：偵測已消失資料夾（關閉死 watcher）並重試缺失者。 */
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
    // 保底：即使 ready 未觸發也不讓呼叫端（IPC）卡住
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
      // stop() 之後才完成啟動、或啟動期間被移除：不留孤兒 watcher
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

  /** 新檔（穩定後）：支援的副檔名才匯入；autoAnalyze 開啟時排入佇列。 */
  private handleNewFiles(paths: string[]): void {
    const files = paths.filter((p) => SUPPORTED_EXTS.has(path.extname(p).toLowerCase()))
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
