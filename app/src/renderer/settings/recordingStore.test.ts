// Keep this in A2's settings test directory; use a temporary folder to verify main's persistence flow.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { SettingsStore, migrateSettings } from '../../main/settings'
import { registerSettingsHandlers } from '../../main/settings-ipc'
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings'
import { DEFAULT_RECORDING_SETTINGS as defaults, RECORDING_RANGES, type RecordingSettings } from '../../shared/recording'

let dir: string
let file: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-recording-settings-'))
  file = path.join(dir, 'settings.json')
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

const migrate = (recording: unknown): RecordingSettings => migrateSettings({ recording }).recording
const patch = (recording: unknown): Partial<Settings> => ({ recording } as Partial<Settings>)

describe('Recording settings validation and migration', () => {
  test.each([undefined, null, [], false, 'invalid'])('legacy or invalid recording=%j receives independent defaults', (raw) => {
    const settings = raw === undefined ? migrateSettings({ before: 12 }) : migrateSettings({ recording: raw })
    expect(settings.recording).toEqual(defaults)
    settings.recording.autoRecord = false
    expect(defaults.autoRecord).toBe(true)
    expect(DEFAULT_SETTINGS.recording.autoRecord).toBe(true)
  })

  test.each(['autoRecord', 'launchAtLogin', 'closeToTray', 'micEnabled', 'notifyMatch', 'openOnGameExit', 'forceAspect', 'systemAudioEnabled', 'gameAudioOnly', 'micMono'] as const)('%s accepts boolean values only', (field) => {
    for (const value of [false, true]) expect(migrate({ [field]: value })[field]).toBe(value)
    for (const value of [null, 0, 1, 'true', {}, []]) expect(migrate({ [field]: value })[field]).toBe(defaults[field])
  })

  test.each(Object.entries(RECORDING_RANGES))('%s bounds, clamping, and invalid types', (field, range) => {
    const key = field as keyof typeof RECORDING_RANGES
    const extra = key === 'diskStopGb' ? { diskWarnGb: 500 } : {}
    for (const value of [range.min, range.max]) expect(migrate({ ...extra, [field]: value })[key]).toBe(value)
    expect(migrate({ ...extra, [field]: range.min - 1 })[key]).toBe(range.min)
    expect(migrate({ ...extra, [field]: range.max + 1 })[key]).toBe(range.max)
    for (const value of [Number.NaN, Infinity, -Infinity, null, '10', true, {}]) {
      expect(migrate({ ...extra, [field]: value })[key]).toBe(defaults[key])
    }
  })

  test.each([
    ['mode', ['session', 'match']],
    ['codec', ['hevc', 'h264', 'av1']],
    ['preset', ['speed', 'balanced', 'quality']],
    ['aspectMode', ['fit', 'stretch']],
    ['fps', [10, 20, 30, 60, 90, 120]],
    ['height', [0, 720, 1080, 1440]],
    ['postAnalysis', ['none', 'afterExit', 'perMatch']],
    ['captureMethod', ['wgc', 'dda']]
  ] as const)('%s accepts only allowed enum values', (field, allowed) => {
    for (const value of allowed) expect(migrate({ [field]: value })[field]).toBe(value)
    for (const value of ['invalid', null, false, {}, [], -1, 999]) expect(migrate({ [field]: value })[field]).toBe(defaults[field])
  })

  test('Capture defaults to wgc; removed capture settings migrate safely and remain valid after saving and reloading', () => {
    expect(defaults.captureMethod).toBe('wgc')
    expect(migrate({}).captureMethod).toBe('wgc')
    expect(migrate({ captureMethod: 'hook' }).captureMethod).toBe('wgc')
    expect(migrate({ captureMethod: 'dda' }).captureMethod).toBe('dda')
    expect(migrate({ captureMethod: 'wgc' }).captureMethod).toBe('wgc')
    fs.writeFileSync(file, JSON.stringify({ recording: { captureMethod: 'hook', bitrateKbps: 23456 } }))
    const store = new SettingsStore(file)
    expect(store.get().recording).toMatchObject({ captureMethod: 'wgc', bitrateKbps: 23456 })
    expect(store.set(patch({ fps: 30 })).persisted).toBe(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).recording.captureMethod).toBe('wgc')
    const reloaded = new SettingsStore(file)
    expect(reloaded.get().recording).toMatchObject({ captureMethod: 'wgc', bitrateKbps: 23456, fps: 30 })
    expect(reloaded.set(patch({ captureMethod: 'dda' })).persisted).toBe(true)
    expect(reloaded.set(patch({ captureMethod: 'hook' })).settings.recording.captureMethod).toBe('dda')
    expect(new SettingsStore(file).get().recording.captureMethod).toBe('dda')
  })

  test.each(['builtin', 'obs', 'invalid', null, 1])('backend %j preserves valid values', (backend) => {
    expect(migrate({ backend }).backend).toBe(backend === 'obs' ? 'obs' : 'builtin')
  })

  test('Encoder must be hardware-based and match the format; changing format resets it to automatic', () => {
    for (const codec of ['hevc', 'h264', 'av1']) {
      for (const vendor of ['nvenc', 'amf', 'qsv']) {
        const encoder = `${codec}_${vendor}`
        expect(migrate({ codec, encoder }).encoder).toBe(encoder)
      }
    }
    for (const encoder of ['libx264', 'h264_nvenc', '', null, 42]) expect(migrate({ encoder }).encoder).toBe('auto')
    const store = new SettingsStore(file)
    store.set(patch({ encoder: 'hevc_nvenc' }))
    expect(store.set(patch({ codec: 'av1' })).settings.recording.encoder).toBe('auto')
  })

  test.each(['renderDevice', 'captureDevice'] as const)('%s preserves valid device IDs and rejects blanks or invalid values', (field) => {
    for (const value of ['default', '{device-id}']) expect(migrate({ [field]: value })[field]).toBe(value)
    for (const value of ['', '  ', '\0', 'x'.repeat(4097), null, 2, {}]) expect(migrate({ [field]: value })[field]).toBe('default')
  })

  test('Recording GPU preserves adapter IDs including duplicates and defaults to auto for invalid values', () => {
    for (const value of ['auto', '10de:2684', '8086:46a6#2']) expect(migrate({ gpu: value }).gpu).toBe(value)
    for (const value of ['', '  ', '\0', 'x'.repeat(4097), null, 2, {}]) expect(migrate({ gpu: value }).gpu).toBe('auto')
    expect(defaults.gpu).toBe('auto')
  })

  test('Disk stop threshold is clamped to the warning threshold', () => {
    expect(migrate({ diskStopGb: 50, diskWarnGb: 5 })).toMatchObject({ diskStopGb: 5, diskWarnGb: 5 })
    const store = new SettingsStore(file)
    store.set(patch({ diskStopGb: 8 }))
    expect(store.set(patch({ diskWarnGb: 1 })).settings.recording.diskStopGb).toBe(1)
  })

  test('Path validation rejects relative paths, files, missing paths, network paths, and wrong types while other fields still apply', () => {
    fs.writeFileSync(path.join(dir, 'file.txt'), '')
    const store = new SettingsStore(file)
    store.set(patch({ outputDir: dir }))
    for (const value of ['', '.', path.join(dir, 'missing'), path.join(dir, 'file.txt'), '\\\\server\\share', '\0', 42, {}, []]) {
      const result = store.set(patch({ outputDir: value, fps: 30 }))
      expect(result.errors?.recordingOutputDir, String(value)).toBeTruthy()
      expect(result.settings.recording).toMatchObject({ outputDir: dir, fps: 30 })
      expect(new SettingsStore(file).get().recording.outputDir).toBe(dir)
    }
    expect(store.set(patch({ outputDir: null })).settings.recording.outputDir).toBeNull()
    expect(migrate({ outputDir: path.join(dir, 'missing') }).outputDir).toBeNull()
    expect(migrate({ outputDir: dir }).outputDir).toBe(dir)
  })

  test('Settings IPC returns path errors and persists valid fields; reloads and other setting changes do not overwrite recording values', () => {
    const handlers = new Map<string, (...args: any[]) => any>()
    const store = new SettingsStore(file)
    registerSettingsHandlers({ handle: (ch, cb) => void handlers.set(ch, cb) }, store, () => [])
    const res = handlers.get('settings:set')!({}, { recording: { outputDir: 'relative', autoRecord: false } })
    expect(res.errors.recordingOutputDir).toBeTruthy()
    expect(res.persisted).toBe(true)
    store.set({ before: 15 })
    expect(new SettingsStore(file).get().recording.autoRecord).toBe(false)
    const complete = { ...defaults, mode: 'match' as const, outputDir: dir, fps: 120 as const, micGain: 0.75, codec: 'av1' as const, encoder: 'av1_nvenc', notifyMatch: true }
    store.set({ recording: complete })
    store.set({ before: 16 })
    expect(new SettingsStore(file).get().recording).toEqual(complete)
  })

  test('Snapshots and listeners cannot mutate internal recording state or another listener’s state', () => {
    const store = new SettingsStore(file)
    store.get().recording.autoRecord = false
    store.onChange((s) => { s.recording.fps = 120 })
    const listener = vi.fn()
    store.onChange(listener)
    const result = store.set(patch({ fps: 30 }))
    expect(listener.mock.calls[0][0].recording.fps).toBe(30)
    result.settings.recording.fps = 120
    expect(store.get().recording.fps).toBe(30)
  })

  test('Write failure reports persisted=false; a retry brings disk and memory back in sync', () => {
    const store = new SettingsStore(file)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('EPERM') })
    expect(store.set(patch({ micEnabled: false })).persisted).toBe(false)
    expect(new SettingsStore(file).get().recording.micEnabled).toBe(true)
    rename.mockRestore()
    expect(store.set({}).persisted).toBe(true)
    expect(new SettingsStore(file).get().recording.micEnabled).toBe(false)
  })
})
