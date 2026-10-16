// 設定畫面的列定義（資料表）：分類、卡片、標題／說明／搜尋關鍵字與控制項種類。
// 文字一律來自 i18n/zh-TW.ts；控制項如何讀寫 Settings／IPC 由 SettingRow 與 settingsController 實作。
import { settingsI18n } from '../i18n/zh-TW'

const t = settingsI18n

export type CategoryId = 'a' | 'b' | 'c'

export interface CategoryDef {
  id: CategoryId
  label: string
  /** 分類欄圖示（components/icons 的元件名稱） */
  icon: 'Film' | 'Scissors' | 'Download'
}

export const CATEGORIES: readonly CategoryDef[] = [
  { id: 'a', label: t.cat.a, icon: 'Film' },
  { id: 'b', label: t.cat.b, icon: 'Scissors' },
  { id: 'c', label: t.cat.c, icon: 'Download' }
]

export type BoolField = 'autoAnalyze' | 'lowPerfMode' | 'proxySuggest' | 'autoSuggestOnOpen' | 'projectAutosave'

export type ControlSpec =
  | { kind: 'switch'; field: BoolField }
  | { kind: 'select'; field: 'decode' | 'cacheLocation' | 'gameLang'; options: ReadonlyArray<{ value: string; label: string }> }
  | { kind: 'numberPair'; fields: readonly ['before', 'after'] }
  | { kind: 'autoclip' }
  | { kind: 'watchFolders' }
  | { kind: 'proxyUsage' }
  | { kind: 'outDir' }
  | { kind: 'encoders' }
  | { kind: 'openh264' }
  | { kind: 'about' }
  | { kind: 'none' }

export interface SettingRow {
  id: string
  category: CategoryId
  card: string
  title: string
  desc?: string
  keywords?: string[]
  /** 相對舊版新增的設定（顯示「新」標籤） */
  isNew?: boolean
  control: ControlSpec
  /** 後端尚未提供：該列的控制項停用，並以灰色文字顯示此說明 */
  disabledReason?: string
}

