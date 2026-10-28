// Settings screen state and IPC: the only layer between the UI and window.api (plain TS, testable in Node).
// Controls always show settings returned or broadcast by main, not the user's raw input.
// Clamp values to the ranges in shared/settings before sending; show “Save failed” when a write fails (persisted=false).
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
import type { UpdateStatus } from '../../shared/update'

interface WatchStatus {
  ok?: boolean
  canceled?: boolean
  error?: string
  dirs: string[]
  missing: string[]
}

/** Subset of window.api used by the settings screen (access through this type and gracefully degrade when parts are missing). */
export interface SettingsApi {
  recording?: { getCapabilities(): Promise<RecorderCapabilities | null>; testObs?(): Promise<ObsTestResult> }
  settings: {
    get(): Promise<Settings>
    set(partial: Partial<Settings>): Promise<SettingsSetResult | unknown>
    /** Suggested storage root folder (may be missing from older preload versions). */
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
  update?: {
    getStatus(): Promise<UpdateStatus>
    check(): Promise<UpdateStatus>
    download(): Promise<boolean>
    install(): Promise<boolean>
    openReleases(): Promise<boolean>
    onStatus(cb: (status: UpdateStatus) => void): () => void
  }
  app?: {
    startupDecode?(): Promise<Settings['decode']>
    relaunch?(): Promise<void>
  }
}

/** OpenH264 download flow for settings: idle → consent (license notice) → downloading → idle/error. */
export interface OpenH264DownloadState {
  step: 'idle' | 'consent' | 'downloading' | 'error'
  ratio: number
  error: string | null
}

export interface SettingsState {
  /** null means not loaded yet. */
  settings: Settings | null
  loadFailed: boolean
  /** The most recent save was not written to disk. */
  saveFailed: boolean
  /** Error message for each row (row id → text). */
  rowErrors: Record<string, string>
  watch: { dirs: string[]; missing: string[] }
  proxy: { status: 'idle' | 'loading' | 'ready' | 'error'; count: number; bytes: number }
  encoders: { status: 'idle' | 'loading' | 'ready'; list: string[] }
  recordingCapabilities: { loading: boolean; value: RecorderCapabilities | null }
  obsConnection: { testing: boolean; result: ObsTestResult | null }
  /** Storage root suggested by main; null means not available yet. */
  suggestedStorageRoot: string | null
  /** null means unknown. */
  openh264: boolean | null
  openh264Download: OpenH264DownloadState
  /** Auto-update status; unsupported when an older preload has no update API. */
  update: UpdateStatus
  /** Decode setting at app startup (preview decoding uses it until restart); null means unknown. */
  startupDecode: Settings['decode'] | null
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
  openh264Download: { step: 'idle', ratio: 0, error: null },
  update: { state: 'unsupported' },
  startupDecode: null
}

/** Settings rows that display main-process path/password validation errors → keys in `SettingsSetResult.errors`. */
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
  private unsubscribeUpdate: (() => void) | null = null
  private recordingWrites: Promise<void> = Promise.resolve()
  private autoclipWrites: Promise<void> = Promise.resolve()

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

  /** Load all data and subscribe to `settings:changed`. */
  async start(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = this.api.settings.onChanged((s) => {
      this.patch({ settings: s })
    })
    this.unsubscribeUpdate?.()
    this.unsubscribeUpdate = this.api.update?.onStatus((update) => this.patch({ update })) ?? null
    await Promise.all([this.loadSettings(), this.refreshWatch(), this.refreshProxy(), this.refreshEncoders(), this.refreshRecordingCapabilities(), this.refreshStorageSuggestion(), this.refreshUpdate(), this.refreshStartupDecode()])
  }

  private async refreshStartupDecode(): Promise<void> {
    try {
      this.patch({ startupDecode: (await this.api.app?.startupDecode?.()) ?? null })
    } catch {
      // Unknown startup value: no restart notice is shown.
    }
  }

  /** Restart to apply the decode setting to preview playback; show the failure on the row if main cannot restart. */
  async relaunch(): Promise<void> {
    try {
      await this.api.app?.relaunch?.()
    } catch (e) {
      this.setRowError('decode', e instanceof Error ? e.message : String(e))
    }
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.unsubscribeUpdate?.()
    this.unsubscribeUpdate = null
  }

  // ── Auto-update (main-process updates are authoritative) ──
  async refreshUpdate(): Promise<void> {
    try {
      const status = await this.api.update?.getStatus()
      if (status) this.patch({ update: status })
    } catch {
      // Keep the current display if the status cannot be read.
    }
  }

  async checkUpdate(): Promise<void> {
    if (!this.api.update) return
    this.patch({ update: { state: 'checking' } })
    try {
      this.patch({ update: await this.api.update.check() })
    } catch (e) {
      this.patch({ update: { state: 'error', error: e instanceof Error ? e.message : String(e) } })
    }
  }

