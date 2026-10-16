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
  shell: {}
}))

import { registerIpcHandlers } from './ipc-handlers'
import { SettingsStore } from './settings'
import { cacheFilePath } from './cache-io'
import { cacheDir } from '../shared/paths'

/** 接線測試：cache:loadByVideo 讀的位置隨 settings.cacheLocation 變，且與引擎的 beside 規則相同。 */
describe('cache:loadByVideo 依 cacheLocation 設定讀取', () => {
  let dir: string
  let oldAppData: string | undefined
  beforeEach(() => {
    handlers.clear()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apexhl-cw-'))
    oldAppData = process.env.APPDATA
    process.env.APPDATA = path.join(dir, 'appdata')
  })
  afterEach(() => {
    process.env.APPDATA = oldAppData
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('appdata 與 besideVideo 各讀各的檔；切換後另一處的舊快取仍讀得到', async () => {
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
    // 影片旁尚無檔 → 退回 appdata 的既有快取（切換不會弄丟）
    expect(await load({}, video)).toEqual({ where: 'appdata' })
    fs.writeFileSync(besideFile, JSON.stringify({ where: 'beside' }))
    expect(await load({}, video)).toEqual({ where: 'beside' })
    expect(besideFile).toBe(path.join(path.dirname(video), 'm.apexhl.json'))

    store.set({ cacheLocation: 'appdata' })
    expect(await load({}, video)).toEqual({ where: 'appdata' })
  })

  test('library:computeHl 讀 besideVideo 的快取（與 cache:loadByVideo 同一規則）', async () => {
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
})
