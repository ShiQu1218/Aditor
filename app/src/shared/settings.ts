import { AutoClipParams } from './types'

/** 設定檔格式版本；格式變更時遞增並在 `migrateSettings` 處理舊版。 */
export const SETTINGS_VERSION = 1

/**
 * 應用程式設定（`%APPDATA%\ApexHighlighter\settings.json`）。
 * 欄位語意見 spec §3.3；數值範圍由 main 的 `set`／`migrateSettings` 驗證（spec §3.2）。
 */
export interface Settings {
  version: 1
  /** 監看資料夾清單（新影片自動匯入） */
  watchFolders: string[]
  /** 監看資料夾的新影片自動排入分析佇列 */
  autoAnalyze: boolean
  /** 解碼方式：'auto'＝硬體優先、'software'＝純軟體 */
  decode: 'auto' | 'software'
  /** 快取位置：'appdata'（%APPDATA%）或影片旁 */
  cacheLocation: 'appdata' | 'besideVideo'
  /** 低效能模式：關閉動畫、降低熱度條解析度 */
  lowPerfMode: boolean
  /** 非可播放影片建議產生代理檔 */
  proxySuggest: boolean
  /** 快速剪輯：事件前秒數（0..30） */
  before: number
  /** 快速剪輯：事件後秒數（0..30） */
  after: number
  /** AI 自動剪輯預設參數（n 1..10、gap 5..60、before/after 0..30、max_len 15..300） */
  autoclip: AutoClipParams
  /** 開啟影片時自動放置 AI 建議 */
  autoSuggestOnOpen: boolean
  /** 專案自動儲存（關閉後恢復「未儲存變更」提示行為） */
  projectAutosave: boolean
  /** 匯出預設資料夾（null＝每次詢問） */
  defaultOutDir: string | null
  /** 專案軌預設收合：'auto' 依視窗高度（≤800px 收合），或固定布林 */
  projectTrackCollapsed: 'auto' | boolean
  /** 上次開啟的專案 id（啟動時還原） */
  lastProjectId: string | null
}

/** 數值範圍（含端點） */
export interface SettingsRange {
  readonly min: number
  readonly max: number
}

/** 數值欄位允許範圍（含端點；與 spec §3.2／§3.3 一致）。main 驗證與設定畫面夾限共用的唯一來源。 */
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

/** `settings:set` 的回傳：實際生效的設定、是否已寫入磁碟，以及路徑驗證失敗的欄位訊息。 */
export interface SettingsSetResult {
  settings: Settings
  /** false＝記憶體已更新但寫檔失敗（重啟後不會保留） */
  persisted: boolean
  /** main 對路徑類欄位的驗證錯誤（該欄位未被套用） */
  errors?: Partial<Record<'defaultOutDir', string>>
}

/** 預設設定；首次使用者（無設定檔）即採用此值，行為與舊版相同。 */
export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  watchFolders: [],
  autoAnalyze: true,
  decode: 'auto',
  cacheLocation: 'appdata',
  lowPerfMode: false,
  proxySuggest: true,
  before: 8,
  after: 4,
  autoclip: { n: 3, gap: 20, before: 8, after: 4, max_len: 90 },
  autoSuggestOnOpen: true,
  projectAutosave: true,
  defaultOutDir: null,
  projectTrackCollapsed: 'auto',
  lastProjectId: null
}