export const SETTING_ROWS: SettingRow[] = [
  // ── 影片與分析 ──
  {
    id: 'watchFolders',
    category: 'a',
    card: t.card.source,
    title: t.row.watchFolders.title,
    desc: t.row.watchFolders.desc,
    keywords: [...t.row.watchFolders.keywords],
    control: { kind: 'watchFolders' }
  },
  {
    id: 'autoAnalyze',
    category: 'a',
    card: t.card.source,
    title: t.row.autoAnalyze.title,
    desc: t.row.autoAnalyze.desc,
    keywords: [...t.row.autoAnalyze.keywords],
    control: { kind: 'switch', field: 'autoAnalyze' }
  },
  {
    id: 'gameLang',
    category: 'a',
    card: t.card.perf,
    title: t.row.gameLang.title,
    desc: t.row.gameLang.desc,
    keywords: [...t.row.gameLang.keywords],
    isNew: true,
    control: {
      kind: 'select',
      field: 'gameLang',
      options: [
        { value: 'auto', label: t.row.gameLang.auto },
        { value: 'zh-TW', label: t.row.gameLang.zhTW },
        { value: 'en', label: t.row.gameLang.en },
        { value: 'ja', label: t.row.gameLang.ja }
      ]
    }
  },
  {
    id: 'decode',
    category: 'a',
    card: t.card.perf,
    title: t.row.decode.title,
    desc: t.row.decode.desc,
    keywords: [...t.row.decode.keywords],
    control: {
      kind: 'select',
      field: 'decode',
      options: [
        { value: 'auto', label: t.row.decode.auto },
        { value: 'software', label: t.row.decode.software }
      ]
    }
  },
  {
    id: 'cacheLocation',
    category: 'a',
    card: t.card.perf,
    title: t.row.cacheLocation.title,
    desc: t.row.cacheLocation.desc,
    keywords: [...t.row.cacheLocation.keywords],
    control: {
      kind: 'select',
      field: 'cacheLocation',
      options: [
        { value: 'appdata', label: t.row.cacheLocation.appdata },
        { value: 'besideVideo', label: t.row.cacheLocation.besideVideo }
      ]
    }
  },
  {
    id: 'lowPerfMode',
    category: 'a',
    card: t.card.perf,
    title: t.row.lowPerfMode.title,
    desc: t.row.lowPerfMode.desc,
    keywords: [...t.row.lowPerfMode.keywords],
    isNew: true,
    control: { kind: 'switch', field: 'lowPerfMode' }
  },
  // ── 預覽與剪輯 ──
  {
    id: 'proxySuggest',
    category: 'b',
    card: t.card.proxy,
    title: t.row.proxySuggest.title,
    desc: t.row.proxySuggest.desc,
    keywords: [...t.row.proxySuggest.keywords],
    control: { kind: 'switch', field: 'proxySuggest' }
  },
  {
    id: 'proxyUsage',
    category: 'b',
    card: t.card.proxy,
    title: t.row.proxyUsage.title,
    desc: t.row.proxyUsage.desc,
    keywords: [...t.row.proxyUsage.keywords],
    control: { kind: 'proxyUsage' }
  },
  {
    id: 'beforeAfter',
    category: 'b',
    card: t.card.clip,
    title: t.row.beforeAfter.title,
    desc: t.row.beforeAfter.desc,
    keywords: [...t.row.beforeAfter.keywords],
    control: { kind: 'numberPair', fields: ['before', 'after'] }
  },
  {
    id: 'autoclip',
    category: 'b',
    card: t.card.clip,
    title: t.row.autoclip.title,
    desc: t.row.autoclip.desc,
    keywords: [...t.row.autoclip.keywords],
    control: { kind: 'autoclip' }
  },
  {
    id: 'autoSuggestOnOpen',
    category: 'b',
    card: t.card.clip,
    title: t.row.autoSuggestOnOpen.title,
    desc: t.row.autoSuggestOnOpen.desc,
    keywords: [...t.row.autoSuggestOnOpen.keywords],
    isNew: true,
    control: { kind: 'switch', field: 'autoSuggestOnOpen' }
  },
  {
    id: 'projectAutosave',
    category: 'b',
    card: t.card.clip,
    title: t.row.projectAutosave.title,
    desc: t.row.projectAutosave.desc,
    keywords: [...t.row.projectAutosave.keywords],
    isNew: true,
    control: { kind: 'switch', field: 'projectAutosave' }
  },
  // ── 匯出與關於 ──
  {
    id: 'defaultOutDir',
    category: 'c',
    card: t.card.export,
    title: t.row.defaultOutDir.title,
    desc: t.row.defaultOutDir.desc,
    keywords: [...t.row.defaultOutDir.keywords],
    control: { kind: 'outDir' }
  },
  {
    id: 'encoders',
    category: 'c',
    card: t.card.export,
    title: t.row.encoders.title,
    desc: t.row.encoders.desc,
    keywords: [...t.row.encoders.keywords],
    control: { kind: 'encoders' }
  },
  {
    id: 'openh264',
    category: 'c',
    card: t.card.export,
    title: t.row.openh264.title,
    desc: t.row.openh264.desc,
    keywords: [...t.row.openh264.keywords],
    isNew: true,
    control: { kind: 'openh264' },
    // 下載需在匯出面板走授權同意流程；設定頁只顯示狀態
    disabledReason: t.row.openh264.downloadHint
  },
  {
    id: 'about',
    category: 'c',
    card: t.card.about,
    title: t.row.about.title,
    desc: t.row.about.desc,
    keywords: [...t.row.about.keywords],
    control: { kind: 'about' },
    disabledReason: t.row.about.licensesHint
  },
  {
    id: 'trademark',
    category: 'c',
    card: t.card.about,
    title: t.row.trademark.title,
    desc: t.row.trademark.desc,
    keywords: [...t.row.trademark.keywords],
    isNew: true,
    control: { kind: 'none' }
  }
]
