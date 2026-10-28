import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { SettingsStore } from './settings'
import { registerSettingsHandlers, STORAGE_SUGGEST_CHANNEL } from './settings-ipc'

type Fn = (...a: any[]) => any

describe('settings:set storageRoot', () => {
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

  test('a string root creates directories and synchronizes recording.outputDir, defaultOutDir, and storageRoot', () => {
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

  test('applies recording fields sent in the same request and uses the root for outputDir', () => {
    const root = path.join(dir, 'Apex')
    const res = call('settings:set', { storageRoot: root, onboardingDone: true, recording: { fps: 30, outputDir: path.join(dir, 'x') } })
    expect(res.settings.recording.fps).toBe(30)
    expect(res.settings.recording.outputDir).toBe(path.join(root, 'Recordings'))
    expect(res.settings.onboardingDone).toBe(true)
  })

  test('an invalid path returns errors.storageRoot, applies none of the three fields, and applies other fields normally', () => {
    for (const bad of ['relative/dir', 42, '']) {
      const res = call('settings:set', { storageRoot: bad, before: 5 })
      expect(res.errors?.storageRoot, String(bad)).toBeTruthy()
      expect(res.settings.storageRoot).toBeNull()
      expect(res.settings.defaultOutDir).toBeNull()
      expect(res.settings.recording.outputDir).toBeNull()
      expect(res.settings.before).toBe(5)
    }
  })

  test('returns errors.storageRoot when it cannot be created (root path is a file)', () => {
    const file = path.join(dir, 'f.txt')
    fs.writeFileSync(file, 'x')
    const res = call('settings:set', { storageRoot: file })
    expect(res.errors?.storageRoot).toMatch(/無法建立或寫入/)
    expect(res.settings.storageRoot).toBeNull()
  })

  test('null clears only storageRoot and leaves outputDir/defaultOutDir unchanged', () => {
    const root = path.join(dir, 'Apex')
    call('settings:set', { storageRoot: root })
    const res = call('settings:set', { storageRoot: null })
    expect(res.errors).toBeUndefined()
    expect(res.settings.storageRoot).toBeNull()
    expect(res.settings.recording.outputDir).toBe(path.join(root, 'Recordings'))
    expect(res.settings.defaultOutDir).toBe(path.join(root, 'Exports'))
  })

  test('suggestion IPC returns Videos/Aditor when unset and reuses the parent of the configured root', () => {
    expect(call(STORAGE_SUGGEST_CHANNEL)).toBe(path.join(videos, 'Aditor'))
    const root = path.join(dir, 'Mine')
    call('settings:set', { storageRoot: root })
    expect(call(STORAGE_SUGGEST_CHANNEL)).toBe(root)
  })

  test('refuses to move away from a recording folder that still has unfinished sessions, which recovery would no longer scan', () => {
    const oldRoot = path.join(dir, 'Old')
    const newRoot = path.join(dir, 'New')
    call('settings:set', { storageRoot: oldRoot })
    const session = path.join(oldRoot, 'Recordings', '.sessions', '20260101-000000-abcd')
    fs.mkdirSync(session, { recursive: true })

    const res = call('settings:set', { storageRoot: newRoot, before: 5 })
    expect(res.errors?.storageRoot).toBeTruthy()
    expect(res.settings.storageRoot).toBe(oldRoot)
    expect(res.settings.recording.outputDir).toBe(path.join(oldRoot, 'Recordings'))
    expect(res.settings.defaultOutDir).toBe(path.join(oldRoot, 'Exports'))
    expect(res.settings.before).toBe(5)
    expect(fs.existsSync(session)).toBe(true)

    expect(call('settings:set', { storageRoot: oldRoot }).errors).toBeUndefined()
    fs.rmSync(session, { recursive: true })
    expect(call('settings:set', { storageRoot: newRoot }).settings.storageRoot).toBe(newRoot)
  })
})
