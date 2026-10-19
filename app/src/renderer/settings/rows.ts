// 設定畫面的列定義（資料表）：分類、卡片、標題／說明／搜尋關鍵字與控制項種類。
// 文字一律來自 i18n/zh-TW.ts；控制項如何讀寫 Settings／IPC 由 SettingRow 與 settingsController 實作。
// 陣列順序就是畫面順序；同分類、同卡片的連續列會併成一張卡片。
import { settingsI18n, recordingI18n, LOCALES, LOCALE_NAMES } from '../i18n'
import type { RecordingSettings } from '../../shared/recording'

const t = settingsI18n

// 分類依「使用者想做的事」排列：整個 App 的偏好 → 錄影 → 匯入與分析 → 剪輯 → 匯出 → 關於
export type CategoryId = 'general' | 'recording' | 'analysis' | 'editing' | 'export' | 'about'

export interface CategoryDef {
  id: CategoryId
  label: string
  /** 分類頂端的一句說明（不搜尋時顯示） */
  desc: string
  /** 分類欄圖示（components/icons 的元件名稱） */
  icon: 'SlidersHorizontal' | 'Video' | 'AnalysisQueue' | 'Scissors' | 'Download' | 'Info'
}

export const CATEGORIES: readonly CategoryDef[] = [
  { id: 'general', label: t.cat.general, desc: t.catDesc.general, icon: 'SlidersHorizontal' },
  { id: 'recording', label: t.cat.recording, desc: t.catDesc.recording, icon: 'Video' },
  { id: 'analysis', label: t.cat.analysis, desc: t.catDesc.analysis, icon: 'AnalysisQueue' },
  { id: 'editing', label: t.cat.editing, desc: t.catDesc.editing, icon: 'Scissors' },
  { id: 'export', label: t.cat.export, desc: t.catDesc.export, icon: 'Download' },
  { id: 'about', label: t.cat.about, desc: t.catDesc.about, icon: 'Info' }
]

export type BoolField = 'autoAnalyze' | 'lowPerfMode' | 'proxySuggest' | 'autoSuggestOnOpen' | 'projectAutosave'

export type ControlSpec =
  | { kind: 'recording'; field: keyof RecordingSettings }
  | { kind: 'switch'; field: BoolField }
  | { kind: 'select'; field: 'decode' | 'cacheLocation' | 'language'; options: ReadonlyArray<{ value: string; label: string }> }
  | { kind: 'numberPair'; fields: readonly ['before', 'after'] }
  | { kind: 'autoclip' }
  | { kind: 'watchFolders' }
  | { kind: 'proxyUsage' }
  | { kind: 'storageRoot' }
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
  /** 標題前的小圖示（幫助使用者在看不懂的語言下也找得到這一列） */
  icon?: 'Globe'
  control: ControlSpec
  /** 後端尚未提供：該列的控制項停用，並以灰色文字顯示此說明 */
  disabledReason?: string
  advanced?: boolean
}

type RecordingField = keyof typeof recordingI18n.rows

const VIDEO_FIELDS = new Set<string>(['height', 'bitrateKbps', 'fps', 'forceAspect', 'aspectMode', 'codec', 'encoder', 'preset', 'captureMethod'])
const AUDIO_FIELDS = new Set<string>(['systemAudioEnabled', 'renderDevice', 'systemGain', 'micEnabled', 'captureDevice', 'micGain', 'gameAudioOnly', 'micMono'])
const ADVANCED_FIELDS = new Set<string>(['forceAspect', 'aspectMode', 'codec', 'encoder', 'preset', 'captureMethod', 'gameAudioOnly', 'micMono'])

export function recordingRowVisible(row: SettingRow, backend: RecordingSettings['backend']): boolean {
  if (row.control.kind !== 'recording') return true
  const field = row.control.field
  if (field.startsWith('obs')) return backend === 'obs'
  return backend !== 'obs' || field === 'captureMethod' || (!VIDEO_FIELDS.has(field) && !AUDIO_FIELDS.has(field))
}

/** 錄影設定（RecordingSettings 欄位）的列；文字來自 recordingI18n.rows。 */
function recordingRow(field: RecordingField, category: CategoryId, card: string): SettingRow {
  const advanced = ADVANCED_FIELDS.has(field)
  const text = recordingI18n.rows[field]
  return {
    id: `recording-${field}`,
    category,
    card,
    advanced,
    title: text.title,
    desc: text.desc,
    keywords: ['錄影', field, ...(advanced ? [recordingI18n.advanced] : [])],
    control: { kind: 'recording', field: field as keyof RecordingSettings }
  }
}

const recordingRows = (card: string, fields: readonly RecordingField[]): SettingRow[] =>
  fields.map((field) => recordingRow(field, 'recording', card))

const rc = recordingI18n.cards

