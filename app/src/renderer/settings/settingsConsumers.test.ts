// Ensure no settings rows are inert: every setting field and row must have a real consumer (file and identifier).
// This test fails when a setting field or row is added without registering its consumer.
import { describe, expect, test } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { SETTING_ROWS } from './rows'
import { recordingI18n } from '../i18n'

const src = (rel: string): string => resolve(__dirname, '../../', rel)

/** Setting field to consumer (relative to src/) and identifier that must appear in that file. */
const FIELD_CONSUMERS: Record<string, Array<[string, RegExp]>> = {
  watchFolders: [['main/watch.ts', /watchFolders/]],
  language: [['main/index.ts', /resolveLocale\(/], ['renderer/i18n/index.ts', /bootLocale/]],
  storageRoot: [['main/settings-ipc.ts', /storageRoot/]],
  onboardingDone: [['renderer/shell/AppShell.tsx', /onboardingDone/]],
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
  previewVolume: [['renderer/studio/StudioScreen.tsx', /cfg\.previewVolume/]],
  previewMuted: [['renderer/studio/StudioScreen.tsx', /cfg\.previewMuted/]],
  before: [['renderer/studio/StudioScreen.tsx', /cfg\.before/]],
  // The clipper now uses start/end points; post-roll seconds remain only for legacy read/write compatibility.
  after: [['main/settings.ts', /after: pickNumber\(s\.after/]],
  autoclip: [['renderer/studio/highlights.ts', /settings\.autoclip/], ['renderer/studio/StudioScreen.tsx', /cfg\.autoclip/], ['main/ipc-handlers.ts', /\.autoclip/]],
  autoSuggestOnOpen: [['renderer/studio/highlights.ts', /settings\.autoSuggestOnOpen/]],
  projectAutosave: [['renderer/editor/ProjectProvider.tsx', /projectAutosave/]],
  autoUpdate: [['main/index.ts', /\.autoUpdate/]],
  telemetryEnabled: [['main/index.ts', /\.telemetryEnabled/]],
  defaultOutDir: [['renderer/studio/StudioScreen.tsx', /defaultOutDir/]],
  projectTrackCollapsed: [['renderer/studio/StudioScreen.tsx', /cfg\.projectTrackCollapsed/]],
  sameDayVideosCollapsed: [['renderer/studio/SameDayVideos.tsx', /settings\.sameDayVideosCollapsed/]],
  lastProjectId: [['renderer/editor/projectIo.ts', /lastProjectId/], ['main/project-ipc.ts', /lastProjectId/]],
  // A1/A3 wire the recording service and system tray; this task verifies settings reads/writes and validation entry points.
  recording: [['main/settings.ts', /recording: pickRecording/], ['renderer/settings/RecordingControl.tsx', /controller\.setRecording/]]
}

/** Settings row to controlled field, or the real backend/IPC consumer for rows without a settings field. */
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
  storageRoot: { fields: ['storageRoot', 'defaultOutDir'] },
  encoders: { consumers: [['main/ipc-handlers.ts', /detectEncoders/]] },
  openh264: { consumers: [['main/ipc-handlers.ts', /hasOpenH264/]] },
  about: { consumers: [['renderer/settings/SettingControls.tsx', /__APP_VERSION__/]] },
  autoUpdate: { fields: ['autoUpdate'] },
  telemetryEnabled: { fields: ['telemetryEnabled'] },
  updateStatus: { consumers: [['main/update-ipc.ts', /UPDATE_CHANNELS\.check/], ['renderer/settings/settingsController.ts', /update\.check/]] },
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

describe('Every setting field has a consumer', () => {
  const keys = Object.keys(DEFAULT_SETTINGS).filter((k) => k !== 'version')
  test('FIELD_CONSUMERS maps one-to-one with Settings fields', () => {
    expect(Object.keys(FIELD_CONSUMERS).sort()).toEqual([...keys].sort())
  })
  test.each(keys)('%s', (k) => check(FIELD_CONSUMERS[k]))
})

describe('Every settings row has an effect', () => {
  test('Every row is registered', () => {
    expect(SETTING_ROWS.map((r) => r.id).sort()).toEqual(Object.keys(ROW_TARGETS).sort())
  })
  test.each(SETTING_ROWS.map((r) => r.id))('%s', (id) => {
    const t = ROW_TARGETS[id]
    if (t.fields) for (const f of t.fields) check(FIELD_CONSUMERS[f])
    if (t.consumers) check(t.consumers)
  })
  test('Descriptions must not say “IPC needs to be added”', () => {
    for (const r of SETTING_ROWS) expect(`${r.desc ?? ''}${r.disabledReason ?? ''}`).not.toMatch(/需新增\s*IPC/)
  })
})
