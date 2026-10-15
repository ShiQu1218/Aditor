import { afterEach, describe, expect, test, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import type { FSWatcher } from 'chokidar'
import { Library } from './library'
import { WatchManager, validateWatchDir, watchKey, type WatcherFactory } from './watch'
import { SettingsStore } from './settings'
import type { AnalysisQueue } from './queue'

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(cond: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await delay(20)
  }
  throw new Error('waitFor 逾時：條件未成立')
}

interface Rig {
  root: string
  watchDir: string
  library: Library
  settings: SettingsStore
  /** 匯入（enqueue）時刻，供下限斷言 */
  imports: Array<{ path: string; at: number }>
  queue: AnalysisQueue
  managers: WatchManager[]
}

const rigs: Rig[] = []

function makeRig(): Rig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-watch2-'))
  const watchDir = path.join(root, 'videos')
  fs.mkdirSync(watchDir)
  const imports: Rig['imports'] = []
  const queue = { enqueue: (p: string) => void imports.push({ path: p, at: Date.now() }) } as unknown as AnalysisQueue
  const rig: Rig = {
    root,
    watchDir,
    library: new Library(path.join(root, 'library.json')),
    settings: new SettingsStore(path.join(root, 'settings.json')),
    imports,
    queue,
    managers: []
  }
  rigs.push(rig)
  return rig
}

function manager(rig: Rig, extra: Partial<ConstructorParameters<typeof WatchManager>[0]> = {}): WatchManager {
  const m = new WatchManager({
    library: rig.library,
    queue: rig.queue,
    settings: rig.settings,
    stabilityMs: 600,
    pollMs: 25,
    retryMs: 80,
    ...extra
  })
  rig.managers.push(m)
  return m
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const rig of rigs.splice(0)) {
    for (const m of rig.managers) m.stop()
    try {
      fs.rmSync(rig.root, { recursive: true, force: true })
    } catch {
      // Windows 檔案鎖
    }
  }
})

/** 假 watcher：記錄 close，並可手動觸發 ready（模擬啟動很慢）。 */
function fakeFactory(): { factory: WatcherFactory; made: Array<{ dir: string; emitter: EventEmitter; close: ReturnType<typeof vi.fn>; opts: unknown }> } {
  const made: Array<{ dir: string; emitter: EventEmitter; close: ReturnType<typeof vi.fn>; opts: unknown }> = []
  const factory: WatcherFactory = (dir, _onAdd, opts) => {
    const emitter = new EventEmitter()
    const close = vi.fn(async () => {})
    ;(emitter as unknown as { close: unknown }).close = close
    made.push({ dir, emitter, close, opts })
    return emitter as unknown as FSWatcher
  }
  return { factory, made }
}

describe('validateWatchDir (shared validator)', () => {
  test('rejects relative, missing and non-directory paths with clear errors; accepts a real directory', () => {
    const rig = makeRig()
    expect(() => validateWatchDir('relative\\videos')).toThrow('絕對路徑')
    expect(() => validateWatchDir(undefined)).toThrow('絕對路徑')
    expect(() => validateWatchDir(path.join(rig.root, 'nope'))).toThrow('不存在')
    const file = path.join(rig.root, 'a.txt')
    fs.writeFileSync(file, 'x')
    expect(() => validateWatchDir(file)).toThrow('不是資料夾')
    expect(validateWatchDir(rig.watchDir + path.sep)).toBe(rig.watchDir)
  })

  test('start() and settings sync use the same validator: relative / file / missing entries never get a watcher', async () => {
    const rig = makeRig()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const file = path.join(rig.root, 'a.txt')
    fs.writeFileSync(file, 'x')
    rig.settings.set({ watchFolders: ['relative\\videos', file, path.join(rig.root, 'nope'), rig.watchDir] })
    const { factory, made } = fakeFactory()
    const wm = manager(rig, { createWatcher: factory })
    wm.start()
    for (const m of made) m.emitter.emit('ready')
    await wm.whenReady()
    expect(wm.activeDirs()).toEqual([rig.watchDir])
    expect(made.map((m) => m.dir)).toEqual([rig.watchDir])
  })
})

