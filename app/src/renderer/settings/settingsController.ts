// 設定畫面的狀態與 IPC：UI 與 window.api 之間唯一的一層（純 TS，可在 node 測試）。
// 原則：控制項顯示的永遠是「main 回傳／廣播的設定」，不是使用者輸入的值；
// 數值在送出前依 shared/settings 的範圍夾限；寫檔失敗（persisted=false）顯示「儲存失敗」。
import {
  DEFAULT_SETTINGS,
  SETTINGS_RANGES,
  type Settings,
  type SettingsSetResult
} from '../../shared/settings'
import type { AutoClipParams } from '../../shared/types'
import { clampToRange } from './settingsModel'
import type { BoolField } from './rows'

interface WatchStatus {
  ok?: boolean
  canceled?: boolean
  error?: string
  dirs: string[]
  missing: string[]
}

/** 設定畫面用到的 window.api 子集（全部以此型別存取，缺少的部分優雅降級）。 */
export interface SettingsApi {
  settings: {
    get(): Promise<Settings>
    set(partial: Partial<Settings>): Promise<SettingsSetResult | unknown>
    onChanged(cb: (s: Settings) => void): () => void
  }
  library?: {
    getEntries(): Promise<Array<{ path: string }>>
    getWatchFolders(): Promise<WatchStatus>
    addWatchFolder(): Promise<WatchStatus>
    removeWatchFolder(dir: string): Promise<WatchStatus>
  }
  proxy?: {
    usage(videoPaths: string[]): Promise<{ count: number; bytes: number }>
    delete(videoPath: string): Promise<boolean>
  }
  export?: {
    detectEncoders(): Promise<string[]>
    selectOutDir(): Promise<string | null>
    openh264Status(): Promise<{ installed: boolean }>
  }
}

export interface SettingsState {
  /** null＝尚未讀取 */
  settings: Settings | null
  loadFailed: boolean
  /** 最近一次儲存沒有寫入磁碟 */
  saveFailed: boolean
  /** 每列的錯誤訊息（列 id → 文字） */
  rowErrors: Record<string, string>
  watch: { dirs: string[]; missing: string[] }
  proxy: { status: 'idle' | 'loading' | 'ready' | 'error'; count: number; bytes: number }
  encoders: { status: 'idle' | 'loading' | 'ready'; list: string[] }
  /** null＝未知 */
  openh264: boolean | null
}

export const INITIAL_SETTINGS_STATE: SettingsState = {
  settings: null,
  loadFailed: false,
  saveFailed: false,
  rowErrors: {},
  watch: { dirs: [], missing: [] },
  proxy: { status: 'idle', count: 0, bytes: 0 },
  encoders: { status: 'idle', list: [] },
  openh264: null
}

function isSetResult(v: unknown): v is SettingsSetResult {
  return typeof v === 'object' && v !== null && 'settings' in v && 'persisted' in v
}

export class SettingsController {
  private state: SettingsState
  private listeners = new Set<() => void>()
  private unsubscribe: (() => void) | null = null

  constructor(
    private api: SettingsApi,
    initial?: Partial<SettingsState>
  ) {
    this.state = { ...INITIAL_SETTINGS_STATE, ...initial }
  }

  getState = (): SettingsState => this.state

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private patch(p: Partial<SettingsState>): void {
    this.state = { ...this.state, ...p }
    this.listeners.forEach((l) => l())
  }

  private setRowError(rowId: string, message: string | undefined): void {
    const next = { ...this.state.rowErrors }
    if (message) next[rowId] = message
    else delete next[rowId]
    this.patch({ rowErrors: next })
  }

