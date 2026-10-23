import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

type Fn = (...a: any[]) => any
const handlers = new Map<string, Fn>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: Fn) => void handlers.set(ch, fn), on: () => {}, removeHandler: () => {} },
  dialog: {},
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  app: { getPath: () => os.tmpdir(), isPackaged: false, getVersion: () => '0' },
  shell: {},
  safeStorage: { isEncryptionAvailable: () => false }
}))

import { registerIpcHandlers } from './ipc-handlers'
import { SettingsStore } from './settings'
import { cacheFilePath } from './cache-io'
import { cacheDir } from '../shared/paths'

/** Wiring test: cache:loadByVideo reads from the location selected by settings.cacheLocation, using the same beside rule as the engine. */
describe('cache:loadByVideo reads according to cacheLocation', () => {
  let dir: string
  let oldAppData: string | undefined
  beforeEach(() => {
    handlers.clear()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-cw-'))
    oldAppData = process.env.APPDATA
    process.env.APPDATA = path.join(dir, 'appdata')
  })
  afterEach(() => {
    process.env.APPDATA = oldAppData
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('appdata and besideVideo read their own files; the old cache at the other location remains readable after switching', async () => {
    const video = path.join(dir, 'videos', 'm.mp4')
    fs.mkdirSync(path.dirname(video), { recursive: true })
    const store = new SettingsStore(path.join(dir, 'settings.json'))
    const library = { get: () => undefined, getEntries: () => [], update: () => {}, add: () => [] } as any
    const queue = { on: () => {}, payload: () => ({}), enqueue: () => {}, cancel: () => {} } as any
    registerIpcHandlers(library, queue, () => [], undefined, store)
    const load = handlers.get('cache:loadByVideo')!

    const appdataFile = cacheFilePath(video, cacheDir(), false)
    const besideFile = cacheFilePath(video, cacheDir(), true)
    fs.mkdirSync(path.dirname(appdataFile), { recursive: true })
    fs.writeFileSync(appdataFile, JSON.stringify({ where: 'appdata' }))

    expect(await load({}, video)).toEqual({ where: 'appdata' })

    store.set({ cacheLocation: 'besideVideo' })
    // No file beside the video yet → fall back to the existing appdata cache (changing locations does not lose it).
    expect(await load({}, video)).toEqual({ where: 'appdata' })
    fs.writeFileSync(besideFile, JSON.stringify({ where: 'beside' }))
    expect(await load({}, video)).toEqual({ where: 'beside' })
    expect(besideFile).toBe(path.join(path.dirname(video), 'm.mp4.aditor.json'))

    store.set({ cacheLocation: 'appdata' })
    expect(await load({}, video)).toEqual({ where: 'appdata' })
  })

  test('library:computeHl reads the besideVideo cache using the same rule as cache:loadByVideo', async () => {
    const video = path.join(dir, 'videos', 'h.mp4')
    fs.mkdirSync(path.dirname(video), { recursive: true })
    const store = new SettingsStore(path.join(dir, 'settings.json'))
    store.set({ cacheLocation: 'besideVideo' })
    const entry = { path: video, status: 'done' as const }
    const updates: unknown[] = []
    const library = { get: () => entry, update: (_p: string, u: unknown) => void updates.push(u), getEntries: () => [] } as any
    const queue = { on: () => {}, payload: () => ({}), enqueue: () => {}, cancel: () => {} } as any
    const engine = { request: () => ({ promise: Promise.resolve({ clips: [] }) }) } as any
    registerIpcHandlers(library, queue, () => [], engine, store)
    const doc = {
      analysis: { status: 'done' },
      events: [],
      video: { duration: 10 },
      clips: [
        { id: 'a', start: 0, end: 1, origin: 'ai', status: 'suggested', event_ids: [] },
        { id: 'b', start: 2, end: 3, origin: 'ai', status: 'accepted', event_ids: [] }
      ]
    }
    fs.writeFileSync(cacheFilePath(video, cacheDir(), true), JSON.stringify(doc))
    expect(await handlers.get('library:computeHl')!({}, video)).toBe(1)
    expect(updates).toContainEqual({ hl: 1 })
  })

  test('I1: cache:save ignores renderer cache_path and writes to the location derived from the video; reject videos outside the library', async () => {
    const video = path.join(dir, 'videos', 's.mp4')
    fs.mkdirSync(path.dirname(video), { recursive: true })
    const store = new SettingsStore(path.join(dir, 'settings.json'))
    const updates: unknown[] = []
    const library = { get: (p: string) => (p === video ? { path: video, status: 'done' } : undefined), update: (_p: string, u: unknown) => void updates.push(u), getEntries: () => [] } as any
    const queue = { on: () => {}, payload: () => ({}), enqueue: () => {}, cancel: () => {} } as any
    registerIpcHandlers(library, queue, () => [], undefined, store)
    const save = handlers.get('cache:save')!
    const evil = path.join(dir, 'startup', 'evil.cmd')
    expect(await save({}, { cache_path: evil, video: { path: video }, events: [], clips: [] })).toBe(true)
    expect(fs.existsSync(evil)).toBe(false)
    const dest = cacheFilePath(video, cacheDir(), false)
    expect(JSON.parse(fs.readFileSync(dest, 'utf-8')).cache_path).toBe(dest)
    expect(await save({}, { cache_path: evil, video: { path: path.join(dir, 'videos', 'other.mp4') }, events: [] })).toBe(false)
    expect(handlers.has('cache:load')).toBe(false)
  })
})
