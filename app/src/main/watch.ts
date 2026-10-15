import { EventEmitter } from 'events'
import fs from 'fs'
import path from 'path'
import type { FSWatcher } from 'chokidar'
import { Library, SUPPORTED_EXTS, watchFolder } from './library'
import type { AnalysisQueue } from './queue'
import type { SettingsStore } from './settings'

export interface WatchManagerOptions {
  library: Library
  queue: AnalysisQueue
  settings: SettingsStore
  /** 檔案大小需穩定的毫秒數（預設 2000；測試注入較小值） */
  stabilityMs?: number
  /** 大小檢查的輪詢間隔毫秒數（預設 200） */
  pollMs?: number
}

/**
 * 監看資料夾管理（main）：
 * - 設定清單（`settings.watchFolders`）為唯一真實來源；`add`／`remove` 寫入設定並同步 watcher，
 *   `start()` 依設定恢復（含外部經設定畫面直接修改 `watchFolders` 的情況）。
 * - 新影片需「大小穩定」後才匯入（chokidar awaitWriteFinish）；`autoAnalyze` 開啟時自動排入佇列。
 * - 資料夾不存在或被移除：不丟錯、記錄 log，清單保留（`missing()` 標記缺失）。
 */
export class WatchManager extends EventEmitter {
  private opts: WatchManagerOptions
  private watchers = new Map<string, FSWatcher>()
  private activating = new Map<string, Promise<void>>()
  private unsubscribe: (() => void) | null = null
  private started = false

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
  }

  /**
   * 新增監看資料夾：驗證絕對路徑、存在且為資料夾（否則丟出含原因的錯誤），
   * 寫入設定並等待 watcher 就緒後才回傳。
   */
  async add(dir: string): Promise<void> {
    if (!path.isAbsolute(dir)) {
      throw new Error(`監看資料夾必須是絕對路徑：${dir}`)
    }
    let stat: fs.Stats
    try {
      stat = fs.statSync(dir)
    } catch {
      throw new Error(`資料夾不存在：${dir}`)
    }
    if (!stat.isDirectory()) {
      throw new Error(`路徑不是資料夾：${dir}`)
    }

    const current = this.opts.settings.get().watchFolders
    if (!current.includes(dir)) {
      this.opts.settings.set({ watchFolders: [...current, dir] })
    }
    await this.activateIfPossible(dir)
    this.emit('update')
  }

  /** 移除監看資料夾（清單沒有時仍安全）：停止 watcher 並從設定移除。 */
  async remove(dir: string): Promise<void> {
    const current = this.opts.settings.get().watchFolders
    if (current.includes(dir)) {
      this.opts.settings.set({ watchFolders: current.filter((d) => d !== dir) })
    }
    this.deactivate(dir)
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

  /** 所有 watcher 關閉；之後 `start()` 可重新啟動。 */
  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.started = false
    for (const dir of [...this.watchers.keys()]) {
      this.deactivate(dir)
    }
  }

  /** 等待目前所有啟動中的 watcher 就緒（供 IPC／測試確保事件不漏接）。 */
  async whenReady(): Promise<void> {
    while (this.activating.size > 0) {
      await Promise.all([...this.activating.values()])
    }
  }

  /** 依設定清單同步 watcher：新增者啟動、移除者關閉；不存在者記錄 log 並略過。 */
  private syncFromSettings(dirs: string[]): void {
    const wanted = new Set(dirs)
    for (const dir of [...this.watchers.keys()]) {
      if (!wanted.has(dir)) {
        this.deactivate(dir)
      }
    }
    for (const dir of dirs) {
      void this.activateIfPossible(dir)
    }
  }

  private activateIfPossible(dir: string): Promise<void> {
    const inFlight = this.activating.get(dir)
    if (inFlight) {
      return inFlight
    }
    if (this.watchers.has(dir)) {
      return Promise.resolve()
    }
    if (!isDirectory(dir)) {
      console.warn(`[Watch] 資料夾不存在，保留清單並標記缺失：${dir}`)
      return Promise.resolve()
    }
    const promise = this.activate(dir).finally(() => {
      this.activating.delete(dir)
    })
    this.activating.set(dir, promise)
    return promise
  }

  private activate(dir: string): Promise<void> {
    return new Promise((resolve) => {
      const watcher = watchFolder(dir, (paths) => this.handleNewFiles(paths), {
        stabilityMs: this.opts.stabilityMs ?? 2000,
        pollMs: this.opts.pollMs ?? 200
      })
      watcher.on('error', (err) => {
        console.warn(`[Watch] 監看錯誤（${dir}）：`, err)
      })
      let settled = false
      const finish = (): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        // 啟動期間被移除：不留孤兒 watcher
        if (!this.opts.settings.get().watchFolders.includes(dir)) {
          void watcher.close()
          resolve()
          return
        }
        this.watchers.set(dir, watcher)
        resolve()
      }
      // 保底：即使 ready 未觸發也不讓呼叫端（IPC）卡住
      const timer = setTimeout(finish, 10000)
      watcher.once('ready', finish)
    })
  }

  private deactivate(dir: string): void {
    const watcher = this.watchers.get(dir)
    if (watcher) {
      this.watchers.delete(dir)
      void watcher.close()
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
