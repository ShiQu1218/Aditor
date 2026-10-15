import fs from 'fs'
import path from 'path'
import { DEFAULT_SETTINGS, SETTINGS_VERSION, Settings } from '../shared/settings'
import { AutoClipParams } from '../shared/types'

/** 數值欄位允許範圍（含端點；與 spec §3.2／§3.3 一致） */
const RANGES = {
  before: { min: 0, max: 30 },
  after: { min: 0, max: 30 },
  autoclip: {
    n: { min: 1, max: 10 },
    gap: { min: 5, max: 60 },
    before: { min: 0, max: 30 },
    after: { min: 0, max: 30 },
    max_len: { min: 15, max: 300 }
  }
} as const

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

/** 深拷貝（避免呼叫端改到內部狀態或 DEFAULT_SETTINGS）。 */
function cloneSettings(s: Settings): Settings {
  return { ...s, watchFolders: [...s.watchFolders], autoclip: { ...s.autoclip } }
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
    lastProjectId: pickStringOrNull(s.lastProjectId, base.lastProjectId)
  }
}

/**
 * 把任意來源（舊版／損毀欄位）的原始資料遷移並正規化為現行設定：
 * `version` 缺失或較舊一律視為舊版，已知且合法的值保留、其餘逐欄位回退預設。
 */
export function migrateSettings(raw: unknown): Settings {
  return applySettings(cloneSettings(DEFAULT_SETTINGS), raw)
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
 * `set(partial)` 只套用合法欄位、寫檔並通知訂閱者；寫檔失敗時記憶體仍更新（下次 set 會再嘗試）。
 */
export class SettingsStore {
  private file: string
  private settings: Settings
  private listeners: Array<(s: Settings) => void> = []

  constructor(file: string) {
    this.file = file
    this.settings = loadSettings(file)
  }

  get(): Settings {
    return cloneSettings(this.settings)
  }

  set(partial: Partial<Settings>): Settings {
    this.settings = applySettings(this.settings, partial)
    saveSettings(this.file, this.settings)
    const snapshot = cloneSettings(this.settings)
    for (const cb of [...this.listeners]) {
      cb(snapshot)
    }
    return snapshot
  }

  /** 訂閱變更；回傳解除訂閱函式。 */
  onChange(cb: (s: Settings) => void): () => void {
    this.listeners.push(cb)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb)
    }
  }
}
