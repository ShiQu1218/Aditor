import { AutoClipParams } from './types'
import { DEFAULT_RECORDING_SETTINGS, type RecordingSettings } from './recording'
import type { LanguageSetting } from './locale'

/** Settings file format version; increment when the format changes and handle older versions in `migrateSettings`. */
export const SETTINGS_VERSION = 2

/**
 * Application settings (`%APPDATA%\Aditor\settings.json`).
 * See spec §3.3 for field meanings; main's `set`/`migrateSettings` validate value ranges (spec §3.2).
 */
export interface Settings {
  version: typeof SETTINGS_VERSION
  /** UI language: 'auto' follows the system (Windows display language); unsupported system languages use English. */
  language: LanguageSetting
  /**
   * Storage root directory (see shared/storage.ts): recordings go to `<root>/Recordings/<date>/`, and clip exports go to
   * `<root>/Exports/Merged` and `<root>/Exports/Clips`. null means unset. When configured, main also writes
   * `recording.outputDir` and `defaultOutDir` and creates the directories; other code continues reading those two fields.
   */
  storageRoot: string | null
  /** Whether the first-run onboarding is complete. */
  onboardingDone: boolean
  /** Watched folders (new videos are imported automatically). */
  watchFolders: string[]
  /** Automatically enqueue new videos in watched folders for analysis. */
  autoAnalyze: boolean
  /** Decode mode: 'auto' prefers hardware; 'software' uses software only. */
  decode: 'auto' | 'software'
  /** Cache location: 'appdata' (%APPDATA%) or beside the video. */
  cacheLocation: 'appdata' | 'besideVideo'
  /** Low-performance mode: disable animations and reduce heatmap resolution. */
  lowPerfMode: boolean
  /** Suggest generating a proxy for videos that cannot be played. */
  proxySuggest: boolean
  /** Preview playback volume (0..100); does not affect recording or export. */
  previewVolume: number
  previewMuted: boolean
  /** Quick clip: seconds before the event (0..30). */
  before: number
  /** Quick clip: seconds after the event (0..30). */
  after: number
  /** Default AI auto-clip parameters (n 1..10, gap 5..60, before/after 0..30, max_len 15..300). */
  autoclip: AutoClipParams
  /** Automatically place AI suggestions when opening a video. */
  autoSuggestOnOpen: boolean
  /** Automatically save projects (when disabled, restore the "unsaved changes" prompt behavior). */
  projectAutosave: boolean
  /** Automatically check GitHub for updates; discovery never downloads or installs (installed builds only; manual checks are unaffected). */
  autoUpdate: boolean
  /** Sentry diagnostics are on by default; an explicit opt-out is preserved. Enabling takes effect after restart. */
  telemetryEnabled: boolean
  /** Default export folder (null prompts each time). */
  defaultOutDir: string | null
  /** Whether project tracks are collapsed by default: 'auto' collapses when the window is ≤800px tall, or use a fixed boolean. */
  projectTrackCollapsed: 'auto' | boolean
  /** Whether same-day video rows are collapsed in Studio. */
  sameDayVideosCollapsed: boolean
  /** ID of the last opened project (restored at startup). */
  lastProjectId: string | null
  /** Whether the user has been asked to enable low-performance mode (asked once if no hardware decoding is detected at first launch). */
  lowPerfAsked: boolean
  /** Game recording settings; validated and persisted by main. */
  recording: RecordingSettings
}

/** Numeric range, inclusive of both endpoints. */
export interface SettingsRange {
  readonly min: number
  readonly max: number
}

/** Allowed ranges for numeric fields, inclusive and matching spec §3.2/§3.3. The single source shared by main validation and settings UI clamping. */
export const SETTINGS_RANGES = {
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

/** `settings:set` result: effective settings, whether they were written to disk, and field errors from path validation. */
export interface SettingsSetResult {
  settings: Settings
  /** false means memory was updated but writing the file failed (the change will not persist after restart). */
  persisted: boolean
  /** Path-field validation errors from main (the affected field was not applied). */
  errors?: Partial<Record<'defaultOutDir' | 'recordingOutputDir' | 'obsPassword' | 'storageRoot', string>>
}

/** Default settings; used for first-time users without a settings file, preserving the previous behavior. */
export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  language: 'auto',
  storageRoot: null,
  onboardingDone: false,
  watchFolders: [],
  autoAnalyze: true,
  decode: 'auto',
  cacheLocation: 'appdata',
  lowPerfMode: false,
  proxySuggest: true,
  previewVolume: 100,
  previewMuted: false,
  before: 8,
  after: 4,
  autoclip: { n: 3, gap: 20, before: 8, after: 4, max_len: 90 },
  autoSuggestOnOpen: true,
  projectAutosave: true,
  autoUpdate: true,
  telemetryEnabled: true,
  defaultOutDir: null,
  projectTrackCollapsed: 'auto',
  sameDayVideosCollapsed: false,
  lastProjectId: null,
  lowPerfAsked: false,
  recording: { ...DEFAULT_RECORDING_SETTINGS }
}