export const SETTING_ROWS: SettingRow[] = [
  // ── 一般：整個 App 的偏好 ──
  {
    id: 'language',
    category: 'general',
    card: t.card.ui,
    title: t.row.language.title,
    desc: t.row.language.desc,
    keywords: [...t.row.language.keywords],
    isNew: true,
    icon: 'Globe',
    control: {
      kind: 'select',
      field: 'language',
      options: [
        { value: 'auto', label: t.row.language.auto },
        ...LOCALES.map((code) => ({ value: code, label: LOCALE_NAMES[code] }))
      ]
    }
  },
  {
    id: 'lowPerfMode',
    category: 'general',
    card: t.card.ui,
    title: t.row.lowPerfMode.title,
    desc: t.row.lowPerfMode.desc,
    keywords: [...t.row.lowPerfMode.keywords],
    isNew: true,
    control: { kind: 'switch', field: 'lowPerfMode' }
  },
  recordingRow('launchAtLogin', 'general', t.card.startup),
  recordingRow('closeToTray', 'general', t.card.startup),
  {
    id: 'storageRoot',
    category: 'general',
    card: t.card.storage,
    title: t.row.storageRoot.title,
    desc: t.row.storageRoot.desc,
    keywords: [...t.row.storageRoot.keywords],
    isNew: true,
    control: { kind: 'storageRoot' }
  },
  // ── 錄影 ──
  ...recordingRows(rc.basics, ['autoRecord', 'mode', 'postAnalysis']),
  ...recordingRows(rc.recorder, ['backend', 'obsHost', 'obsPort', 'obsPassword', 'obsFallbackBuiltin']),
  ...recordingRows(rc.video, ['height', 'bitrateKbps', 'fps', 'forceAspect', 'aspectMode', 'codec', 'encoder', 'preset', 'captureMethod']),
  ...recordingRows(rc.audio, ['systemAudioEnabled', 'renderDevice', 'systemGain', 'micEnabled', 'captureDevice', 'micGain', 'gameAudioOnly', 'micMono']),
  ...recordingRows(rc.disk, ['diskWarnGb', 'diskStopGb', 'notifyMatch']),
  // ── 匯入與分析 ──
  {
    id: 'watchFolders',
    category: 'analysis',
    card: t.card.source,
    title: t.row.watchFolders.title,
    desc: t.row.watchFolders.desc,
    keywords: [...t.row.watchFolders.keywords],
    control: { kind: 'watchFolders' }
  },
  {
    id: 'autoAnalyze',
    category: 'analysis',
    card: t.card.source,
    title: t.row.autoAnalyze.title,
    desc: t.row.autoAnalyze.desc,
    keywords: [...t.row.autoAnalyze.keywords],
    control: { kind: 'switch', field: 'autoAnalyze' }
  },
  {
    id: 'decode',
    category: 'analysis',
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
    category: 'analysis',
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
  // ── 剪輯 ──
  {
    id: 'proxySuggest',
    category: 'editing',
    card: t.card.proxy,
    title: t.row.proxySuggest.title,
    desc: t.row.proxySuggest.desc,
    keywords: [...t.row.proxySuggest.keywords],
    control: { kind: 'switch', field: 'proxySuggest' }
  },
  {
    id: 'proxyUsage',
    category: 'editing',
    card: t.card.proxy,
    title: t.row.proxyUsage.title,
    desc: t.row.proxyUsage.desc,
    keywords: [...t.row.proxyUsage.keywords],
    control: { kind: 'proxyUsage' }
  },
  {
    id: 'beforeAfter',
    category: 'editing',
    card: t.card.clip,
    title: t.row.beforeAfter.title,
    desc: t.row.beforeAfter.desc,
    keywords: [...t.row.beforeAfter.keywords],
    control: { kind: 'numberPair', fields: ['before', 'after'] }
  },
  {
    id: 'autoclip',
    category: 'editing',
    card: t.card.clip,
    title: t.row.autoclip.title,
    desc: t.row.autoclip.desc,
    keywords: [...t.row.autoclip.keywords],
    control: { kind: 'autoclip' }
  },
  {
    id: 'autoSuggestOnOpen',
    category: 'editing',
    card: t.card.clip,
    title: t.row.autoSuggestOnOpen.title,
    desc: t.row.autoSuggestOnOpen.desc,
    keywords: [...t.row.autoSuggestOnOpen.keywords],
    isNew: true,
    control: { kind: 'switch', field: 'autoSuggestOnOpen' }
  },
  {
    id: 'projectAutosave',
    category: 'editing',
    card: t.card.clip,
    title: t.row.projectAutosave.title,
    desc: t.row.projectAutosave.desc,
    keywords: [...t.row.projectAutosave.keywords],
    isNew: true,
    control: { kind: 'switch', field: 'projectAutosave' }
  },
  // ── 匯出 ──
  {
    id: 'encoders',
    category: 'export',
    card: t.card.export,
    title: t.row.encoders.title,
    desc: t.row.encoders.desc,
    keywords: [...t.row.encoders.keywords],
    control: { kind: 'encoders' }
  },
  {
    id: 'openh264',
    category: 'export',
    card: t.card.export,
    title: t.row.openh264.title,
    desc: t.row.openh264.desc,
    keywords: [...t.row.openh264.keywords],
    isNew: true,
    control: { kind: 'openh264' }
  },
  // ── 關於 ──
  {
    id: 'about',
    category: 'about',
    card: t.card.about,
    title: t.row.about.title,
    desc: t.row.about.desc,
    keywords: [...t.row.about.keywords],
    control: { kind: 'about' }
  },
  {
    id: 'trademark',
    category: 'about',
    card: t.card.about,
    title: t.row.trademark.title,
    desc: t.row.trademark.desc,
    keywords: [...t.row.trademark.keywords],
    isNew: true,
    control: { kind: 'none' }
  }
]
