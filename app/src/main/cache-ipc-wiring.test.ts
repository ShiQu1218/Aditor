import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

type Fn = (...a: any[]) => any
const handlers = new Map<string, Fn>()
const listeners = new Map<string, Fn>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: Fn) => void handlers.set(ch, fn), on: (ch: string, fn: Fn) => void listeners.set(ch, fn), removeHandler: () => {} },
  dialog: {},
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  app: { getPath: () => os.tmpdir(), isPackaged: false, getVersion: () => '0' },
  shell: {},
  safeStorage: { isEncryptionAvailable: () => false }
}))

import { registerIpcHandlers } from './ipc-handlers'
import { Library } from './library'
import { SettingsStore } from './settings'
import { cacheFilePath } from './cache-io'
import { cacheDir } from '../shared/paths'
import { clipsBackupPath } from './reanalysis'
import { proxyPath } from './proxy'
import { sourceStamp, stampMediaCache } from './media-cache'

/** Wiring test: cache:loadByVideo reads from the location selected by settings.cacheLocation, using the same beside rule as the engine. */
describe('cache:loadByVideo reads according to cacheLocation', () => {
  let dir: string
  let oldAppData: string | undefined
  beforeEach(() => {
    handlers.clear()
    listeners.clear()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-cw-'))
    oldAppData = process.env.APPDATA
    process.env.APPDATA = path.join(dir, 'appdata')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    process.env.APPDATA = oldAppData
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test.each(['cache:save', 'cache:saveSync'])('%s broadcasts only when the highlight count changes', async (channel) => {
    vi.useFakeTimers()
    const video = path.join(dir, 'save.mp4')
    const library = new Library(path.join(dir, 'library.json'))
    library.add([video])
    library.update(video, { hl: 0 })
    const send = vi.fn()
    const queue = { on: () => {}, payload: () => ({}) } as any
    registerIpcHandlers(library, queue, () => [{ isDestroyed: () => false, webContents: { send } }] as any)
    const save = async (clips: unknown[], events: unknown[] = []) => {
      const event = { returnValue: undefined }
      const doc = { video: { path: video }, events, clips }
      if (channel === 'cache:save') return handlers.get(channel)!(event, doc)
      listeners.get(channel)!(event, doc)
      return event.returnValue
    }
    const sync = vi.spyOn(fs, 'fsyncSync')
    const rename = vi.spyOn(fs, 'renameSync')
    expect(await save([])).toBe(true)
    vi.advanceTimersByTime(1000)
    expect(send).not.toHaveBeenCalled()
    const clips = [{ id: 'a', start: 0, end: 1, origin: 'ai', status: 'suggested', event_ids: [] }]
    expect(await save(clips)).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
    expect(library.get(video)?.hl).toBe(1)
    const syncs = sync.mock.calls.length
    const renames = rename.mock.calls.length
    const events = [{ id: 'manual', t: 5, source: 'manual', type: 'knock' }]
    expect(await save(clips, events)).toBe(true)
    vi.advanceTimersByTime(1000)
    expect(send).toHaveBeenCalledTimes(1)
    expect(sync).toHaveBeenCalledTimes(syncs)
    expect(rename).toHaveBeenCalledTimes(renames + 1)
    expect(JSON.parse(fs.readFileSync(cacheFilePath(video, cacheDir()), 'utf-8')).events).toEqual(events)
  })

  test.each(['changed', 'unchanged', 'reanalyzing', 'removed'])('computeHl broadcasts only for a changed entry: %s', async (state) => {
    vi.useFakeTimers()
    const video = path.join(dir, 'compute.mp4')
    const library = new Library(path.join(dir, 'library.json'))
    library.add([video])
    library.update(video, { status: 'done' })
    const dest = cacheFilePath(video, cacheDir())
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, JSON.stringify({ video: { duration: 10 }, analysis: { status: 'done' }, events: [], clips: [] }))
    let resolve!: (result: { clips: unknown[] }) => void
    const promise = new Promise<{ clips: unknown[] }>((done) => { resolve = done })
    const engine = { request: vi.fn(() => ({ promise })) } as any
    const send = vi.fn()
    const queue = { on: () => {}, payload: () => ({}) } as any
    registerIpcHandlers(library, queue, () => [{ isDestroyed: () => false, webContents: { send } }] as any, engine)
    const result = handlers.get('library:computeHl')!({}, video)
    await Promise.resolve()
    expect(engine.request).toHaveBeenCalledTimes(1)
    if (state === 'unchanged') library.update(video, { hl: 0 })
    if (state === 'reanalyzing') library.update(video, { status: 'analyzing' })
    if (state === 'removed') library.remove(video)
    const save = vi.spyOn(library, 'save')
    resolve({ clips: [] })
    expect(await result).toBe(0)
    vi.advanceTimersByTime(1000)
    expect(send).toHaveBeenCalledTimes(state === 'changed' ? 1 : 0)
    expect(save).toHaveBeenCalledTimes(state === 'changed' ? 1 : 0)
    if (state === 'changed' || state === 'unchanged') {
      expect(await handlers.get('library:computeHl')!({}, video)).toBe(0)
      vi.advanceTimersByTime(1000)
      expect(send).toHaveBeenCalledTimes(state === 'changed' ? 1 : 0)
    }
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

  test('saving during analysis uses a durable backup, and reopening overlays it on newer engine results', async () => {
    const video = path.join(dir, 'v.mp4')
    const dest = cacheFilePath(video, cacheDir())
    const library = { get: () => ({ path: video, status: 'analyzing' }), update: () => {}, getEntries: () => [] } as any
    const queue = { on: () => {}, payload: () => ({}), activeCachePath: () => dest } as any
    registerIpcHandlers(library, queue, () => [])
    const manual = { id: 'm1', t: 5, source: 'manual', type: 'knock' }
    const doc = { video: { path: video }, analysis: { status: 'partial' }, events: [manual], clips: [] }
    expect(await handlers.get('cache:save')!({}, doc)).toBe(true)
    expect(fs.existsSync(dest)).toBe(false)
    expect(fs.existsSync(clipsBackupPath(dest))).toBe(true)
    fs.writeFileSync(dest, JSON.stringify({ ...doc, analysis: { status: 'done' }, events: [{ id: 'a1', t: 10, source: 'auto' }] }))
    const loaded = await handlers.get('cache:loadByVideo')!({}, video)
    expect(loaded.analysis.status).toBe('done')
    expect(loaded.events.map((e: { id: string }) => e.id)).toEqual(['m1', 'a1'])
  })

  test('proxy:get rejects replaced sources and proxy:delete removes the source stamp too', async () => {
    const video = path.join(dir, 'v.mp4')
    fs.writeFileSync(video, 'old')
    const proxy = proxyPath(video)
    fs.mkdirSync(path.dirname(proxy), { recursive: true })
    fs.writeFileSync(proxy, 'proxy')
    stampMediaCache(proxy, sourceStamp(video))
    const library = { getEntries: () => [] } as any
    const queue = { on: () => {} } as any
    registerIpcHandlers(library, queue, () => [])
    const get = handlers.get('proxy:get')!
    expect(await get({}, video)).toBe(proxy)
    fs.writeFileSync(video, 'replacement')
    expect(await get({}, video)).toBeNull()
    expect(await handlers.get('proxy:delete')!({}, video)).toBe(true)
    expect(fs.existsSync(proxy)).toBe(false)
    expect(fs.existsSync(proxy + '.source')).toBe(false)
  })
})