describe('path normalisation', () => {
  test('two spellings of one folder open exactly one watcher and one settings entry', async () => {
    const rig = makeRig()
    const { factory, made } = fakeFactory()
    const wm = manager(rig, { createWatcher: factory })
    const p1 = wm.add(rig.watchDir)
    made[0].emitter.emit('ready')
    await p1
    await wm.add(rig.watchDir + path.sep)
    if (process.platform === 'win32') await wm.add(rig.watchDir.toUpperCase())
    await wm.add(path.join(rig.watchDir, '..', 'videos'))
    expect(made).toHaveLength(1)
    expect(rig.settings.get().watchFolders).toEqual([rig.watchDir])
    expect(wm.activeDirs()).toEqual([rig.watchDir])
    expect(watchKey(rig.watchDir + path.sep)).toBe(watchKey(rig.watchDir))
    // 用另一種拼法移除也要移掉
    await wm.remove(rig.watchDir + path.sep)
    expect(rig.settings.get().watchFolders).toEqual([])
    expect(made[0].close).toHaveBeenCalled()
  })
})

describe('remove() argument check', () => {
  test('a non-string argument is ignored without touching settings', async () => {
    const rig = makeRig()
    rig.settings.set({ watchFolders: [rig.watchDir] })
    const wm = manager(rig, { createWatcher: fakeFactory().factory })
    await wm.remove(undefined as unknown as string)
    await wm.remove(42 as unknown as string)
    expect(rig.settings.get().watchFolders).toEqual([rig.watchDir])
  })
})

describe('stop() race', () => {
  test('a watcher still activating when stop() is called is closed immediately and never registered', async () => {
    const rig = makeRig()
    const { factory, made } = fakeFactory()
    const wm = manager(rig, { createWatcher: factory })
    const pending = wm.add(rig.watchDir) // watcher 尚未 ready
    expect(made).toHaveLength(1)
    wm.stop()
    expect(made[0].close).toHaveBeenCalledTimes(1) // stop() 關閉啟動中的 watcher
    made[0].emitter.emit('ready') // 之後才 ready：不得被登記
    await pending
    expect(wm.activeDirs()).toEqual([])
  })

  test('ready arriving after stop() (no explicit cancel path) still closes the watcher: stop->start generation', async () => {
    const rig = makeRig()
    const { factory, made } = fakeFactory()
    rig.settings.set({ watchFolders: [rig.watchDir] })
    const wm = manager(rig, { createWatcher: factory })
    wm.start()
    wm.stop()
    wm.start() // 重新啟動會開第二個 watcher
    expect(made).toHaveLength(2)
    made[0].emitter.emit('ready') // 舊世代
    made[1].emitter.emit('ready')
    await wm.whenReady()
    expect(made[0].close).toHaveBeenCalled()
    expect(made[1].close).not.toHaveBeenCalled()
    expect(wm.activeDirs()).toEqual([rig.watchDir])
  })
})

