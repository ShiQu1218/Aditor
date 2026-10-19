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
import type { RecordingSettings, RecorderCapabilities, ObsTestResult } from '../../shared/recording'
import { tr } from '../../shared/locale'

interface WatchStatus {
  ok?: boolean
  canceled?: boolean
  error?: string
  dirs: string[]
  missing: string[]
}

/** 設定畫面用到的 window.api 子集（全部以此型別存取，缺少的部分優雅降級）。 */
export interface SettingsApi {
  recording?: { getCapabilities(): Promise<RecorderCapabilities | null>; testObs?(): Promise<ObsTestResult> }
  settings: {
    get(): Promise<Settings>
    set(partial: Partial<Settings>): Promise<SettingsSetResult | unknown>
    /** 建議的儲存根資料夾（舊版 preload 可能沒有） */
    suggestStorageRoot?(): Promise<string>
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
    openFolder?(dir: string): Promise<boolean>
    openh264Status(): Promise<{ installed: boolean }>
    downloadOpenH264?(): Promise<string>
    onOpenH264Progress?(cb: (ratio: number) => void): () => void
  }
}

/** 設定頁的 OpenH264 下載流程：idle → consent（授權說明）→ downloading → idle／error。 */
export interface OpenH264DownloadState {
  step: 'idle' | 'consent' | 'downloading' | 'error'
  ratio: number
  error: string | null
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
  recordingCapabilities: { loading: boolean; value: RecorderCapabilities | null }
  obsConnection: { testing: boolean; result: ObsTestResult | null }
  /** main 建議的儲存根資料夾；null＝尚未取得 */
  suggestedStorageRoot: string | null
  /** null＝未知 */
  openh264: boolean | null
  openh264Download: OpenH264DownloadState
}

export const INITIAL_SETTINGS_STATE: SettingsState = {
  settings: null,
  loadFailed: false,
  saveFailed: false,
  rowErrors: {},
  watch: { dirs: [], missing: [] },
  proxy: { status: 'idle', count: 0, bytes: 0 },
  encoders: { status: 'idle', list: [] },
  recordingCapabilities: { loading: true, value: null },
  obsConnection: { testing: false, result: null },
  suggestedStorageRoot: null,
  openh264: null,
  openh264Download: { step: 'idle', ratio: 0, error: null }
}

/** 會顯示 main 路徑／密碼驗證錯誤的設定列 → `SettingsSetResult.errors` 的鍵。 */
const ROW_ERROR_KEYS: Readonly<Record<string, keyof NonNullable<SettingsSetResult['errors']>>> = {
  storageRoot: 'storageRoot',
  'recording-obsPassword': 'obsPassword'
}

function isSetResult(v: unknown): v is SettingsSetResult {
  return typeof v === 'object' && v !== null && 'settings' in v && 'persisted' in v
}

export class SettingsController {
  private state: SettingsState
  private listeners = new Set<() => void>()
  private unsubscribe: (() => void) | null = null
  private recordingWrites: Promise<void> = Promise.resolve()

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
    await Promise.all([this.loadSettings(), this.refreshWatch(), this.refreshProxy(), this.refreshEncoders(), this.refreshRecordingCapabilities(), this.refreshStorageSuggestion()])
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
      const next = { ...this.state.rowErrors }
      const errorKey = ROW_ERROR_KEYS[rowId]
      if (errorKey) {
        const err = res.errors?.[errorKey]
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

  /** 同時操作多個錄影控制項時依序送出，避免整份快照覆蓋較新的設定。 */
  setRecording<K extends keyof RecordingSettings>(field: K, value: RecordingSettings[K]): Promise<void> {
    this.recordingWrites = this.recordingWrites.then(async () => {
      const base = this.state.settings?.recording ?? DEFAULT_SETTINGS.recording
      await this.commit(`recording-${field}`, { recording: { ...base, [field]: value } })
    })
    return this.recordingWrites
  }

  async testObs(): Promise<void> {
    if (this.state.obsConnection.testing) return
    this.patch({ obsConnection: { testing: true, result: null } })
    // 先等主機、連接埠與密碼寫入主程序，再測試目前持久化的設定。
    await this.recordingWrites
    let result: ObsTestResult
    try { result = await this.api.recording?.testObs?.() ?? { ok: false, error: 'OBS 連線測試無法使用' } }
    catch { result = { ok: false, error: 'OBS 連線測試失敗，請檢查設定' } }
    this.patch({ obsConnection: { testing: false, result } })
  }

  async refreshRecordingCapabilities(): Promise<void> {
    try {
      const value = await this.api.recording?.getCapabilities() ?? null
      this.patch({ recordingCapabilities: { loading: false, value } })
    } catch {
      this.patch({ recordingCapabilities: { loading: false, value: null } })
    }
  }

  setEnum(field: 'decode' | 'cacheLocation' | 'language', value: string): Promise<void> {
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

  // ── 儲存位置（錄影與剪輯輸出的根資料夾；main 會同步 recording.outputDir／defaultOutDir） ──
  async refreshStorageSuggestion(): Promise<void> {
    try {
      const dir = await this.api.settings.suggestStorageRoot?.()
      this.patch({ suggestedStorageRoot: typeof dir === 'string' && dir !== '' ? dir : null })
    } catch {
      this.patch({ suggestedStorageRoot: null })
    }
  }

  async pickStorageRoot(): Promise<void> {
    const pick = this.api.export?.selectOutDir
    if (!pick) return
    let dir: string | null
    try {
      dir = await pick()
    } catch {
      this.setRowError('storageRoot', tr('無法選擇資料夾，請再試一次。'))
      return
    }
    if (!dir) return
    await this.commit('storageRoot', { storageRoot: dir })
    await this.refreshStorageSuggestion()
  }

  /** 在檔案總管開啟儲存位置；尚未設定時不做事。 */
  async openStorageRoot(): Promise<void> {
    const dir = this.state.settings?.storageRoot
    if (!dir) return
    try {
      await this.api.export?.openFolder?.(dir)
    } catch {
      // 開啟失敗不影響設定
    }
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

  // ── OpenH264 下載（授權同意後才下載；不論有無硬體編碼器都可手動安裝／重新下載） ──
  requestOpenH264Download(): void {
    if (!this.api.export?.downloadOpenH264) return
    if (this.state.openh264Download.step === 'downloading') return
    this.patch({ openh264Download: { step: 'consent', ratio: 0, error: null } })
  }

  cancelOpenH264Download(): void {
    if (this.state.openh264Download.step === 'downloading') return
    this.patch({ openh264Download: { step: 'idle', ratio: 0, error: null } })
  }

  async confirmOpenH264Download(): Promise<void> {
    const exp = this.api.export
    if (!exp?.downloadOpenH264 || this.state.openh264Download.step === 'downloading') return
    this.patch({ openh264Download: { step: 'downloading', ratio: 0, error: null } })
    const off = exp.onOpenH264Progress?.((ratio) => {
      if (this.state.openh264Download.step === 'downloading') {
        this.patch({ openh264Download: { step: 'downloading', ratio, error: null } })
      }
    })
    try {
      await exp.downloadOpenH264()
    } catch (e) {
      off?.()
      this.patch({ openh264Download: { step: 'error', ratio: 0, error: e instanceof Error ? e.message : String(e) } })
      return
    }
    off?.()
    this.patch({ openh264Download: { step: 'idle', ratio: 1, error: null } })
    await this.refreshEncoders()
  }
}
