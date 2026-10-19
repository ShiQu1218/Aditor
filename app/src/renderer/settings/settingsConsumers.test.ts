// 鎖定「沒有空轉的設定列」：每個設定欄位與每一列都必須有真實的消費端（檔案＋識別字），
// 新增設定欄位或設定列卻沒登記消費端時此測試會失敗。
import { describe, expect, test } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { SETTING_ROWS } from './rows'
import { recordingI18n } from '../i18n'

const src = (rel: string): string => resolve(__dirname, '../../', rel)

/** 設定欄位 → 消費端（相對 src/）與在該檔必須出現的識別字 */
const FIELD_CONSUMERS: Record<string, Array<[string, RegExp]>> = {
  watchFolders: [['main/watch.ts', /watchFolders/]],
  language: [['main/index.ts', /resolveLocale\(/], ['renderer/i18n/index.ts', /bootLocale/]],
  autoAnalyze: [['main/watch.ts', /\.autoAnalyze/]],
  decode: [['main/settings-derived.ts', /\.decode/], ['main/queue.ts', /analyzeSettingArgs/], ['main/index.ts', /buildAnalyzeArgs/]],
  cacheLocation: [
    ['main/settings-derived.ts', /\.cacheLocation/],
    ['main/ipc-handlers.ts', /cacheLocation/],
    ['main/queue.ts', /extra\.beside/]
  ],
  lowPerfMode: [['renderer/perf/lowPerf.ts', /lowPerfMode/], ['renderer/App.tsx', /watchLowPerfSetting/]],
  lowPerfAsked: [['renderer/perf/lowPerfPrompt.ts', /lowPerfAsked/]],
  proxySuggest: [['renderer/studio/notices.ts', /proxySuggest/], ['renderer/library/VideoCard.tsx', /proxySuggest/]],
  before: [['renderer/studio/StudioScreen.tsx', /cfg\.before/]],
  // 刀片改用兩點起訖；後秒數只保留舊設定的讀寫相容性。
  after: [['main/settings.ts', /after: pickNumber\(s\.after/]],
  autoclip: [['renderer/studio/highlights.ts', /settings\.autoclip/], ['renderer/studio/StudioScreen.tsx', /cfg\.autoclip/], ['main/ipc-handlers.ts', /\.autoclip/]],
  autoSuggestOnOpen: [['renderer/studio/highlights.ts', /settings\.autoSuggestOnOpen/]],
  projectAutosave: [['renderer/editor/ProjectProvider.tsx', /projectAutosave/]],
  defaultOutDir: [['renderer/studio/StudioScreen.tsx', /defaultOutDir/]],
  projectTrackCollapsed: [['renderer/studio/StudioScreen.tsx', /cfg\.projectTrackCollapsed/]],
  sameDayVideosCollapsed: [['renderer/studio/SameDayVideos.tsx', /settings\.sameDayVideosCollapsed/]],
  lastProjectId: [['renderer/editor/projectIo.ts', /lastProjectId/], ['main/project-ipc.ts', /lastProjectId/]],
  // 錄影服務與系統匣由 A1／A3 接線；本任務驗證實際的設定讀寫與驗證入口。
  recording: [['main/settings.ts', /recording: pickRecording/], ['renderer/settings/RecordingControl.tsx', /controller\.setRecording/]]
}

/** 設定畫面的列 → 它控制的欄位，或（非設定欄位的列）真實後端／IPC 消費端 */
const ROW_TARGETS: Record<string, { fields?: string[]; consumers?: Array<[string, RegExp]> }> = {
  language: { fields: ['language'] },
  watchFolders: { fields: ['watchFolders'] },
  autoAnalyze: { fields: ['autoAnalyze'] },
  decode: { fields: ['decode'] },
  cacheLocation: { fields: ['cacheLocation'] },
  lowPerfMode: { fields: ['lowPerfMode'] },
  proxySuggest: { fields: ['proxySuggest'] },
  proxyUsage: { consumers: [['main/ipc-handlers.ts', /proxy:usage/], ['renderer/settings/settingsController.ts', /proxy\.usage/]] },
  beforeAfter: { fields: ['before', 'after'] },
  autoclip: { fields: ['autoclip'] },
  autoSuggestOnOpen: { fields: ['autoSuggestOnOpen'] },
  projectAutosave: { fields: ['projectAutosave'] },
  defaultOutDir: { fields: ['defaultOutDir'] },
  encoders: { consumers: [['main/ipc-handlers.ts', /detectEncoders/]] },
  openh264: { consumers: [['main/ipc-handlers.ts', /hasOpenH264/]] },
  about: { consumers: [['renderer/settings/SettingControls.tsx', /__APP_VERSION__/]] },
  trademark: { consumers: [['renderer/i18n/zh-TW.ts', /trademark/]] },
  ...Object.fromEntries(Object.keys(recordingI18n.rows).map((field) => [
    `recording-${field}`, { fields: ['recording'] }
  ]))
}

const check = (list: Array<[string, RegExp]>): void => {
  expect(list.length).toBeGreaterThan(0)
  for (const [file, re] of list) {
    expect(existsSync(src(file)), file).toBe(true)
    expect(readFileSync(src(file), 'utf-8'), `${file} should reference ${re}`).toMatch(re)
  }
}

describe('設定欄位都有消費端', () => {
  const keys = Object.keys(DEFAULT_SETTINGS).filter((k) => k !== 'version')
  test('FIELD_CONSUMERS 與 Settings 欄位一一對應', () => {
    expect(Object.keys(FIELD_CONSUMERS).sort()).toEqual([...keys].sort())
  })
  test.each(keys)('%s', (k) => check(FIELD_CONSUMERS[k]))
})

describe('設定畫面每一列都不是空轉', () => {
  test('每一列都已登記', () => {
    expect(SETTING_ROWS.map((r) => r.id).sort()).toEqual(Object.keys(ROW_TARGETS).sort())
  })
  test.each(SETTING_ROWS.map((r) => r.id))('%s', (id) => {
    const t = ROW_TARGETS[id]
    if (t.fields) for (const f of t.fields) check(FIELD_CONSUMERS[f])
    if (t.consumers) check(t.consumers)
  })
  test('說明文字不得宣稱「需新增 IPC」', () => {
    for (const r of SETTING_ROWS) expect(`${r.desc ?? ''}${r.disabledReason ?? ''}`).not.toMatch(/需新增\s*IPC/)
  })
})
