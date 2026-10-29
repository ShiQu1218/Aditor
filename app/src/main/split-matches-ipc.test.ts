// Wiring test for library:splitMatches: input validation, one split at a time, and import + forced queueing of every part.
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
const split = vi.fn()
vi.mock('./split-matches', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./split-matches')>()),
  splitMatches: (...args: unknown[]) => split(...args)
}))
const loadCache = vi.fn()
vi.mock('./reanalysis', () => ({ loadCacheWithEdits: (...args: unknown[]) => loadCache(...args), saveCacheEdits: () => true }))

import { registerIpcHandlers } from './ipc-handlers'
import { Library } from './library'

describe('library:splitMatches', () => {
  let dir: string
  let library: Library
  let enqueue: ReturnType<typeof vi.fn>
  let cancelExport: () => Promise<void>

  beforeEach(() => {
    handlers.clear()
    split.mockReset()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-split-ipc-'))
    library = new Library(path.join(dir, 'library.json'))
    enqueue = vi.fn()
    const queueMock = { on: () => {}, payload: () => ({}), enqueue } as any
    cancelExport = registerIpcHandlers(library, queueMock, () => []).cancelExport
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const invoke = (videoPath: unknown) => handlers.get('library:splitMatches')!({}, videoPath)
  /** A library entry for a file on disk with the given status and game. */
  const entry = (name: string, status: 'done' | 'pending' = 'done', game: 'apex' | 'valorant' = 'apex'): string => {
    const file = path.join(dir, name)
    fs.writeFileSync(file, 'video')
    library.add([file], 'external', game)
    library.update(file, { status })
    return file
  }

  test('rejects unknown and unanalyzed videos without running the split', async () => {
    expect(await invoke(path.join(dir, 'missing.mp4'))).toEqual({ ok: false, reason: 'failed' })
    expect(await invoke(42)).toEqual({ ok: false, reason: 'failed' })
    expect(await invoke(entry('pending.mp4', 'pending'))).toEqual({ ok: false, reason: 'failed' })
    expect(split).not.toHaveBeenCalled()
  })

  test('detects VALORANT matches from the cached rounds instead of the engine', async () => {
    const video = entry('valo.mp4', 'done', 'valorant')
    loadCache.mockReturnValue({ video: { duration: 900 }, rounds: [
      { start: 10, end: 100, winner: 'ally', ally: 1, enemy: 0 },
      { start: 400, end: 500, winner: 'enemy', ally: 0, enemy: 1 }
    ] })
    split.mockResolvedValue({ ok: false, reason: 'single' })
    await invoke(video)
    const run = vi.fn()
    expect(await split.mock.calls[0][1].detect(run, new AbortController().signal)).toEqual([
      { start: 10, end: 130 }, { start: 400, end: 530 }
    ])
    expect(loadCache.mock.calls[0][0]).toBe(video)
    expect(run).not.toHaveBeenCalled()
  })

  test('imports and force-queues every part, including one already in the library', async () => {
    const source = entry('stream.mp4')
    const parts = [path.join(dir, 'stream_match01.mp4'), path.join(dir, 'stream_match02.mp4')]
    library.add([parts[1]], 'external', 'apex')
    split.mockResolvedValue({ ok: true, files: parts })
    expect(await invoke(source)).toEqual({ ok: true, files: parts })
    expect(library.get(parts[0])?.game).toBe('apex')
    expect(enqueue.mock.calls).toEqual([[parts[0], true], [parts[1], true]])
  })

  test('runs one split at a time and stops it when the window closes', async () => {
    const first = entry('a.mp4')
    let signal: AbortSignal | undefined
    split.mockImplementation((_video: string, _deps: unknown, s: AbortSignal) => {
      signal = s
      return new Promise((resolve) => s.addEventListener('abort', () => resolve({ ok: false, reason: 'cancelled' })))
    })
    const running = invoke(first)
    expect(await invoke(entry('b.mp4'))).toEqual({ ok: false, reason: 'busy' })
    await cancelExport()
    expect(signal?.aborted).toBe(true)
    expect(await running).toEqual({ ok: false, reason: 'cancelled' })
    expect(enqueue).not.toHaveBeenCalled()
    // A finished split frees the slot for the next one.
    split.mockResolvedValue({ ok: false, reason: 'single' })
    expect(await invoke(first)).toEqual({ ok: false, reason: 'single' })
  })

  test('frees the slot when the split throws', async () => {
    const file = entry('c.mp4')
    split.mockRejectedValueOnce(new Error('boom'))
    await expect(invoke(file)).rejects.toThrow('boom')
    split.mockResolvedValue({ ok: false, reason: 'none' })
    expect(await invoke(file)).toEqual({ ok: false, reason: 'none' })
  })
})
