import { DEFAULT_SETTINGS } from '../../shared/settings'
import type { AutoClipParams } from '../../shared/types'

/** 工作室實際消費的設定子集（其餘設定由別處消費；對照表見 task-17 報告）。 */
export interface StudioSettings {
  /** 開啟影片時自動放置 AI 建議 */
  autoSuggestOnOpen: boolean
  /** AI 浮層與自動建議共用的預設參數 */
  autoclip: AutoClipParams
  projectTrackCollapsed: 'auto' | boolean
  /** 快速剪輯／合輯／事件 lead-in seek 的事件前秒數 */
  before: number
  /** 快速剪輯／合輯的事件後秒數 */
  after: number
  /** 無硬體解碼／不可播放時是否建議代理檔 */
  proxySuggest: boolean
}

export const STUDIO_SETTINGS_DEFAULTS: StudioSettings = {
  autoSuggestOnOpen: DEFAULT_SETTINGS.autoSuggestOnOpen,
  autoclip: DEFAULT_SETTINGS.autoclip,
  projectTrackCollapsed: DEFAULT_SETTINGS.projectTrackCollapsed,
  before: DEFAULT_SETTINGS.before,
  after: DEFAULT_SETTINGS.after,
  proxySuggest: DEFAULT_SETTINGS.proxySuggest
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback
}

/** 把 `settings:get`／`settings:changed` 的資料（不受信任的形狀）轉成工作室設定，缺漏欄位回退預設。 */
export function toStudioSettings(raw: unknown, base: StudioSettings = STUDIO_SETTINGS_DEFAULTS): StudioSettings {
  const s = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const pref = s.projectTrackCollapsed
  return {
    autoSuggestOnOpen: typeof s.autoSuggestOnOpen === 'boolean' ? s.autoSuggestOnOpen : base.autoSuggestOnOpen,
    autoclip: (s.autoclip as AutoClipParams | undefined) ?? base.autoclip,
    projectTrackCollapsed: pref === true || pref === false || pref === 'auto' ? pref : base.projectTrackCollapsed,
    before: num(s.before, base.before),
    after: num(s.after, base.after),
    proxySuggest: typeof s.proxySuggest === 'boolean' ? s.proxySuggest : base.proxySuggest
  }
}

/** 點事件／上下一個事件時的 seek 目標：事件前 `before` 秒（不小於 0）。 */
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
 * 讀取設定並訂閱 `settings:changed`（變更免重啟）。
 * 較新的 changed 事件不會被較晚回來的 get() 蓋掉；沒有 api → 立刻回預設；get 失敗 → 預設但不自動放置建議。
 * 回傳解除訂閱函式。
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
