import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { SettingsStore } from './settings'
import { registerSettingsHandlers, STORAGE_SUGGEST_CHANNEL } from './settings-ipc'

type Fn = (...a: any[]) => any

describe('settings:set 的 storageRoot', () => {
  let dir: string
  let videos: string
  let store: SettingsStore
  const handlers = new Map<string, Fn>()
  const call = (ch: string, ...args: unknown[]): any => handlers.get(ch)!({}, ...args)

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-storage-'))
    videos = path.join(dir, 'Videos')
    handlers.clear()
    store = new SettingsStore(path.join(dir, 'settings.json'))
    registerSettingsHandlers({ handle: (ch: string, fn: Fn) => void handlers.set(ch, fn) }, store, () => [], undefined, () => videos)
  })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  test('字串根：建立資料夾並同步寫入 recording.outputDir、defaultOutDir、storageRoot', () => {
    const root = path.join(dir, 'Apex')
    const res = call('settings:set', { storageRoot: root })
    expect(res.errors).toBeUndefined()
    expect(res.settings.storageRoot).toBe(root)
    expect(res.settings.recording.outputDir).toBe(path.join(root, 'Recordings'))
    expect(res.settings.defaultOutDir).toBe(path.join(root, 'Exports'))
    expect(fs.statSync(path.join(root, 'Exports', 'Merged')).isDirectory()).toBe(true)
    expect(fs.statSync(path.join(root, 'Exports', 'Clips')).isDirectory()).toBe(true)
    expect(store.get().storageRoot).toBe(root)
  })

  test('同時送出的 recording 欄位照常套用，outputDir 以根為準', () => {
    const root = path.join(dir, 'Apex')
    const res = call('settings:set', { storageRoot: root, onboardingDone: true, recording: { fps: 30, outputDir: path.join(dir, 'x') } })
    expect(res.settings.recording.fps).toBe(30)
    expect(res.settings.recording.outputDir).toBe(path.join(root, 'Recordings'))
    expect(res.settings.onboardingDone).toBe(true)
  })

  test('錯誤路徑：回傳 errors.storageRoot，三個欄位都不套用，其他欄位照常', () => {
    for (const bad of ['relative/dir', 42, '']) {
      const res = call('settings:set', { storageRoot: bad, before: 5 })
      expect(res.errors?.storageRoot, String(bad)).toBeTruthy()
      expect(res.settings.storageRoot).toBeNull()
      expect(res.settings.defaultOutDir).toBeNull()
      expect(res.settings.recording.outputDir).toBeNull()
      expect(res.settings.before).toBe(5)
    }
  })

  test('無法建立（根路徑是檔案）：errors.storageRoot', () => {
    const file = path.join(dir, 'f.txt')
    fs.writeFileSync(file, 'x')
    const res = call('settings:set', { storageRoot: file })
    expect(res.errors?.storageRoot).toMatch(/無法建立或寫入/)
    expect(res.settings.storageRoot).toBeNull()
  })

  test('null：只清除 storageRoot，不動 outputDir／defaultOutDir', () => {
    const root = path.join(dir, 'Apex')
    call('settings:set', { storageRoot: root })
    const res = call('settings:set', { storageRoot: null })
    expect(res.errors).toBeUndefined()
    expect(res.settings.storageRoot).toBeNull()
    expect(res.settings.recording.outputDir).toBe(path.join(root, 'Recordings'))
    expect(res.settings.defaultOutDir).toBe(path.join(root, 'Exports'))
  })

  test('建議值 IPC：未設定時回影片資料夾\Aditor，已設定過則沿用上一層', () => {
    expect(call(STORAGE_SUGGEST_CHANNEL)).toBe(path.join(videos, 'Aditor'))
    const root = path.join(dir, 'Mine')
    call('settings:set', { storageRoot: root })
    expect(call(STORAGE_SUGGEST_CHANNEL)).toBe(root)
  })
})
