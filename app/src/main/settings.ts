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
import { LANGUAGE_SETTINGS } from '../shared/locale'
import { isSafeLocalDirPath } from './safe-path'

const RANGES = SETTINGS_RANGES
/** First settings version with the 'auto' capture method. */
const CAPTURE_AUTO_VERSION = 2

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

/** String array: fall back when not an array; remove non-string items from arrays. */
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

/** Validate autoclip fields individually: use fallback for fields with invalid types/ranges and preserve the rest. */
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

/** Clamp recording numeric values; preserve the original value when the type is wrong or the value is non-finite. */
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
    gpu: pickDevice(s.gpu, base.gpu),
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
    captureCursor: pickBool(s.captureCursor, base.captureCursor),
    captureMethod: pickEnum(s.captureMethod, ['auto', 'wgc', 'dda', 'hook'] as const, base.captureMethod),
    openOnGameExit: pickBool(s.openOnGameExit, base.openOnGameExit)
  }
}

/** Deep copy (prevent callers from mutating internal state or DEFAULT_SETTINGS). */
function cloneSettings(s: Settings): Settings {
  return { ...s, watchFolders: [...s.watchFolders], autoclip: { ...s.autoclip }, recording: { ...s.recording } }
}

/**
 * Start with base and apply values from src field by field when their types and ranges are valid:
 * keep base values for invalid/missing fields (do not invalidate the whole object), discard unknown keys, and always use the current version.
 */
function applySettings(base: Settings, src: unknown): Settings {
  const s = isPlainObject(src) ? src : {}
  return {
    version: SETTINGS_VERSION,
    language: pickEnum(s.language, LANGUAGE_SETTINGS, base.language),
    storageRoot: pickStringOrNull(s.storageRoot, base.storageRoot),
    onboardingDone: pickBool(s.onboardingDone, base.onboardingDone),
    watchFolders: pickStringArray(s.watchFolders, base.watchFolders),
    autoAnalyze: pickBool(s.autoAnalyze, base.autoAnalyze),
    decode: pickEnum(s.decode, ['auto', 'software'] as const, base.decode),
    cacheLocation: pickEnum(s.cacheLocation, ['appdata', 'besideVideo'] as const, base.cacheLocation),
    lowPerfMode: pickBool(s.lowPerfMode, base.lowPerfMode),
    proxySuggest: pickBool(s.proxySuggest, base.proxySuggest),
    previewVolume: pickNumber(s.previewVolume, { min: 0, max: 100 }, base.previewVolume),
    previewMuted: pickBool(s.previewMuted, base.previewMuted),
    before: pickNumber(s.before, RANGES.before, base.before),
    after: pickNumber(s.after, RANGES.after, base.after),
    autoclip: pickAutoClip(s.autoclip, base.autoclip),
    autoSuggestOnOpen: pickBool(s.autoSuggestOnOpen, base.autoSuggestOnOpen),
    projectAutosave: pickBool(s.projectAutosave, base.projectAutosave),
    autoUpdate: pickBool(s.autoUpdate, base.autoUpdate),
    telemetryEnabled: pickBool(s.telemetryEnabled, base.telemetryEnabled),
    defaultOutDir: pickStringOrNull(s.defaultOutDir, base.defaultOutDir),
    projectTrackCollapsed: pickProjectTrackCollapsed(s.projectTrackCollapsed, base.projectTrackCollapsed),
    sameDayVideosCollapsed: pickBool(s.sameDayVideosCollapsed, base.sameDayVideosCollapsed),
    lastProjectId: pickStringOrNull(s.lastProjectId, base.lastProjectId),
    lowPerfAsked: pickBool(s.lowPerfAsked, base.lowPerfAsked),
    recording: pickRecording(s.recording, base.recording)
  }
}

/**
 * Migrate and normalize raw data from any source (legacy/invalid fields) into current settings:
 * treat a missing or older `version` as legacy, preserve known valid values, and fall back to defaults for other fields individually.
 */