  /** 讀取全部資料並訂閱 `settings:changed`。 */
  async start(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = this.api.settings.onChanged((s) => {
      this.patch({ settings: s })
    })
    await Promise.all([this.loadSettings(), this.refreshWatch(), this.refreshProxy(), this.refreshEncoders()])
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private async loadSettings(): Promise<void> {
    try {
      const s = await this.api.settings.get()
      this.patch({ settings: s, loadFailed: false })
    } catch {
      this.patch({ settings: this.state.settings ?? { ...DEFAULT_SETTINGS }, loadFailed: true })
    }
  }

  /** 送出設定並以回傳值為準更新畫面。 */
  private async commit(rowId: string, partial: Partial<Settings>): Promise<void> {
    try {
      const res = await this.api.settings.set(partial)
      if (!isSetResult(res)) throw new Error('unexpected settings:set result')
      const err = res.errors?.defaultOutDir
      const next = { ...this.state.rowErrors }
      if (rowId === 'defaultOutDir') {
        if (err) next[rowId] = err
        else delete next[rowId]
      }
      this.patch({ settings: res.settings, saveFailed: !res.persisted, rowErrors: next })
    } catch {
      // IPC 失敗：無法確認狀態，重新讀取並提示儲存失敗
      await this.loadSettings()
      this.patch({ saveFailed: true })
    }
  }

  setBool(field: BoolField, value: boolean): Promise<void> {
    return this.commit(field, { [field]: value } as Partial<Settings>)
  }

  setEnum(field: 'decode' | 'cacheLocation' | 'gameLang', value: string): Promise<void> {
    return this.commit(field, { [field]: value } as Partial<Settings>)
  }

  async setNumber(field: 'before' | 'after', value: number): Promise<void> {
    const v = clampToRange(SETTINGS_RANGES[field], value)
    if (v === null) {
      // 無法解析：不送出，通知畫面還原成目前的設定值
      this.patch({})
      return
    }
    await this.commit('beforeAfter', { [field]: v } as Partial<Settings>)
  }

  async setAutoclip(key: keyof AutoClipParams, value: number): Promise<void> {
    const v = clampToRange(SETTINGS_RANGES.autoclip[key], value)
    const base = this.state.settings?.autoclip ?? DEFAULT_SETTINGS.autoclip
    if (v === null) {
      this.patch({})
      return
    }
    await this.commit('autoclip', { autoclip: { ...base, [key]: v } })
  }

  // ── 匯出資料夾 ──
  async pickOutDir(): Promise<void> {
    const pick = this.api.export?.selectOutDir
    if (!pick) return
    let dir: string | null
    try {
      dir = await pick()
    } catch {
      return
    }
    if (!dir) return
    await this.commit('defaultOutDir', { defaultOutDir: dir })
  }

  async clearOutDir(): Promise<void> {
    await this.commit('defaultOutDir', { defaultOutDir: null })
  }

  // ── 監看資料夾（WatchManager IPC；驗證在 main） ──
  private applyWatch(res: WatchStatus | undefined): void {
    if (res && Array.isArray(res.dirs)) {
      this.patch({ watch: { dirs: res.dirs, missing: Array.isArray(res.missing) ? res.missing : [] } })
    }
  }

  async refreshWatch(): Promise<void> {
    try {
      this.applyWatch(await this.api.library?.getWatchFolders())
    } catch {
      // 留在目前狀態
    }
  }

  async addWatchFolder(): Promise<void> {
    if (!this.api.library) return
    try {
      const res = await this.api.library.addWatchFolder()
      this.applyWatch(res)
      this.setRowError('watchFolders', res.ok || res.canceled ? undefined : (res.error ?? '無法新增資料夾'))
    } catch (err) {
      this.setRowError('watchFolders', (err as Error).message)
    }
  }

  async removeWatchFolder(dir: string): Promise<void> {
    if (!this.api.library) return
    try {
      const res = await this.api.library.removeWatchFolder(dir)
      this.applyWatch(res)
      this.setRowError('watchFolders', res.ok === false ? (res.error ?? '無法移除資料夾') : undefined)
    } catch (err) {
      this.setRowError('watchFolders', (err as Error).message)
    }
  }

  // ── 代理檔 ──
  private async libraryPaths(): Promise<string[]> {
    const entries = await this.api.library?.getEntries()
    return Array.isArray(entries) ? entries.map((e) => e.path).filter((p) => typeof p === 'string') : []
  }

  async refreshProxy(): Promise<void> {
    if (!this.api.proxy?.usage || !this.api.library) {
      this.patch({ proxy: { status: 'error', count: 0, bytes: 0 } })
      return
    }
    this.patch({ proxy: { ...this.state.proxy, status: 'loading' } })
    try {
      const u = await this.api.proxy.usage(await this.libraryPaths())
      this.patch({ proxy: { status: 'ready', count: u.count, bytes: u.bytes } })
    } catch {
      this.patch({ proxy: { status: 'error', count: 0, bytes: 0 } })
    }
  }

  /** 刪除影片庫內所有影片的代理檔（逐一走 `proxy.delete`）；回傳成功／失敗數。 */
  async deleteProxies(): Promise<{ deleted: number; failed: number }> {
    let deleted = 0
    let failed = 0
    if (this.api.proxy && this.api.library) {
      for (const p of await this.libraryPaths()) {
        try {
          if (await this.api.proxy.delete(p)) deleted += 1
        } catch {
          failed += 1
        }
      }
    }
    await this.refreshProxy()
    return { deleted, failed }
  }

  // ── 編碼器 ──
  async refreshEncoders(): Promise<void> {
    if (!this.api.export) return
    this.patch({ encoders: { ...this.state.encoders, status: 'loading' } })
    try {
      const list = await this.api.export.detectEncoders()
      this.patch({ encoders: { status: 'ready', list: Array.isArray(list) ? list : [] } })
    } catch {
      this.patch({ encoders: { status: 'ready', list: [] } })
    }
    try {
      const st = await this.api.export.openh264Status()
      this.patch({ openh264: !!st?.installed })
    } catch {
      this.patch({ openh264: null })
    }
  }
}
