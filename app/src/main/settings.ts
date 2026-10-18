import fs from 'fs'
import path from 'path'
import {
  DEFAULT_SETTINGS,
  SETTINGS_RANGES,
  SETTINGS_VERSION,
  Settings,
  SettingsSetResult
} from '../shared/settings'
import { AutoClipParams } from '../shared/types'
import { RECORDING_RANGES, type RecordingSettings } from '../shared/recording'
import { validateOutDir } from './settings-ipc'

const RANGES = SETTINGS_RANGES

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function pickBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function pickNumber(v: unknown, range: { min: number; max: number }, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= range.min && v <= range.max ? v : fallback
}

function pickStringOrNull(v: unknown, fallback: string | null): string | null {
  return typeof v === 'string' || v === null ? v : fallback
}

/** 字串陣列：非陣列回退；陣列中非字串項目剔除。 */
function pickStringArray(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) {
    return fallback
  }
  return v.filter((x): x is string => typeof x === 'string')
}

function pickEnum<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

function pickProjectTrackCollapsed(v: unknown, fallback: 'auto' | boolean): 'auto' | boolean {
  return v === 'auto' || typeof v === 'boolean' ? v : fallback
}

/** autoclip 逐欄位驗證：型別／範圍不符的欄位回退 fallback，其餘保留。 */
function pickAutoClip(v: unknown, fallback: AutoClipParams): AutoClipParams {
  const src = isPlainObject(v) ? v : {}
  return {
    n: pickNumber(src.n, RANGES.autoclip.n, fallback.n),
    gap: pickNumber(src.gap, RANGES.autoclip.gap, fallback.gap),
    before: pickNumber(src.before, RANGES.autoclip.before, fallback.before),
    after: pickNumber(src.after, RANGES.autoclip.after, fallback.after),
    max_len: pickNumber(src.max_len, RANGES.autoclip.max_len, fallback.max_len)
  }
}

/** 錄影數值夾限；型別錯誤與非有限數值保留原值。 */
function clampRecordingNumber(v: unknown, range: { min: number; max: number }, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(range.max, Math.max(range.min, v)) : fallback
}

function pickDevice(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= 4096 && !v.includes('\0') ? v : fallback
}

function pickRecording(v: unknown, base: RecordingSettings): RecordingSettings {
  const s = isPlainObject(v) ? v : {}
  const codec = pickEnum(s.codec, ['hevc', 'h264', 'av1'] as const, base.codec)
  const candidate = pickDevice(s.encoder, base.encoder)
  const encoder = candidate === 'auto' || ['nvenc', 'amf', 'qsv'].some((vendor) => candidate === `${codec}_${vendor}`)
    ? candidate : 'auto'
  const diskWarnGb = clampRecordingNumber(s.diskWarnGb, RECORDING_RANGES.diskWarnGb, base.diskWarnGb)
  return {
    autoRecord: pickBool(s.autoRecord, base.autoRecord),
    launchAtLogin: pickBool(s.launchAtLogin, base.launchAtLogin),
    closeToTray: pickBool(s.closeToTray, base.closeToTray),
    backend: pickEnum(s.backend, ['builtin', 'obs'] as const, base.backend),
    obsHost: typeof s.obsHost === 'string' && /^[a-zA-Z0-9.:[\]-]+$/.test(s.obsHost.trim()) && s.obsHost.trim().length <= 253
      ? s.obsHost.trim() : base.obsHost,
    obsPort: Number.isInteger(s.obsPort) && Number(s.obsPort) >= 1 && Number(s.obsPort) <= 65535 ? Number(s.obsPort) : base.obsPort,
    obsPasswordEnc: s.obsPasswordEnc === null || (typeof s.obsPasswordEnc === 'string' && s.obsPasswordEnc.length <= 32768 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s.obsPasswordEnc)) ? s.obsPasswordEnc : base.obsPasswordEnc,
    obsFallbackBuiltin: pickBool(s.obsFallbackBuiltin, base.obsFallbackBuiltin),
    mode: pickEnum(s.mode, ['session', 'match'] as const, base.mode),
    outputDir: pickStringOrNull(s.outputDir, base.outputDir),
    codec,
    encoder,
    fps: s.fps === 144 ? 120 : [10, 20, 30, 60, 90, 120].includes(s.fps as number) ? s.fps as RecordingSettings['fps'] : base.fps,
    preset: pickEnum(s.preset, ['speed', 'balanced', 'quality'] as const, base.preset),
    forceAspect: pickBool(s.forceAspect, base.forceAspect),
    aspectMode: pickEnum(s.aspectMode, ['fit', 'stretch'] as const, base.aspectMode),
    height: [0, 720, 1080, 1440].includes(s.height as number) ? s.height as RecordingSettings['height'] : base.height,
    bitrateKbps: clampRecordingNumber(s.bitrateKbps, RECORDING_RANGES.bitrateKbps, base.bitrateKbps),
    renderDevice: pickDevice(s.renderDevice, base.renderDevice),
    captureDevice: pickDevice(s.captureDevice, base.captureDevice),
    systemAudioEnabled: pickBool(s.systemAudioEnabled, base.systemAudioEnabled),
    systemGain: clampRecordingNumber(s.systemGain, RECORDING_RANGES.systemGain, base.systemGain),
    gameAudioOnly: pickBool(s.gameAudioOnly, base.gameAudioOnly),
    micEnabled: pickBool(s.micEnabled, base.micEnabled),
    micMono: pickBool(s.micMono, base.micMono),
    micGain: clampRecordingNumber(s.micGain, RECORDING_RANGES.micGain, base.micGain),
    postAnalysis: pickEnum(s.postAnalysis, ['none', 'afterExit', 'perMatch'] as const, base.postAnalysis),
    diskWarnGb,
    diskStopGb: Math.min(diskWarnGb, clampRecordingNumber(s.diskStopGb, RECORDING_RANGES.diskStopGb, base.diskStopGb)),
    notifyMatch: pickBool(s.notifyMatch, base.notifyMatch),
    captureMethod: pickEnum(s.captureMethod, ['wgc', 'dda'] as const, base.captureMethod)
  }
}