describe('missing / deleted folders', () => {
  test('a missing folder warns once (not per settings change) and is retried quietly until it appears', async () => {
    const rig = makeRig()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const later = path.join(rig.root, 'later')
    rig.settings.set({ watchFolders: [later] })
    const wm = manager(rig)
    wm.start()
    // 多次設定變更 + 多次重試週期
    rig.settings.set({ autoAnalyze: false })
    rig.settings.set({ autoAnalyze: true })
    await delay(350)
    expect(warn.mock.calls.filter((c) => String(c[0]).includes(later))).toHaveLength(1)
    expect(wm.activeDirs()).toEqual([])

    fs.mkdirSync(later)
    await waitFor(() => wm.activeDirs().length === 1)
    await wm.whenReady()
    fs.writeFileSync(path.join(later, 'a.mp4'), 'x')
    await waitFor(() => rig.imports.length === 1)
  }, 20000)

  test('a deleted-then-recreated folder gets a fresh watcher (the dead one is closed)', async () => {
    const rig = makeRig()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { factory, made } = fakeFactory()
    const wm = manager(rig, { createWatcher: factory })
    const p = wm.add(rig.watchDir)
    made[0].emitter.emit('ready')
    await p
    expect(wm.activeDirs()).toEqual([rig.watchDir])

    fs.rmSync(rig.watchDir, { recursive: true, force: true })
    await waitFor(() => wm.activeDirs().length === 0)
    expect(made[0].close).toHaveBeenCalled()
    expect(wm.missing()).toEqual([rig.watchDir])

    fs.mkdirSync(rig.watchDir)
    await waitFor(() => made.length === 2)
    made[1].emitter.emit('ready')
    await waitFor(() => wm.activeDirs().length === 1)
    expect(made[1].close).not.toHaveBeenCalled()
    expect(wm.missing()).toEqual([])
  }, 20000)
})

describe('stable-size window (lower bound)', () => {
  test('import happens no earlier than lastWrite + stabilityMs', async () => {
    const rig = makeRig()
    const wm = manager(rig)
    await wm.add(rig.watchDir)
    await wm.whenReady()
    const file = path.join(rig.watchDir, 'clip.mp4')
    fs.writeFileSync(file, Buffer.alloc(64, 1))
    await delay(150)
    fs.appendFileSync(file, Buffer.alloc(64, 2))
    const lastWrite = Date.now()
    await waitFor(() => rig.imports.length === 1)
    expect(rig.imports[0].at).toBeGreaterThanOrEqual(lastWrite + 600 - 40)
  }, 20000)

  test('continuous writes spanning more than one window => zero imports until writing stops', async () => {
    const rig = makeRig()
    const wm = manager(rig)
    await wm.add(rig.watchDir)
    await wm.whenReady()
    const file = path.join(rig.watchDir, 'long.mp4')
    const started = Date.now()
    let lastWrite = started
    fs.writeFileSync(file, Buffer.alloc(64, 1))
    while (Date.now() - started < 1700) {
      // 寫入橫跨 > 2 個穩定視窗，間隔小於視窗
      await delay(120)
      fs.appendFileSync(file, Buffer.alloc(64, 2))
      lastWrite = Date.now()
      expect(rig.imports).toHaveLength(0)
      expect(rig.library.getEntries()).toHaveLength(0)
    }
    await waitFor(() => rig.imports.length === 1)
    expect(rig.imports[0].at).toBeGreaterThanOrEqual(lastWrite + 600 - 40)
  }, 20000)

  test('default chain: constructor without options passes 2000 ms / 200 ms to the watcher factory', async () => {
    const rig = makeRig()
    const { factory, made } = fakeFactory()
    const wm = new WatchManager({ library: rig.library, queue: rig.queue, settings: rig.settings, createWatcher: factory })
    rig.managers.push(wm)
    const p = wm.add(rig.watchDir)
    made[0].emitter.emit('ready')
    await p
    expect(made[0].opts).toEqual({ stabilityMs: 2000, pollMs: 200 })
  })

  test('default chain end-to-end: with default options the import waits at least 2000 ms after the last write', async () => {
    const rig = makeRig()
    const wm = new WatchManager({ library: rig.library, queue: rig.queue, settings: rig.settings })
    rig.managers.push(wm)
    await wm.add(rig.watchDir)
    await wm.whenReady()
    const file = path.join(rig.watchDir, 'default.mp4')
    fs.writeFileSync(file, Buffer.alloc(64, 1))
    const lastWrite = Date.now()
    await delay(1500)
    expect(rig.imports).toHaveLength(0) // 視窗內
    await waitFor(() => rig.imports.length === 1, 8000)
    expect(rig.imports[0].at).toBeGreaterThanOrEqual(lastWrite + 2000 - 40)
  }, 20000)
})
