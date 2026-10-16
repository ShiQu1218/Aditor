import { describe, expect, test } from 'vitest'
import path from 'path'
import { resolveE2EConfig } from './e2e'

describe('resolveE2EConfig（正式行為不受環境變數影響）', () => {
  test('沒有 APEXHL_E2E=1 時一律回傳 null，即使設了其他變數', () => {
    expect(resolveE2EConfig({}, '/t', false)).toBeNull()
    expect(resolveE2EConfig({ APEXHL_ENGINE: 'fake', APEXHL_APPDATA: '/x', APEXHL_E2E_FAKE_FFMPEG: '1' }, '/t', false)).toBeNull()
    expect(resolveE2EConfig({ APEXHL_E2E: '0', APEXHL_ENGINE: 'fake' }, '/t', false)).toBeNull()
  })

  test('E2E 開啟：不指定其他變數＝全部沿用正式設定', () => {
    expect(resolveE2EConfig({ APEXHL_E2E: '1' }, '/t', false)).toEqual({ appData: null, fakeEngine: null, exportFfmpeg: null })
  })

  test('假引擎、暫存 appData、假 ffmpeg 解析', () => {
    const c = resolveE2EConfig(
      { APEXHL_E2E: '1', APEXHL_ENGINE: 'fake', APEXHL_APPDATA: '/tmp/a', APEXHL_E2E_FAKE_FFMPEG: '1', APEXHL_E2E_NODE: '/bin/node' },
      '/repo/app/test',
      false
    )!
    expect(c.appData).toBe(path.resolve('/tmp/a'))
    expect(c.fakeEngine).toEqual({
      command: '/bin/node',
      args: [path.join('/repo/app/test', 'fake-engine.mjs')],
      env: { FAKE_ENGINE_MODE: 'e2e' }
    })
    expect(c.exportFfmpeg).toEqual({ bin: '/bin/node', prefixArgs: [path.join('/repo/app/test', 'fake-ffmpeg.mjs')] })
  })

  test('I15：打包版（isPackaged=true）一律回傳 null，即使環境變數都設了', () => {
    const env = { APEXHL_E2E: '1', APEXHL_ENGINE: 'fake', APEXHL_APPDATA: '/x', APEXHL_E2E_FAKE_FFMPEG: '1', APEXHL_E2E_NODE: 'evil.exe' }
    expect(resolveE2EConfig(env, '/t', true)).toBeNull()
    expect(resolveE2EConfig(env, '/t', false)).not.toBeNull()
  })

  test('APEXHL_ENGINE 不是 fake 時不啟用假引擎', () => {
    expect(resolveE2EConfig({ APEXHL_E2E: '1', APEXHL_ENGINE: 'real' }, '/t', false)!.fakeEngine).toBeNull()
  })
})
