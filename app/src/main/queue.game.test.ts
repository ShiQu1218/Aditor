import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { AnalysisQueue } from './queue'
import { Library } from './library'
import type { EngineClient } from './engine'
import { generateThumbnail } from './thumbnail'
import * as reanalysis from './reanalysis'

vi.mock('./thumbnail', () => ({ generateThumbnail: vi.fn(async () => undefined) }))

let dir: string
let library: Library
const first = 'D:/Videos/first.mp4'
const second = 'D:/Videos/second.mp4'
const doc = { video: { duration: 10 }, events: [] }

function rig(gameRunning = false) {
  const runs: Array<{ resolve: (doc: unknown) => void; reject: (err: Error) => void }> = []
  const engine = {
    request: vi.fn(() => {
      const promise = new Promise((resolve, reject) => runs.push({ resolve, reject }))
      return { id: String(runs.length), promise }
    }),
    cancel: vi.fn()
  }
  const queue = new AnalysisQueue(engine as unknown as EngineClient, library, { profileDir: dir, cacheDir: dir, gameRunning })
  return { queue, engine, runs }
}

beforeEach(() => {
  vi.mocked(generateThumbnail).mockReset().mockResolvedValue(undefined)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-game-queue-'))
  library = new Library(path.join(dir, 'library.json'))
  library.add([first, second])
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('blocks every enqueued item until the game exits', async () => {
  const { queue, engine, runs } = rig(true)
  queue.enqueue(first, true)
  queue.enqueue(second)
  expect(engine.request).not.toHaveBeenCalled()
  expect(queue.payload()).toEqual({ queue: { analyzing: null, queued: [first, second], waitingForGame: true }, current: null })
  queue.setGameRunning(false)
  expect(engine.request).toHaveBeenCalledOnce()
  runs[0].resolve(doc)
  await vi.waitFor(() => expect(engine.request).toHaveBeenCalledTimes(2))
  runs[1].resolve(doc)
  await vi.waitFor(() => expect(library.get(second)?.status).toBe('done'))
})

test('cancels an active engine and retries it first with force preserved after the game exits', async () => {
  const { queue, engine, runs } = rig()
  queue.enqueue(first, true)
  queue.enqueue(second)
  queue.setGameRunning(true)
  queue.setGameRunning(true)
  expect(engine.cancel).toHaveBeenCalledExactlyOnceWith('1')
  expect(queue.snapshot()).toEqual({ analyzing: null, queued: [first, second], waitingForGame: true })
  expect(library.get(first)).toMatchObject({ status: 'pending', progress: 0 })
  // Exit before cancellation is acknowledged must not overlap engine requests.
  queue.setGameRunning(false)
  expect(engine.request).toHaveBeenCalledOnce()
  runs[0].reject(new Error('cancelled'))
  await vi.waitFor(() => expect(engine.request).toHaveBeenCalledTimes(2))
  expect(engine.request).toHaveBeenNthCalledWith(2, 'analyze', expect.objectContaining({ path: first, force: true }), expect.any(Function))
  expect(library.get(first)?.error).toBeUndefined()
  runs[1].resolve(doc)
  await vi.waitFor(() => expect(engine.request).toHaveBeenCalledTimes(3))
  expect(engine.request).toHaveBeenNthCalledWith(3, 'analyze', expect.objectContaining({ path: second }), expect.any(Function))
  runs[2].resolve(doc)
  await vi.waitFor(() => expect(library.get(second)?.status).toBe('done'))
})

test('preserves clips when the engine completes a run the game already interrupted', async () => {
  const { queue, engine, runs } = rig()
  const preserve = vi.spyOn(reanalysis, 'preserveClipsAfterReanalysis')
  queue.enqueue(first)
  queue.setGameRunning(true)
  expect(engine.cancel).toHaveBeenCalledOnce()
  // The engine finished and replaced the cache before it saw the cancellation.
  runs[0].resolve(doc)
  await vi.waitFor(() => expect(queue.activeCachePath(first)).toBeUndefined())
  expect(preserve).toHaveBeenCalledOnce()
  expect(queue.snapshot()).toEqual({ analyzing: null, queued: [first], waitingForGame: true })
  expect(library.get(first)).toMatchObject({ status: 'pending' })
})

test('finishes preserving clips when the game starts after the engine resolves', async () => {
  const { queue, engine, runs } = rig()
  const preserve = vi.spyOn(reanalysis, 'preserveClipsAfterReanalysis')
  let finishThumbnail!: (thumb: string) => void
  vi.mocked(generateThumbnail).mockReturnValueOnce(new Promise((resolve) => { finishThumbnail = resolve }))
  queue.enqueue(first, true)
  runs[0].resolve(doc)
  await vi.waitFor(() => expect(generateThumbnail).toHaveBeenCalledOnce())
  queue.setGameRunning(true)
  finishThumbnail('thumbnail.jpg')
  await vi.waitFor(() => expect(queue.snapshot().analyzing).toBeNull())
  expect(library.get(first)).toMatchObject({ status: 'done', thumb: 'thumbnail.jpg' })
  expect(preserve).toHaveBeenCalledOnce()
  expect(queue.snapshot().queued).toEqual([])
  expect(engine.cancel).not.toHaveBeenCalled()
  queue.setGameRunning(false)
  expect(engine.request).toHaveBeenCalledOnce()
})

test.each([false, true])('user cancellation drops a deferred item, acknowledged=%s', async (acknowledged) => {
  const { queue, engine, runs } = rig()
  queue.enqueue(first)
  queue.setGameRunning(true)
  if (acknowledged) {
    runs[0].reject(new Error('cancelled'))
    await Promise.resolve()
  }
  queue.cancel(first)
  expect(queue.snapshot().queued).toEqual([])
  if (!acknowledged) runs[0].resolve(doc)
  await Promise.resolve()
  queue.setGameRunning(false)
  expect(engine.request).toHaveBeenCalledOnce()
  expect(library.get(first)).toMatchObject({ status: 'pending', progress: 0 })
  expect(library.get(first)?.error).toBeUndefined()
})

test.each([false, true])('removal drops a deferred item and waits for the engine, acknowledged=%s', async (acknowledged) => {
  const { queue, engine, runs } = rig()
  queue.enqueue(first)
  queue.setGameRunning(true)
  if (acknowledged) {
    runs[0].reject(new Error('cancelled'))
    await Promise.resolve()
  }
  const remove = vi.fn(() => library.remove(first))
  const result = queue.withStoppedAnalysis([first], remove)
  if (!acknowledged) {
    expect(remove).not.toHaveBeenCalled()
    runs[0].reject(new Error('cancelled'))
  }
  expect(await result).toBe(true)
  queue.setGameRunning(false)
  expect(queue.snapshot().queued).toEqual([])
  expect(library.get(first)).toBeUndefined()
  expect(engine.request).toHaveBeenCalledOnce()
})