  async downloadUpdate(): Promise<void> {
    if (!this.api.update) return
    // Show progress immediately when starting from "available"; main remains authoritative and broadcasts the result.
    if (this.state.update.state === 'available') {
      this.patch({ update: { state: 'downloading', version: this.state.update.version, percent: 0 } })
    }
    try {
      const started = await this.api.update.download()
      if (!started) await this.refreshUpdate()
    } catch (e) {
      this.patch({ update: { state: 'error', error: e instanceof Error ? e.message : String(e) } })
    }
  }

  async installUpdate(): Promise<void> {
    try {
      await this.api.update?.install()
    } catch {
      // Main sends an error status if the installer fails to start.
    }
  }

  async openReleases(): Promise<void> {
    try {
      await this.api.update?.openReleases()
    } catch {
      // Failure to open the browser does not affect settings.
    }
  }

  private async loadSettings(): Promise<void> {
    try {
      const s = await this.api.settings.get()
      this.patch({ settings: s, loadFailed: false })
    } catch {
      this.patch({ settings: this.state.settings ?? { ...DEFAULT_SETTINGS }, loadFailed: true })
    }
  }

  /** Submit settings and update the screen from the returned value. */
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
      // On IPC failure, the state is unknown; reload it and show a save-failure notice.
      await this.loadSettings()
      this.patch({ saveFailed: true })
    }
  }

  setBool(field: BoolField, value: boolean): Promise<void> {
    return this.commit(field, { [field]: value } as Partial<Settings>)
  }

  /** Submit recording-control changes sequentially so a full snapshot cannot overwrite newer settings. */
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
    // Wait for host, port, and password to be written to main before testing the persisted settings.
    await this.recordingWrites
    let result: ObsTestResult
    try { result = await this.api.recording?.testObs?.() ?? { ok: false, error: tr('OBS 連線測試無法使用') } }
    catch { result = { ok: false, error: tr('OBS 連線測試失敗，請檢查設定') } }
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
      // If parsing fails, do not submit; tell the screen to restore the current setting.
      this.patch({})
      return
    }
    await this.commit('beforeAfter', { [field]: v } as Partial<Settings>)
  }

  /** Sequential like setRecording: each full autoclip object is built from the result of the previous write. */
  setAutoclip(key: keyof AutoClipParams, value: number): Promise<void> {
    const v = clampToRange(SETTINGS_RANGES.autoclip[key], value)
    if (v === null) {
      this.patch({})
      return Promise.resolve()
    }
    this.autoclipWrites = this.autoclipWrites.then(async () => {
      const base = this.state.settings?.autoclip ?? DEFAULT_SETTINGS.autoclip
      await this.commit('autoclip', { autoclip: { ...base, [key]: v } })
    })
    return this.autoclipWrites
  }

  // ── Storage location (root folder for recordings and exports; main syncs recording.outputDir/defaultOutDir) ──
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

  /** Open the storage location in File Explorer; do nothing when it is not configured. */
  async openStorageRoot(): Promise<void> {
    const dir = this.state.settings?.storageRoot
    if (!dir) return
    try {
      await this.api.export?.openFolder?.(dir)
    } catch {
      // Failure to open the folder does not affect settings.
    }
  }

  // ── Watched folders (WatchManager IPC; validation runs in main) ──
  private applyWatch(res: WatchStatus | undefined): void {
    if (res && Array.isArray(res.dirs)) {
      this.patch({ watch: { dirs: res.dirs, missing: Array.isArray(res.missing) ? res.missing : [] } })
    }
  }

  async refreshWatch(): Promise<void> {
    try {
      this.applyWatch(await this.api.library?.getWatchFolders())
    } catch {
      // Keep the current state.
    }
  }

  async addWatchFolder(): Promise<void> {
    if (!this.api.library) return
    try {
      const res = await this.api.library.addWatchFolder()
      this.applyWatch(res)
      this.setRowError('watchFolders', res.ok || res.canceled ? undefined : (res.error ?? tr('無法新增資料夾')))
    } catch (err) {
      this.setRowError('watchFolders', (err as Error).message)
    }
  }

  async removeWatchFolder(dir: string): Promise<void> {
    if (!this.api.library) return
    try {
      const res = await this.api.library.removeWatchFolder(dir)
      this.applyWatch(res)
      this.setRowError('watchFolders', res.ok === false ? (res.error ?? tr('無法移除資料夾')) : undefined)
    } catch (err) {
      this.setRowError('watchFolders', (err as Error).message)
    }
  }

  // ── Proxies ──
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

  /** Delete proxies for every library video (call `proxy.delete` for each); return success/failure counts. */
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

  // ── Encoders ──
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

  // ── OpenH264 download (download only after license consent; manual install/re-download is available with or without a hardware encoder) ──
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
