import { afterEach, describe, expect, test } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Library } from './library'
import { WatchManager } from './watch'
import { SettingsStore } from './settings'
import type { AnalysisQueue } from './queue'

/** Shorter stability window for tests (production default is 2000 ms). */
const STABILITY_MS = 600

interface Rig {
  root: string
  watchDir: string
  library: Library
  settings: SettingsStore
  enqueued: string[]
  queue: AnalysisQueue
  managers: WatchManager[]
}

const rigs: Rig[] = []

function makeRig(options: { autoAnalyze?: boolean } = {}): Rig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-watch-'))
  const watchDir = path.join(root, 'videos')
  fs.mkdirSync(watchDir)
  const library = new Library(path.join(root, 'library.json'))
  const enqueued: string[] = []
  const queue = {
    enqueue: (p: string) => {
      enqueued.push(p)
    }
  } as unknown as AnalysisQueue
  const settings = new SettingsStore(path.join(root, 'settings.json'))
  if (options.autoAnalyze === false) {
    settings.set({ autoAnalyze: false })
  }
  const rig: Rig = { root, watchDir, library, settings, enqueued, queue, managers: [] }
  rig.managers.push(makeManager(rig))
  rigs.push(rig)
  return rig
}

function makeManager(rig: Rig): WatchManager {
  return new WatchManager({
    library: rig.library,
    queue: rig.queue,
    settings: rig.settings,
    stabilityMs: STABILITY_MS,
    pollMs: 25
  })
}

afterEach(() => {
  for (const rig of rigs.splice(0)) {
    for (const m of rig.managers) {
      m.stop()
    }
    try {
      fs.rmSync(rig.root, { recursive: true, force: true })
    } catch {
      // Ignore cleanup failures (Windows file lock).
    }
  }
})

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(cond: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await delay(25)
  }
  throw new Error('waitFor 逾時：條件未成立')
}

describe('WatchManager', () => {
  test('add() validates the path: absolute, exists, is a directory', async () => {
    const rig = makeRig()

    await expect(rig.managers[0].add('relative\\videos')).rejects.toThrow('絕對路徑')
    await expect(rig.managers[0].add(path.join(rig.root, 'not-there'))).rejects.toThrow('不存在')

    const file = path.join(rig.root, 'note.txt')
    fs.writeFileSync(file, 'x')
    await expect(rig.managers[0].add(file)).rejects.toThrow('不是資料夾')

    // A failed add must not write to settings.
    expect(rig.settings.get().watchFolders).toEqual([])
  })

  test('WatchManager adds new video files only after size is stable', async () => {
    const rig = makeRig()
    const wm = rig.managers[0]
    await wm.add(rig.watchDir)
    await wm.whenReady()

    const file = path.join(rig.watchDir, 'clip.mp4')
    fs.writeFileSync(file, Buffer.alloc(64, 1))
    await delay(120)
    fs.appendFileSync(file, Buffer.alloc(64, 2))
    await delay(120)
    fs.appendFileSync(file, Buffer.alloc(64, 3))

    // The last write just occurred: the stability window has not elapsed, so do not import yet.
    expect(rig.library.getEntries()).toHaveLength(0)

    await waitFor(() => rig.library.getEntries().length === 1)
    expect(rig.library.getEntries()[0].path).toBe(file)
    await waitFor(() => rig.enqueued.length === 1)
    expect(rig.enqueued[0]).toBe(file)
  }, 20000)

  test('WatchManager ignores non-video files and temp extensions', async () => {
    const rig = makeRig()
    const wm = rig.managers[0]
    await wm.add(rig.watchDir)
    await wm.whenReady()

    fs.writeFileSync(path.join(rig.watchDir, 'notes.txt'), 'x')
    fs.writeFileSync(path.join(rig.watchDir, 'clip.mp4.part'), 'x')
    fs.writeFileSync(path.join(rig.watchDir, 'video.crdownload'), 'x')
    fs.writeFileSync(path.join(rig.watchDir, 'real.mkv'), 'x')
    fs.writeFileSync(path.join(rig.watchDir, 'shot.MP4'), 'x')

    await waitFor(() => rig.library.getEntries().length === 2)
    const names = rig.library
      .getEntries()
      .map((e) => path.basename(e.path))
      .sort()
    expect(names).toEqual(['real.mkv', 'shot.MP4'])
  }, 20000)

  test('WatchManager respects autoAnalyze=false (imports but does not enqueue)', async () => {
    const rig = makeRig({ autoAnalyze: false })
    const wm = rig.managers[0]
    await wm.add(rig.watchDir)
    await wm.whenReady()

    fs.writeFileSync(path.join(rig.watchDir, 'clip.mp4'), 'x')
    await waitFor(() => rig.library.getEntries().length === 1)
    await delay(300)
    expect(rig.enqueued).toHaveLength(0)
  }, 20000)

  test('WatchManager survives a deleted watch folder', async () => {
    const rig = makeRig()
    const wm = rig.managers[0]
    await wm.add(rig.watchDir)
    await wm.whenReady()

    fs.rmSync(rig.watchDir, { recursive: true, force: true })
    await delay(300)

    // Do not throw; keep the folder in the list and mark it missing.
    expect(wm.list()).toContain(rig.watchDir)
    expect(wm.missing()).toContain(rig.watchDir)
    expect(rig.settings.get().watchFolders).toContain(rig.watchDir)
  }, 20000)

  test('add/remove persist through SettingsStore and restore on start()', async () => {
    const rig = makeRig()
    const wm = rig.managers[0]

    await wm.add(rig.watchDir)
    expect(rig.settings.get().watchFolders).toEqual([rig.watchDir])

    await wm.remove(rig.watchDir)
    expect(rig.settings.get().watchFolders).toEqual([])
    expect(wm.list()).toEqual([])

    await wm.add(rig.watchDir)
    wm.stop()

    // A new manager restores watching from settings alone.
    const wm2 = makeManager(rig)
    rig.managers.push(wm2)
    wm2.start()
    await wm2.whenReady()
    expect(wm2.list()).toEqual([rig.watchDir])

    fs.writeFileSync(path.join(rig.watchDir, 'restored.mp4'), 'x')
    await waitFor(() => rig.library.getEntries().length === 1)
    await waitFor(() => rig.enqueued.length === 1)
  }, 20000)
})