/** 深拷貝（避免呼叫端改到內部狀態或 DEFAULT_SETTINGS）。 */
function cloneSettings(s: Settings): Settings {
  return { ...s, watchFolders: [...s.watchFolders], autoclip: { ...s.autoclip }, recording: { ...s.recording } }
}

/**
 * 以 base 為底，逐欄位套用 src 中「型別正確且在範圍內」的值：
 * 無效／缺少的欄位保留 base 值（整份不作廢）、未知鍵丟棄、version 一律為現行版本。
 */
function applySettings(base: Settings, src: unknown): Settings {
  const s = isPlainObject(src) ? src : {}
  return {
    version: SETTINGS_VERSION,
    watchFolders: pickStringArray(s.watchFolders, base.watchFolders),
    autoAnalyze: pickBool(s.autoAnalyze, base.autoAnalyze),
    decode: pickEnum(s.decode, ['auto', 'software'] as const, base.decode),
    cacheLocation: pickEnum(s.cacheLocation, ['appdata', 'besideVideo'] as const, base.cacheLocation),
    lowPerfMode: pickBool(s.lowPerfMode, base.lowPerfMode),
    proxySuggest: pickBool(s.proxySuggest, base.proxySuggest),
    before: pickNumber(s.before, RANGES.before, base.before),
    after: pickNumber(s.after, RANGES.after, base.after),
    autoclip: pickAutoClip(s.autoclip, base.autoclip),
    autoSuggestOnOpen: pickBool(s.autoSuggestOnOpen, base.autoSuggestOnOpen),
    projectAutosave: pickBool(s.projectAutosave, base.projectAutosave),
    defaultOutDir: pickStringOrNull(s.defaultOutDir, base.defaultOutDir),
    projectTrackCollapsed: pickProjectTrackCollapsed(s.projectTrackCollapsed, base.projectTrackCollapsed),
    sameDayVideosCollapsed: pickBool(s.sameDayVideosCollapsed, base.sameDayVideosCollapsed),
    lastProjectId: pickStringOrNull(s.lastProjectId, base.lastProjectId),
    lowPerfAsked: pickBool(s.lowPerfAsked, base.lowPerfAsked),
    recording: pickRecording(s.recording, base.recording)
  }
}

/**
 * 把任意來源（舊版／損毀欄位）的原始資料遷移並正規化為現行設定：
 * `version` 缺失或較舊一律視為舊版，已知且合法的值保留、其餘逐欄位回退預設。
 */
