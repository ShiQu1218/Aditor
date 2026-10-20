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
  test('Does not show before settings load', () => {
    expect(shouldShowOnboarding(null)).toBe(false)
  })
  test('Shows only when onboardingDone is false', () => {
    expect(shouldShowOnboarding({ ...DEFAULT_SETTINGS, onboardingDone: false })).toBe(true)
    expect(shouldShowOnboarding({ ...DEFAULT_SETTINGS, onboardingDone: true })).toBe(false)
  })
})

describe('defaultDraft', () => {
  test('Recording defaults come from DEFAULT_RECORDING_SETTINGS (1080p/60 fps/10000 kbps)', () => {
    expect(defaultDraft('D:/Videos/Aditor')).toEqual({
      storageRoot: 'D:/Videos/Aditor',
      mode: DEFAULT_RECORDING_SETTINGS.mode,
      height: 1080,
      fps: 60,
      bitrateKbps: 10_000
    })
  })
})

describe('Submitted settings', () => {
  test('Completion writes storageRoot, onboardingDone, and four recording fields in one update', () => {
    const draft = { storageRoot: 'E:/Apex', mode: 'match' as const, height: 1440 as const, fps: 120 as const, bitrateKbps: 30_000 }
    expect(buildFinishPatch(draft)).toEqual({
      storageRoot: 'E:/Apex',
      onboardingDone: true,
      recording: { mode: 'match', height: 1440, fps: 120, bitrateKbps: 30_000 }
    })
  })
  test('Completion omits storageRoot when the suggested location is still empty', () => {
    const patch = buildFinishPatch(defaultDraft(''))
    expect(patch).not.toHaveProperty('storageRoot')
    expect(patch.onboardingDone).toBe(true)
  })
  test('Not now writes only onboardingDone', () => {
    expect(SKIP_PATCH).toEqual({ onboardingDone: true })
  })
})

describe('submitOnboarding', () => {
  const apiWith = (set: (p: unknown) => Promise<unknown>): OnboardingApi => ({ settings: { set } })

  test('Returns ok on success and passes the patch through unchanged', async () => {
    const set = vi.fn(async () => ({ settings: DEFAULT_SETTINGS, persisted: true }))
    const patch = buildFinishPatch(defaultDraft('D:/x'))
    expect(await submitOnboarding(apiWith(set), patch)).toEqual({ ok: true })
    expect(set).toHaveBeenCalledWith(patch)
  })
  test('storageRoot validation failure returns the main-process error and does not mark onboarding complete', async () => {
    const set = async () => ({ settings: DEFAULT_SETTINGS, persisted: true, errors: { storageRoot: '無法建立或寫入儲存位置' } })
    const res = await submitOnboarding(apiWith(set), buildFinishPatch(defaultDraft('Z:/nope')))
    expect(res).toEqual({ ok: false, error: '無法建立或寫入儲存位置' })
  })
  test('IPC rejection or malformed response returns a generic error message', async () => {
    const thrown = await submitOnboarding(apiWith(async () => { throw new Error('boom') }), SKIP_PATCH)
    expect(thrown.ok).toBe(false)
    const odd = await submitOnboarding(apiWith(async () => 42), SKIP_PATCH)
    expect(odd.ok).toBe(false)
  })
})
