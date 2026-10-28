import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { DEFAULT_SETTINGS, SETTINGS_VERSION } from '../shared/settings'
import { loadSettings, migrateSettings, saveSettings, SettingsStore } from './settings'

describe('settings store', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-settings-'))
    file = path.join(dir, 'settings.json')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('missing file returns defaults without creating file until first set', () => {
    expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS)
    expect(fs.existsSync(file)).toBe(false)

    const store = new SettingsStore(file)
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
    expect(fs.existsSync(file)).toBe(false)

    // The file is created only on the first set.
    store.set({ before: 10 })
    expect(fs.existsSync(file)).toBe(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).before).toBe(10)
  })

  it('persists the same-day video-row collapse preference, preserves it after reload, and rejects invalid values', () => {
    const store = new SettingsStore(file)
    expect(store.get().sameDayVideosCollapsed).toBe(false)
    expect(store.set({ sameDayVideosCollapsed: true }).persisted).toBe(true)
    expect(new SettingsStore(file).get().sameDayVideosCollapsed).toBe(true)
    store.set({ sameDayVideosCollapsed: 'auto' as unknown as boolean })
    expect(loadSettings(file).sameDayVideosCollapsed).toBe(true)
  })

  it('persists preview audio across reload and unrelated changes, rejecting invalid values', () => {
    const store = new SettingsStore(file)
    expect(store.get()).toMatchObject({ previewVolume: 100, previewMuted: false })
    expect(store.set({ previewVolume: 35, previewMuted: true }).persisted).toBe(true)
    store.set({ before: 5 })
    expect(new SettingsStore(file).get()).toMatchObject({ previewVolume: 35, previewMuted: true })
    for (const previewVolume of [-1, 101, NaN, Infinity, '50', null]) {
      store.set({ previewVolume } as never)
      expect(store.get().previewVolume).toBe(35)
    }
    store.set({ previewMuted: 'true' } as never)
    expect(store.get().previewMuted).toBe(true)
    expect(store.set({ previewVolume: 0, previewMuted: false }).persisted).toBe(true)
    expect(loadSettings(file)).toMatchObject({ previewVolume: 0, previewMuted: false })
  })

  it('recording setting defaults, legacy FPS migration, invalid values, and reload', () => {
    const store = new SettingsStore(file)
    expect(store.get().recording).toMatchObject({ preset: 'speed', forceAspect: false, aspectMode: 'fit',
      systemAudioEnabled: true, systemGain: 1, gameAudioOnly: false, micMono: false })
    fs.writeFileSync(file, JSON.stringify({ recording: { fps: 144, preset: 'oops', aspectMode: 'crop',
      forceAspect: 1, systemAudioEnabled: 'yes', systemGain: 9, gameAudioOnly: null, micMono: 1 } }))
    expect(loadSettings(file).recording).toMatchObject({ fps: 120, preset: 'speed', forceAspect: false, aspectMode: 'fit',
      systemAudioEnabled: true, systemGain: 2, gameAudioOnly: false, micMono: false })
    for (const fps of [10, 20, 30, 60, 90, 120] as const) {
      store.set({ recording: { ...store.get().recording, fps, preset: 'quality', forceAspect: true,
        aspectMode: 'stretch', systemAudioEnabled: false, systemGain: 0.25, gameAudioOnly: true, micMono: true } })
      expect(new SettingsStore(file).get().recording).toMatchObject({ fps, preset: 'quality', forceAspect: true,
        aspectMode: 'stretch', systemAudioEnabled: false, systemGain: 0.25, gameAudioOnly: true, micMono: true })
    }
    fs.writeFileSync(file, JSON.stringify({ recording: { fps: 59, systemGain: 'bad' } }))
    expect(loadSettings(file).recording).toMatchObject({ fps: 60, systemGain: 1 })
  })

  it('corrupt json is backed up to .bak and defaults returned', () => {
    fs.writeFileSync(file, '{ this is not valid json', 'utf-8')

    const recovered = { ...DEFAULT_SETTINGS, telemetryEnabled: false, recording: { ...DEFAULT_SETTINGS.recording, autoRecord: false } }
    expect(loadSettings(file)).toEqual(recovered)
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual(recovered)
    expect(fs.existsSync(`${file}.bak`)).toBe(true)
    expect(fs.readFileSync(`${file}.bak`, 'utf-8')).toBe('{ this is not valid json')
  })

  it('corrupt json keeps telemetry and auto-recording off unless the damaged file still shows them on', () => {
    const optedOut = JSON.stringify({ ...DEFAULT_SETTINGS, telemetryEnabled: false, recording: { ...DEFAULT_SETTINGS.recording, autoRecord: false } })
    fs.writeFileSync(file, optedOut.slice(0, -40), 'utf-8')
    expect(loadSettings(file)).toMatchObject({ telemetryEnabled: false, recording: { autoRecord: false } })
    // The startup read renames the file; the store created later must not fall back to telemetry-on defaults.
    expect(new SettingsStore(file).get()).toMatchObject({ telemetryEnabled: false, recording: { autoRecord: false } })

    fs.writeFileSync(file, '{ "telemetryEnabled": tru', 'utf-8')
    expect(loadSettings(file)).toMatchObject({ telemetryEnabled: false, recording: { autoRecord: false } })

    fs.writeFileSync(file, JSON.stringify(DEFAULT_SETTINGS).slice(0, -40), 'utf-8')
    expect(loadSettings(file)).toMatchObject({ telemetryEnabled: true, recording: { autoRecord: true } })
  })

  it('old/no-version file migrates and keeps known values', () => {
    // Legacy file without a version field: preserve known values and fill missing fields with defaults.
    fs.writeFileSync(
      file,
      JSON.stringify({ before: 12, after: 2, watchFolders: ['D:/rec'], autoAnalyze: false }),
      'utf-8'
    )
    const s = loadSettings(file)
    expect(s.version).toBe(SETTINGS_VERSION)
    expect(s.before).toBe(12)
    expect(s.after).toBe(2)
    expect(s.watchFolders).toEqual(['D:/rec'])
    expect(s.autoAnalyze).toBe(false)
    expect(s.autoclip).toEqual(DEFAULT_SETTINGS.autoclip)

    // Older versions also go through migration.
    fs.writeFileSync(file, JSON.stringify({ version: 0, before: 6 }), 'utf-8')
    const s2 = loadSettings(file)
    expect(s2.version).toBe(SETTINGS_VERSION)
    expect(s2.before).toBe(6)
    expect(s2.after).toBe(DEFAULT_SETTINGS.after)
  })

  it('safely drops removed gameLang (or other unknown fields) from legacy settings without errors and preserves remaining fields', () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, gameLang: 'ja', before: 5, mystery: 1 }), 'utf-8')
    const s = loadSettings(file) as unknown as Record<string, unknown>
    expect(s.before).toBe(5)
    expect('gameLang' in s).toBe(false)
    expect('mystery' in s).toBe(false)
    expect('gameLang' in (DEFAULT_SETTINGS as unknown as Record<string, unknown>)).toBe(false)
    fs.writeFileSync(file, JSON.stringify({ gameLang: 'fr' }), 'utf-8')
    expect('gameLang' in (loadSettings(file) as unknown as Record<string, unknown>)).toBe(false)
  })

  it('lowPerfAsked defaults to false; non-booleans fall back, booleans are preserved and persisted', () => {
    expect(DEFAULT_SETTINGS.lowPerfAsked).toBe(false)
    fs.writeFileSync(file, JSON.stringify({ version: 1, lowPerfAsked: 'yes' }), 'utf-8')
    expect(loadSettings(file).lowPerfAsked).toBe(false)
    fs.writeFileSync(file, JSON.stringify({ version: 1, lowPerfAsked: true }), 'utf-8')
    expect(loadSettings(file).lowPerfAsked).toBe(true)
    const store = new SettingsStore(file)
    expect(store.set({ lowPerfAsked: false }).settings.lowPerfAsked).toBe(false)
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).lowPerfAsked).toBe(false)
  })

  it('unknown keys dropped; wrong-typed field falls back to default individually', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        before: '八', // Type mismatch: fall back only this field.
        after: 9, // Valid: keep it.
        lowPerfMode: true, // Valid: keep it.
        watchFolders: ['D:/ok', 42], // Remove non-string items from the array.
        autoclip: { n: '3', gap: 30 }, // Fall back for n's type mismatch; keep gap.
        unknownKey: 'x',
        telemetry: { on: true }
      }),
      'utf-8'
    )
    const s = loadSettings(file) as unknown as Record<string, unknown>

    // Do not invalidate the whole object: preserve other fields and discard all unknown keys.
    expect(Object.keys(s).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort())
    expect(s.before).toBe(DEFAULT_SETTINGS.before)
    expect(s.after).toBe(9)
    expect(s.lowPerfMode).toBe(true)
    expect(s.watchFolders).toEqual(['D:/ok'])
    expect(s.autoclip).toEqual({ ...DEFAULT_SETTINGS.autoclip, gap: 30 })
  })

  it('set merges partial, validates ranges (before/after 0..30, autoclip bounds) and persists atomically', () => {
    const store = new SettingsStore(file)
    const renameSpy = vi.spyOn(fs, 'renameSync')

    const r1 = store.set({ before: 12, autoclip: { ...DEFAULT_SETTINGS.autoclip, n: 5 } })
    expect(r1.persisted).toBe(true)
    const s = r1.settings
    expect(s.before).toBe(12)
    expect(s.autoclip.n).toBe(5)

    // Atomic write: temporary file + rename, with no temporary file left behind.
    expect(renameSpy).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(onDisk.version).toBe(SETTINGS_VERSION)
    expect(onDisk.before).toBe(12)
    expect(onDisk.autoclip.n).toBe(5)

    // Out-of-range/incorrectly typed fields have no effect (preserve old values); valid fields are applied normally.
    const s2 = store.set({
      before: 99,
      after: -1,
      autoclip: { ...s.autoclip, gap: 1000, max_len: 14 },
      lowPerfMode: true
    }).settings
    expect(s2.before).toBe(12)
    expect(s2.after).toBe(DEFAULT_SETTINGS.after)
    expect(s2.autoclip.gap).toBe(DEFAULT_SETTINGS.autoclip.gap)
    expect(s2.autoclip.max_len).toBe(DEFAULT_SETTINGS.autoclip.max_len)
    expect(s2.autoclip.n).toBe(5)
    expect(s2.lowPerfMode).toBe(true)

    // Boundary values (including endpoints) are allowed.
    const s3 = store.set({ before: 0, after: 30 }).settings
    expect(s3.before).toBe(0)
    expect(s3.after).toBe(30)
  })

  it('failed rename leaves previous settings.json intact', () => {
    expect(saveSettings(file, { ...DEFAULT_SETTINGS, before: 10 })).toBe(true)
    const previous = fs.readFileSync(file, 'utf-8')
    const store = new SettingsStore(file)

    // Simulate rename failure (for example, the file is locked).
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('EPERM: rename failed')
    })
    const r = store.set({ before: 5 })
    expect(r.settings.before).toBe(5) // The in-memory state is still updated without throwing.
    expect(r.persisted).toBe(false) // Explicitly report that nothing was written to disk.
    expect(store.get().before).toBe(5)

    expect(fs.readFileSync(file, 'utf-8')).toBe(previous) // The old file remains intact.
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).before).toBe(10)
    expect(fs.existsSync(`${file}.tmp`)).toBe(false) // The temporary file was removed.
  })

  it('an unreadable settings file keeps privacy opt-outs off and is never overwritten until it can be read', () => {
    expect(saveSettings(file, { ...DEFAULT_SETTINGS, before: 10, telemetryEnabled: false,
      recording: { ...DEFAULT_SETTINGS.recording, autoRecord: false } })).toBe(true)
    const previous = fs.readFileSync(file, 'utf-8')
    const realRead = fs.readFileSync
    const busy = vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (p === file) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      return (realRead as (...args: unknown[]) => unknown)(p, ...rest)
    }) as typeof fs.readFileSync)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const loaded = loadSettings(file)
    expect(loaded.telemetryEnabled).toBe(false)
    expect(loaded.recording.autoRecord).toBe(false)
    const store = new SettingsStore(file)
    expect(store.get().telemetryEnabled).toBe(false)
    const r = store.set({ after: 7 })
    expect(r.persisted).toBe(false)
    busy.mockRestore()
    expect(fs.readFileSync(file, 'utf-8')).toBe(previous)

    // Once readable again, the next set rebases on the saved file instead of replacing it.
    const next = store.set({ after: 8 })
    expect(next.persisted).toBe(true)
    expect(next.settings).toMatchObject({ before: 10, after: 8, telemetryEnabled: false })
    expect(next.settings.recording.autoRecord).toBe(false)
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toMatchObject({ before: 10, after: 8, telemetryEnabled: false })
  })

  it('onChange fires once per set', () => {
    const store = new SettingsStore(file)
    const seen: number[] = []
    const off = store.onChange((s) => seen.push(s.before))

    store.set({ before: 1 })
    store.set({ before: 2 })
    expect(seen).toEqual([1, 2])

    off()
    store.set({ before: 3 })
    expect(seen).toEqual([1, 2])
  })

  it('set reports persisted:true on success and persisted:false when the write fails', () => {
    const store = new SettingsStore(file)
    expect(store.set({ before: 7 }).persisted).toBe(true)
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENOSPC: no space left')
    })
    const r = store.set({ before: 9 })
    expect(r.persisted).toBe(false)
    expect(r.settings.before).toBe(9)
  })

  it('a later successful set persists again (memory and disk converge)', () => {
    const store = new SettingsStore(file)
    const spy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('EPERM')
    })
    expect(store.set({ before: 5 }).persisted).toBe(false)
    spy.mockRestore()
    // Retry persisting previously unwritten state even if no fields changed this time.
    const r = store.set({})
    expect(r.persisted).toBe(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).before).toBe(5)
  })

  it('invalid set leaves the file on disk byte-for-byte unchanged', () => {
    const store = new SettingsStore(file)
    store.set({ before: 12 })
    const before = fs.readFileSync(file, 'utf-8')
    const mtime = fs.statSync(file).mtimeMs
    const r = store.set({
      before: 99,
      after: -1,
      lowPerfMode: 'yes' as unknown as boolean,
      autoclip: { ...DEFAULT_SETTINGS.autoclip, gap: 1000 }
    })
    expect(r.persisted).toBe(true)
    expect(r.settings.before).toBe(12)
    expect(fs.readFileSync(file, 'utf-8')).toBe(before)
    expect(fs.statSync(file).mtimeMs).toBe(mtime)
  })

  it('a listener that throws does not abort set nor starve other listeners', () => {
    const store = new SettingsStore(file)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const seen: number[] = []
    store.onChange(() => {
      throw new Error('boom')
    })
    store.onChange((s) => seen.push(s.before))
    const r = store.set({ before: 4 })
    expect(r.persisted).toBe(true)
    expect(r.settings.before).toBe(4)
    expect(seen).toEqual([4])
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).before).toBe(4)
  })
})

describe('capture method setting', () => {
  it('defaults to auto and accepts every capture method', () => {
    expect(DEFAULT_SETTINGS.recording.captureMethod).toBe('auto')
    for (const captureMethod of ['auto', 'wgc', 'dda', 'hook'] as const) {
      expect(migrateSettings({ version: SETTINGS_VERSION, recording: { captureMethod } }).recording.captureMethod).toBe(captureMethod)
    }
  })

  it('moves the WGC that version 1 saved by default to auto once', () => {
    expect(migrateSettings({ version: 1, recording: { captureMethod: 'wgc' } }).recording.captureMethod).toBe('auto')
    expect(migrateSettings({ recording: { captureMethod: 'wgc' } }).recording.captureMethod).toBe('auto')
    // DDA was never the default, so a version 1 DDA is a deliberate choice.
    expect(migrateSettings({ version: 1, recording: { captureMethod: 'dda' } }).recording.captureMethod).toBe('dda')
  })
})
