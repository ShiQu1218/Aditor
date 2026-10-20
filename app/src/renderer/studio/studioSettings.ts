import { DEFAULT_SETTINGS } from '../../shared/settings'
import type { AutoClipParams } from '../../shared/types'

/** Settings subset actually consumed by the studio (other settings are consumed elsewhere; see the task-17 report for the mapping). */
export interface StudioSettings {
/** Automatically place AI suggestions when opening a video. */
  autoSuggestOnOpen: boolean
/** Default parameters shared by the AI popover and automatic suggestions. */
  autoclip: AutoClipParams
  projectTrackCollapsed: 'auto' | boolean
  sameDayVideosCollapsed: boolean
/** Number of seconds before an event to seek for lead-in. */
  before: number
/** Whether to suggest a proxy when hardware decoding is unavailable or the video is unplayable. */
  proxySuggest: boolean
  previewVolume: number
  previewMuted: boolean
}

export const STUDIO_SETTINGS_DEFAULTS: StudioSettings = {
  autoSuggestOnOpen: DEFAULT_SETTINGS.autoSuggestOnOpen,
  autoclip: DEFAULT_SETTINGS.autoclip,
  projectTrackCollapsed: DEFAULT_SETTINGS.projectTrackCollapsed,
  sameDayVideosCollapsed: DEFAULT_SETTINGS.sameDayVideosCollapsed,
  before: DEFAULT_SETTINGS.before,
  proxySuggest: DEFAULT_SETTINGS.proxySuggest,
  previewVolume: DEFAULT_SETTINGS.previewVolume,
  previewMuted: DEFAULT_SETTINGS.previewMuted
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback
}

/** Convert the untrusted shape from `settings:get`/`settings:changed` into studio settings, falling back to defaults for missing fields. */
export function toStudioSettings(raw: unknown, base: StudioSettings = STUDIO_SETTINGS_DEFAULTS): StudioSettings {
  const s = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const pref = s.projectTrackCollapsed
  return {
    autoSuggestOnOpen: typeof s.autoSuggestOnOpen === 'boolean' ? s.autoSuggestOnOpen : base.autoSuggestOnOpen,
    autoclip: (s.autoclip as AutoClipParams | undefined) ?? base.autoclip,
    projectTrackCollapsed: pref === true || pref === false || pref === 'auto' ? pref : base.projectTrackCollapsed,
    sameDayVideosCollapsed: typeof s.sameDayVideosCollapsed === 'boolean' ? s.sameDayVideosCollapsed : base.sameDayVideosCollapsed,
    before: num(s.before, base.before),
    proxySuggest: typeof s.proxySuggest === 'boolean' ? s.proxySuggest : base.proxySuggest,
    previewVolume: typeof s.previewVolume === 'number' && Number.isFinite(s.previewVolume) && s.previewVolume >= 0 && s.previewVolume <= 100
      ? s.previewVolume : base.previewVolume,
    previewMuted: typeof s.previewMuted === 'boolean' ? s.previewMuted : base.previewMuted
  }
}

/** Seek target when clicking or navigating between events: `before` seconds before the event, never below 0. */
export function leadInSeek(t: number, before: number): number {
  return Math.max(0, t - before)
}

interface SettingsApi {
  settings?: {
    get?: () => Promise<unknown>
    onChanged?: (cb: (s: unknown) => void) => () => void
  }
}

/**
 * Read settings and subscribe to `settings:changed` (changes apply without a restart).
 * A newer changed event is not overwritten by a later get() response; without an API, return defaults immediately; if get() fails, use defaults without automatically placing suggestions.
 * Returns an unsubscribe function.
 */
export function subscribeStudioSettings(api: SettingsApi | undefined, onSettings: (s: StudioSettings) => void): () => void {
  if (!api?.settings?.get) {
    onSettings(STUDIO_SETTINGS_DEFAULTS)
    return () => {}
  }
  let alive = true
  let gotChange = false
  const off = api.settings.onChanged?.((raw) => {
    if (!alive) return
    gotChange = true
    onSettings(toStudioSettings(raw))
  })
  void (async () => {
    try {
      const raw = await api.settings!.get!()
      if (alive && !gotChange) onSettings(toStudioSettings(raw))
    } catch {
      if (alive && !gotChange) onSettings({ ...STUDIO_SETTINGS_DEFAULTS, autoSuggestOnOpen: false })
    }
  })()
  return () => {
    alive = false
    off?.()
  }
}
