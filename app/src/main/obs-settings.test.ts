import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { SettingsStore, migrateSettings } from './settings'
import { obsPassword, registerSettingsHandlers } from './settings-ipc'

const roots: string[] = []
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })
describe('OBS settings and password IPC', () => {
  it('normalizes backend, host, port, and fallback settings', () => {
    expect(migrateSettings({ recording: { backend: 'obs', obsHost: ' localhost ', obsPort: 5555, obsFallbackBuiltin: false } }).recording)
      .toMatchObject({ backend: 'obs', obsHost: 'localhost', obsPort: 5555, obsFallbackBuiltin: false })
    expect(migrateSettings({ recording: { backend: 'bad', obsHost: 'ws://evil/path', obsPort: 1.5 } }).recording)
      .toMatchObject({ backend: 'builtin', obsHost: '127.0.0.1', obsPort: 4455, obsFallbackBuiltin: true })
  })
  it('persists the password only as encrypted base64; get/set/broadcast exclude ciphertext and reload preserves it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-obs-settings-')); roots.push(root)
    const file = path.join(root, 'settings.json')
    const store = new SettingsStore(file)
    const handlers = new Map<string, (...args: any[]) => any>()
    const sent: any[] = []
    const storage = { isEncryptionAvailable: () => true, encryptString: vi.fn(() => Buffer.from('encrypted')),
      decryptString: () => '不可洩漏' }
    registerSettingsHandlers({ handle: (name, fn) => { handlers.set(name, fn) } }, store,
      () => [{ isDestroyed: () => false, webContents: { send: (_name, value) => sent.push(value) } }], storage)
    const result = handlers.get('settings:set')!({}, { recording: { obsPassword: '不可洩漏', obsPasswordEnc: 'forged' } })
    expect(storage.encryptString).toHaveBeenCalledWith('不可洩漏')
    expect(result.settings.recording.hasPassword).toBe(true)
    for (const value of [result, handlers.get('settings:get')!({}), ...sent]) {
      expect(JSON.stringify(value)).not.toContain('obsPasswordEnc')
      expect(JSON.stringify(value)).not.toContain('不可洩漏')
    }
    expect(fs.readFileSync(file, 'utf8')).not.toContain('不可洩漏')
    expect(new SettingsStore(file).get().recording.obsPasswordEnc).toBe(Buffer.from('encrypted').toString('base64'))
    expect(obsPassword(new SettingsStore(file).get().recording, storage)).toBe('不可洩漏')
    storage.isEncryptionAvailable = () => false
    expect(() => obsPassword(store.get().recording, storage)).toThrow('加密')
    const refused = handlers.get('settings:set')!({}, { recording: { obsPassword: '新密碼' } })
    expect(refused.errors.obsPassword).toContain('加密')
    expect(store.get().recording.obsPasswordEnc).toBe(Buffer.from('encrypted').toString('base64'))
    const cleared = handlers.get('settings:set')!({}, { recording: { obsPassword: '' } })
    expect(cleared.settings.recording.hasPassword).toBe(false)
    expect(new SettingsStore(file).get().recording.obsPasswordEnc).toBeNull()
  })
})
