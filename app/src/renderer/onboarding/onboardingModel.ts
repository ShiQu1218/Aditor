// 首次啟動引導的純邏輯：顯示條件、草稿預設值、送出的設定內容與送出流程（不含畫面，可在 node 測試）。
import { DEFAULT_RECORDING_SETTINGS, type RecordingSettings } from '../../shared/recording'
import type { Settings, SettingsSetResult } from '../../shared/settings'
import { tr } from '../../shared/locale'

/** 引導的步驟順序：歡迎＋語言 → 儲存位置 → 錄影設定 → 完成。 */
export const ONBOARDING_STEPS = ['welcome', 'storage', 'recording', 'done'] as const
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]

/** 使用者在引導中選擇的值（完成時才一次寫入設定）。 */
export interface OnboardingDraft {
  /** 儲存根資料夾；空字串＝尚未取得建議值 */
  storageRoot: string
  mode: RecordingSettings['mode']
  height: RecordingSettings['height']
  fps: RecordingSettings['fps']
  bitrateKbps: number
}

/** 送給 `settings:set` 的內容。 */
export interface OnboardingPatch {
  storageRoot?: string
  onboardingDone: true
  recording?: Pick<RecordingSettings, 'mode' | 'height' | 'fps' | 'bitrateKbps'>
}

/** 引導用到的 window.api 子集。 */
export interface OnboardingApi {
  settings: {
    set(partial: unknown): Promise<unknown>
    suggestStorageRoot?(): Promise<string>
  }
  export?: { selectOutDir?(): Promise<string | null> }
}

export type OnboardingResult = { ok: true } | { ok: false; error: string }

/** 設定載入完成且尚未做過引導時才顯示。 */
export function shouldShowOnboarding(settings: Settings | null): boolean {
  return settings !== null && settings.onboardingDone === false
}

/** 草稿預設值：錄影欄位取 DEFAULT_RECORDING_SETTINGS。 */
export function defaultDraft(storageRoot: string): OnboardingDraft {
  const { mode, height, fps, bitrateKbps } = DEFAULT_RECORDING_SETTINGS
  return { storageRoot, mode, height, fps, bitrateKbps }
}

/** 「開始使用」：一次寫入儲存位置、完成旗標與四個錄影欄位。 */
export function buildFinishPatch(draft: OnboardingDraft): OnboardingPatch {
  const { mode, height, fps, bitrateKbps } = draft
  return {
    ...(draft.storageRoot ? { storageRoot: draft.storageRoot } : {}),
    onboardingDone: true,
    recording: { mode, height, fps, bitrateKbps }
  }
}

/** 「稍後再說」：只標記完成，其餘沿用預設。 */
export const SKIP_PATCH: OnboardingPatch = { onboardingDone: true }

function isSetResult(v: unknown): v is SettingsSetResult {
  return typeof v === 'object' && v !== null && 'settings' in v && 'persisted' in v
}

/** 送出設定；main 回報儲存位置無法使用時回傳錯誤（引導不可關閉）。 */
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
