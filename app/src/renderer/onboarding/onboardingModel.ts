// Pure logic for the first-run onboarding: visibility, draft defaults, settings payload, and submission flow (no UI; testable in Node).
import { DEFAULT_RECORDING_SETTINGS, type RecordingSettings } from '../../shared/recording'
import type { Settings, SettingsSetResult } from '../../shared/settings'
import { tr } from '../../shared/locale'

/** Onboarding step order: welcome and language, storage location, recording settings, and completion. */
export const ONBOARDING_STEPS = ['welcome', 'storage', 'recording', 'done'] as const
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]

/** Values selected during onboarding; settings are written once on completion. */
export interface OnboardingDraft {
  /** Storage root folder; an empty string means no suggested value has been loaded. */
  storageRoot: string
  mode: RecordingSettings['mode']
  height: RecordingSettings['height']
  fps: RecordingSettings['fps']
  bitrateKbps: number
}

/** Payload sent to `settings:set`. */
export interface OnboardingPatch {
  storageRoot?: string
  onboardingDone: true
  recording?: Pick<RecordingSettings, 'mode' | 'height' | 'fps' | 'bitrateKbps'>
}

/** Subset of window.api used by onboarding. */
export interface OnboardingApi {
  settings: {
    set(partial: unknown): Promise<unknown>
    suggestStorageRoot?(): Promise<string>
  }
  export?: { selectOutDir?(): Promise<string | null> }
}

export type OnboardingResult = { ok: true } | { ok: false; error: string }

/** Show only after settings load and before onboarding has been completed. */
export function shouldShowOnboarding(settings: Settings | null): boolean {
  return settings !== null && settings.onboardingDone === false
}

/** Draft defaults; recording fields come from DEFAULT_RECORDING_SETTINGS. */
export function defaultDraft(storageRoot: string): OnboardingDraft {
  const { mode, height, fps, bitrateKbps } = DEFAULT_RECORDING_SETTINGS
  return { storageRoot, mode, height, fps, bitrateKbps }
}

/** "Get started": write the storage location, completion flag, and four recording fields at once. */
export function buildFinishPatch(draft: OnboardingDraft): OnboardingPatch {
  const { mode, height, fps, bitrateKbps } = draft
  return {
    ...(draft.storageRoot ? { storageRoot: draft.storageRoot } : {}),
    onboardingDone: true,
    recording: { mode, height, fps, bitrateKbps }
  }
}

/** "Maybe later": mark onboarding complete and leave all other settings at their defaults. */
export const SKIP_PATCH: OnboardingPatch = { onboardingDone: true }

function isSetResult(v: unknown): v is SettingsSetResult {
  return typeof v === 'object' && v !== null && 'settings' in v && 'persisted' in v
}

/** Submit settings; return an error if main reports an unusable storage location (onboarding cannot be dismissed). */
export async function submitOnboarding(api: OnboardingApi, patch: OnboardingPatch): Promise<OnboardingResult> {
  try {
    const res = await api.settings.set(patch)
    if (!isSetResult(res)) return { ok: false, error: tr('無法儲存設定，請再試一次。') }
    if (res.errors?.storageRoot) return { ok: false, error: res.errors.storageRoot }
    return { ok: true }
  } catch {
    return { ok: false, error: tr('無法儲存設定，請再試一次。') }
  }
}
