import { describe, expect, test } from 'vitest'
import path from 'path'
import { resolveE2EConfig } from './e2e'

describe('resolveE2EConfig (environment variables do not affect production behavior)', () => {
  test('returns null without ADITOR_E2E=1, even when other variables are set', () => {
    expect(resolveE2EConfig({}, '/t', false)).toBeNull()
    expect(resolveE2EConfig({ ADITOR_ENGINE: 'fake', ADITOR_APPDATA: '/x', ADITOR_E2E_FAKE_FFMPEG: '1' }, '/t', false)).toBeNull()
    expect(resolveE2EConfig({ ADITOR_E2E: '0', ADITOR_ENGINE: 'fake' }, '/t', false)).toBeNull()
  })

  test('E2E enabled: unspecified variables retain all production settings', () => {
    expect(resolveE2EConfig({ ADITOR_E2E: '1' }, '/t', false)).toEqual({ appData: null, fakeEngine: null, exportFfmpeg: null })
  })

  test('resolves fake engine, temporary appData, and fake ffmpeg', () => {
    const c = resolveE2EConfig(
      { ADITOR_E2E: '1', ADITOR_ENGINE: 'fake', ADITOR_APPDATA: '/tmp/a', ADITOR_E2E_FAKE_FFMPEG: '1', ADITOR_E2E_NODE: '/bin/node' },
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

  test('I15: packaged build (isPackaged=true) always returns null, even when all environment variables are set', () => {
    const env = { ADITOR_E2E: '1', ADITOR_ENGINE: 'fake', ADITOR_APPDATA: '/x', ADITOR_E2E_FAKE_FFMPEG: '1', ADITOR_E2E_NODE: 'evil.exe' }
    expect(resolveE2EConfig(env, '/t', true)).toBeNull()
    expect(resolveE2EConfig(env, '/t', false)).not.toBeNull()
  })

  test('does not enable the fake engine unless ADITOR_ENGINE is fake', () => {
    expect(resolveE2EConfig({ ADITOR_E2E: '1', ADITOR_ENGINE: 'real' }, '/t', false)!.fakeEngine).toBeNull()
  })
})
