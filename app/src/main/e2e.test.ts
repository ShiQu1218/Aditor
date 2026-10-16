import { describe, expect, test } from 'vitest'
import path from 'path'
import { resolveE2EConfig } from './e2e'

describe('resolveE2EConfig（正式行為不受環境變數影響）', () => {
  test('沒有 APEXHL_E2E=1 時一律回傳 null，即使設了其他變數', () => {
    expect(resolveE2EConfig({}, '/t')).toBeNull()
    expect(resolveE2EConfig({ APEXHL_ENGINE: 'fake', APEXHL_APPDATA: '/x', APEXHL_E2E_FAKE_FFMPEG: '1' }, '/t')).toBeNull()
    expect(resolveE2EConfig({ APEXHL_E2E: '0', APEXHL_ENGINE: 'fake' }, '/t')).toBeNull()
  })

  test('E2E 開啟：不指定其他變數＝全部沿用正式設定', () => {
    expect(resolveE2EConfig({ APEXHL_E2E: '1' }, '/t')).toEqual({ appData: null, fakeEngine: null, exportFfmpeg: null })
  })

  test('假引擎、暫存 appData、假 ffmpeg 解析', () => {
    const c = resolveE2EConfig(
      { APEXHL_E2E: '1', APEXHL_ENGINE: 'fake', APEXHL_APPDATA: '/tmp/a', APEXHL_E2E_FAKE_FFMPEG: '1', APEXHL_E2E_NODE: '/bin/node' },
      '/repo/app/test'
    )!
    expect(c.appData).toBe(path.resolve('/tmp/a'))
    expect(c.fakeEngine).toEqual({
      command: '/bin/node',
      args: [path.join('/repo/app/test', 'fake-engine.mjs')],
      env: { FAKE_ENGINE_MODE: 'e2e' }
    })
    expect(c.exportFfmpeg).toEqual({ bin: '/bin/node', prefixArgs: [path.join('/repo/app/test', 'fake-ffmpeg.mjs')] })
  })

  test('APEXHL_ENGINE 不是 fake 時不啟用假引擎', () => {
    expect(resolveE2EConfig({ APEXHL_E2E: '1', APEXHL_ENGINE: 'real' }, '/t')!.fakeEngine).toBeNull()
  })
})