export function migrateSettings(raw: unknown): Settings {
  let migrated = applySettings(cloneSettings(DEFAULT_SETTINGS), raw)
  const rawVersion = isPlainObject(raw) && typeof raw.version === 'number' ? raw.version : 0
  // Version 1 saved the then-default WGC whether or not the user chose it; DDA was never the default, so it is kept.
  if (rawVersion < CAPTURE_AUTO_VERSION && migrated.recording.captureMethod === 'wgc') {
    migrated = { ...migrated, recording: { ...migrated.recording, captureMethod: 'auto' } }
  }
  if (migrated.recording.outputDir !== null) {
    // An unavailable drive must not erase the saved location or redirect recording to another disk.
    migrated.recording.outputDir = isSafeLocalDirPath(migrated.recording.outputDir) ? path.resolve(migrated.recording.outputDir) : null
  }
  // applySettings safely discards unknown fields such as gameLang from legacy settings (removed because detection is language-independent).
  return migrated
}

/**
 * Read settings: missing file → defaults (do not create a file);
 * corrupt JSON → rename the original to `<file>.bak` and return defaults with privacy-sensitive values off unless still visible as on; otherwise normalize through `migrateSettings`.
 * Any other read failure (locked, permission) returns null: the file may hold user choices that must not be replaced.
 */
function readSettings(file: string): Settings | null {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return cloneSettings(DEFAULT_SETTINGS)
    }
    console.error('Failed to read settings:', err)
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    const recovered = corruptDefaults(raw)
    // Write the recovered file so the next read (the store, or the next launch) does not see a missing file and use telemetry-on defaults.
    if (backupCorrupt(file)) saveSettings(file, recovered)
    return recovered
  }
  return migrateSettings(parsed)
}

/** Defaults for a damaged file: privacy-sensitive values stay on only when its surviving text still shows them on. */
function corruptDefaults(raw: string): Settings {
  const s = unreadableDefaults()
  return {
    ...s,
    telemetryEnabled: /"telemetryEnabled"\s*:\s*true\b/.test(raw),
    recording: { ...s.recording, autoRecord: /"autoRecord"\s*:\s*true\b/.test(raw) }
  }
}

/** Defaults for an unreadable file: telemetry and auto-recording stay off rather than overriding a possible opt-out. */
function unreadableDefaults(): Settings {
  const s = cloneSettings(DEFAULT_SETTINGS)
  return { ...s, telemetryEnabled: false, recording: { ...s.recording, autoRecord: false } }
}

export function loadSettings(file: string): Settings {
  return readSettings(file) ?? unreadableDefaults()
}

/** Rename a corrupt file to `<file>.bak` (log failures without affecting the returned defaults). */
function backupCorrupt(file: string): boolean {
  try {
    fs.renameSync(file, `${file}.bak`)
    return true
  } catch (err) {
    console.error('Failed to back up corrupt settings:', err)
    return false
  }
}

/**
 * Atomic write (temporary file + rename): return false on write or `renameSync` failure;
 * preserve the existing file and remove the temporary file.
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
 * The only entry point for in-memory settings state and persistence (main process).
 * `set(partial)` applies only valid fields, notifies subscribers, and returns `{ settings, persisted }`:
 * on write failure memory is still updated and `persisted=false` (the caller must surface this to the user),
 * and every later `set` retries the write even when no fields changed.
 * Do not write when no fields changed and disk is current (leave file contents and modification time unchanged).
 */
export class SettingsStore {
  private file: string
  private settings: Settings
  private listeners: Array<(s: Settings) => void> = []
  /** True when memory is ahead of disk (the previous write failed). */
  private dirty = false
  /** True while the existing file could not be read; writing then would replace the user's saved settings. */
  private unreadable: boolean

  constructor(file: string) {
    this.file = file
    const loaded = readSettings(file)
    this.unreadable = loaded === null
    this.settings = loaded ?? unreadableDefaults()
  }

  get(): Settings {
    return cloneSettings(this.settings)
  }

  set(partial: Partial<Settings>): SettingsSetResult {
    if (this.unreadable) {
      const loaded = readSettings(this.file)
      if (loaded) {
        this.settings = loaded
        this.unreadable = false
      }
    }
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
    if (this.unreadable) {
      persisted = false
    } else if (changed || this.dirty) {
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

  /** Subscribe to changes; return an unsubscribe function. */
  onChange(cb: (s: Settings) => void): () => void {
    this.listeners.push(cb)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb)
    }
  }
}
