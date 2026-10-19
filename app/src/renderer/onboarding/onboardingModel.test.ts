import { describe, expect, test, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { DEFAULT_RECORDING_SETTINGS } from '../../shared/recording'
import {
  SKIP_PATCH,
  buildFinishPatch,
  defaultDraft,
  shouldShowOnboarding,
  submitOnboarding,
  type OnboardingApi
} from './onboardingModel'

describe('shouldShowOnboarding', () => {
  test('設定尚未載入時不顯示', () => {
    expect(shouldShowOnboarding(null)).toBe(false)
  })
  test('onboardingDone 為 false 才顯示', () => {
    expect(shouldShowOnboarding({ ...DEFAULT_SETTINGS, onboardingDone: false })).toBe(true)
    expect(shouldShowOnboarding({ ...DEFAULT_SETTINGS, onboardingDone: true })).toBe(false)
  })
})

describe('defaultDraft', () => {
  test('錄影預設值取 DEFAULT_RECORDING_SETTINGS（1080p／60 fps／10000 kbps）', () => {
    expect(defaultDraft('D:/Videos/Apex Highlighter')).toEqual({
      storageRoot: 'D:/Videos/Apex Highlighter',
      mode: DEFAULT_RECORDING_SETTINGS.mode,
      height: 1080,
      fps: 60,
      bitrateKbps: 10_000
    })
  })
})

describe('送出的設定內容', () => {
  test('完成：一次寫入 storageRoot、onboardingDone 與四個錄影欄位', () => {
    const draft = { storageRoot: 'E:/Apex', mode: 'match' as const, height: 1440 as const, fps: 120 as const, bitrateKbps: 30_000 }
    expect(buildFinishPatch(draft)).toEqual({
      storageRoot: 'E:/Apex',
      onboardingDone: true,
      recording: { mode: 'match', height: 1440, fps: 120, bitrateKbps: 30_000 }
    })
  })
  test('完成：尚未取得建議位置（空字串）時不送 storageRoot', () => {
    const patch = buildFinishPatch(defaultDraft(''))
    expect(patch).not.toHaveProperty('storageRoot')
    expect(patch.onboardingDone).toBe(true)
  })
  test('稍後再說：只寫 onboardingDone', () => {
    expect(SKIP_PATCH).toEqual({ onboardingDone: true })
  })
})

describe('submitOnboarding', () => {
  const apiWith = (set: (p: unknown) => Promise<unknown>): OnboardingApi => ({ settings: { set } })

  test('成功時回傳 ok 並把 patch 原樣送出', async () => {
    const set = vi.fn(async () => ({ settings: DEFAULT_SETTINGS, persisted: true }))
    const patch = buildFinishPatch(defaultDraft('D:/x'))
    expect(await submitOnboarding(apiWith(set), patch)).toEqual({ ok: true })
    expect(set).toHaveBeenCalledWith(patch)
  })
  test('storageRoot 驗證失敗：回傳 main 的錯誤訊息，不視為完成', async () => {
    const set = async () => ({ settings: DEFAULT_SETTINGS, persisted: true, errors: { storageRoot: '無法建立或寫入儲存位置' } })
    const res = await submitOnboarding(apiWith(set), buildFinishPatch(defaultDraft('Z:/nope')))
    expect(res).toEqual({ ok: false, error: '無法建立或寫入儲存位置' })
  })
  test('IPC 丟錯或回傳格式不對：回傳一般錯誤訊息', async () => {
    const thrown = await submitOnboarding(apiWith(async () => { throw new Error('boom') }), SKIP_PATCH)
    expect(thrown.ok).toBe(false)
    const odd = await submitOnboarding(apiWith(async () => 42), SKIP_PATCH)
    expect(odd.ok).toBe(false)
  })
})
