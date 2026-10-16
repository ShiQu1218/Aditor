import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { SettingsStore } from './settings'
import { registerSettingsHandlers, validateOutDir } from './settings-ipc'

type Fn = (...a: any[]) => any

function fakeIpc() {
  const handlers = new Map<string, Fn>()
  return { handlers, handle: (ch: string, fn: Fn) => void handlers.set(ch, fn) }
}

describe('settings IPC（settings:get / settings:set / settings:changed）', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apexhl-sipc-'))
    file = path.join(dir, 'settings.json')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function setup() {
    const store = new SettingsStore(file)
    const ipc = fakeIpc()
    const sent: Array<[string, unknown]> = []
    registerSettingsHandlers(ipc, store, () => [
      { isDestroyed: () => false, webContents: { send: (ch: string, data: unknown) => sent.push([ch, data]) } }
    ])
    return { store, ipc, sent }
  }

  test('settings:get returns the current settings', async () => {
    const { ipc } = setup()
    expect(await ipc.handlers.get('settings:get')!({})).toEqual(DEFAULT_SETTINGS)
  })

  test('settings:set returns { settings, persisted } to the renderer', async () => {
    const { ipc, store } = setup()
    const res = await ipc.handlers.get('settings:set')!({}, { before: 11 })
    expect(res.persisted).toBe(true)
    expect(res.settings.before).toBe(11)
    expect(store.get().before).toBe(11)
  })

  test('settings:set reports persisted:false (not a thrown error) when the write fails', async () => {
    const { ipc } = setup()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('EPERM')
    })
    const res = await ipc.handlers.get('settings:set')!({}, { before: 11 })
    expect(res.persisted).toBe(false)
    expect(res.settings.before).toBe(11)
  })

  test('settings:changed is broadcast with the new settings; a destroyed window is skipped', async () => {
    const store = new SettingsStore(file)
    const ipc = fakeIpc()
    const sent: unknown[] = []
    registerSettingsHandlers(ipc, store, () => [
      { isDestroyed: () => true, webContents: { send: () => sent.push('destroyed-window') } },
      { isDestroyed: () => false, webContents: { send: (ch: string, d: any) => sent.push([ch, d.before]) } }
    ])
    await ipc.handlers.get('settings:set')!({}, { before: 3 })
    expect(sent).toEqual([['settings:changed', 3]])
  })

  test('a window whose send throws does not abort set', async () => {
    const store = new SettingsStore(file)
    const ipc = fakeIpc()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    registerSettingsHandlers(ipc, store, () => [
      { isDestroyed: () => false, webContents: { send: () => { throw new Error('gone') } } }
    ])
    const res = await ipc.handlers.get('settings:set')!({}, { before: 3 })
    expect(res.persisted).toBe(true)
    expect(res.settings.before).toBe(3)
  })

  test('non-object payload is treated as an empty partial', async () => {
    const { ipc } = setup()
    const res = await ipc.handlers.get('settings:set')!({}, 'oops')
    expect(res.settings).toEqual(DEFAULT_SETTINGS)
  })

  test('defaultOutDir must be an absolute existing directory; error is reported and the field is not applied', async () => {
    const { ipc, store } = setup()
    const missing = path.join(dir, 'nope')
    const aFile = path.join(dir, 'f.txt')
    fs.writeFileSync(aFile, 'x')
    for (const bad of ['relative/dir', missing, aFile, '']) {
      const res = await ipc.handlers.get('settings:set')!({}, { defaultOutDir: bad, before: 5 })
      expect(res.errors?.defaultOutDir, String(bad)).toBeTruthy()
      expect(res.settings.defaultOutDir).toBeNull()
      expect(res.settings.before).toBe(5) // 其他合法欄位照常套用
    }
    expect(store.get().defaultOutDir).toBeNull()

    const ok = await ipc.handlers.get('settings:set')!({}, { defaultOutDir: dir })
    expect(ok.errors).toBeUndefined()
    expect(ok.settings.defaultOutDir).toBe(path.resolve(dir))

    // null = 每次詢問，永遠允許
    const cleared = await ipc.handlers.get('settings:set')!({}, { defaultOutDir: null })
    expect(cleared.errors).toBeUndefined()
    expect(cleared.settings.defaultOutDir).toBeNull()
  })

  test('watchFolders cannot be written through settings:set (WatchManager owns validation)', async () => {
    const { ipc, store } = setup()
    const res = await ipc.handlers.get('settings:set')!({}, { watchFolders: ['relative'] })
    expect(res.settings.watchFolders).toEqual([])
    expect(store.get().watchFolders).toEqual([])
  })

  test('validateOutDir rejects non-strings, relative paths, missing paths and files', () => {
    expect(validateOutDir(dir)).toBe(path.resolve(dir))
    expect(() => validateOutDir(42)).toThrow()
    expect(() => validateOutDir('rel')).toThrow()
    expect(() => validateOutDir(path.join(dir, 'missing'))).toThrow(/不存在/)
  })
})