export function migrateSettings(raw: unknown): Settings {
  const migrated = applySettings(cloneSettings(DEFAULT_SETTINGS), raw)
  if (migrated.recording.outputDir !== null) {
    try {
      migrated.recording.outputDir = validateOutDir(migrated.recording.outputDir)
    } catch {
      migrated.recording.outputDir = null
    }
  }
  // 舊設定檔的 gameLang（已移除：偵測與語言無關）等未知欄位由 applySettings 安全丟棄
  return migrated
}

/**
 * 讀取設定檔：檔案不存在 → 預設值（不建立檔案）；
 * JSON 損毀 → 原檔改名 `<file>.bak` 後回預設；其餘走 `migrateSettings` 正規化。
 */
export function loadSettings(file: string): Settings {
  let raw: string
  try {
    if (!fs.existsSync(file)) {
      return cloneSettings(DEFAULT_SETTINGS)
    }
    raw = fs.readFileSync(file, 'utf-8')
  } catch (err) {
    console.error('Failed to read settings:', err)
    return cloneSettings(DEFAULT_SETTINGS)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    backupCorrupt(file)
    return cloneSettings(DEFAULT_SETTINGS)
  }
  return migrateSettings(parsed)
}

/** 損毀檔案改名為 `<file>.bak`（失敗只記錄，不影響回傳預設值）。 */
function backupCorrupt(file: string): void {
  try {
    fs.renameSync(file, `${file}.bak`)
  } catch (err) {
    console.error('Failed to back up corrupt settings:', err)
  }
}

/**
 * 原子寫入（暫存檔＋rename）：寫入失敗或 `renameSync` 失敗時回傳 false，
 * 既有檔案保持完好、暫存檔清除。
 */
export function saveSettings(file: string, s: Settings): boolean {
  const tmp = `${file}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf-8')
    fs.renameSync(tmp, file)
    return true
  } catch (err) {
    console.error('Failed to save settings:', err)
    try {
      if (fs.existsSync(tmp)) {
        fs.unlinkSync(tmp)
      }
    } catch {}
    return false
  }
}

/**
 * 設定記憶體狀態＋持久化的唯一入口（main process）。
 * `set(partial)` 只套用合法欄位並通知訂閱者，回傳 `{ settings, persisted }`：
 * 寫檔失敗時記憶體仍更新、`persisted=false`（呼叫端必須讓使用者看見），
 * 之後任何一次 `set`（即使沒有欄位變更）都會再嘗試補寫。
 * 沒有任何欄位實際變更且磁碟已是最新時不寫檔（磁碟內容與修改時間保持不變）。
 */
export class SettingsStore {
  private file: string
  private settings: Settings
  private listeners: Array<(s: Settings) => void> = []
  /** 記憶體領先磁碟（上次寫檔失敗）時為 true */
  private dirty = false

  constructor(file: string) {
    this.file = file
    this.settings = loadSettings(file)
  }

  get(): Settings {
    return cloneSettings(this.settings)
  }

  set(partial: Partial<Settings>): SettingsSetResult {
    const next = applySettings(this.settings, partial)
    const errors: NonNullable<SettingsSetResult['errors']> = {}
    const recordingInput = isPlainObject(partial.recording) ? partial.recording : {}
    if ('outputDir' in recordingInput && recordingInput.outputDir !== null) {
      try {
        next.recording.outputDir = validateOutDir(recordingInput.outputDir)
      } catch (err) {
        errors.recordingOutputDir = (err as Error).message
        next.recording.outputDir = this.settings.recording.outputDir
      }
    }
    const changed = JSON.stringify(next) !== JSON.stringify(this.settings)
    this.settings = next
    let persisted = true
    if (changed || this.dirty) {
      persisted = saveSettings(this.file, this.settings)
      this.dirty = !persisted
    }
    const snapshot = cloneSettings(this.settings)
    for (const cb of [...this.listeners]) {
      try {
        cb(cloneSettings(snapshot))
      } catch (err) {
        console.error('Settings listener failed:', err)
      }
    }
    return Object.keys(errors).length > 0 ? { settings: snapshot, persisted, errors } : { settings: snapshot, persisted }
  }

  /** 訂閱變更；回傳解除訂閱函式。 */
  onChange(cb: (s: Settings) => void): () => void {
    this.listeners.push(cb)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb)
    }
  }
}
