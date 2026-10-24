import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { AnalysisQueue } from './queue'
import { Library } from './library'
import { generateThumbnail } from './thumbnail'

vi.mock('./thumbnail', () => ({ generateThumbnail: vi.fn(async () => undefined) }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

let dir: string
let file: string
let library: Library
let queue: AnalysisQueue
let analysis: ReturnType<typeof deferred<any>>
let engine: { request: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }
const doc = { video: { duration: 1 }, events: [] }

beforeEach(() => {
  vi.mocked(generateThumbnail).mockReset().mockResolvedValue(undefined)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-remove-'))
  file = path.join(dir, 'source.mp4')
  fs.writeFileSync(file, 'fixture')
  library = new Library(path.join(dir, 'library.json'))
  library.add([file], 'recording')
  analysis = deferred()
  engine = { request: vi.fn(() => ({ id: 'analysis', promise: analysis.promise })), cancel: vi.fn() }
  queue = new AnalysisQueue(engine as any, library, { profileDir: dir, cacheDir: dir })
})

afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('idle and completed sources can be removed immediately', async () => {
  expect(await queue.withStoppedAnalysis([file], () => 'idle')).toBe('idle')
  queue.enqueue(file)
  analysis.resolve(doc)
  await vi.waitFor(() => expect(library.get(file)?.status).toBe('done'))
  expect(await queue.withStoppedAnalysis([file], () => library.remove(file))).toBe(true)
  expect(engine.cancel).not.toHaveBeenCalled()
})

test('waits for cancellation, drops a queued retry, and prevents re-enqueue until removal ends', async () => {
  queue.enqueue(file)
  queue.cancel(file)
  queue.enqueue(file)
  expect(queue.snapshot().queued).toEqual([file])
  const remove = vi.fn(() => {
    queue.enqueue(file)
    return library.remove(file)
  })
  const result = queue.withStoppedAnalysis([file], remove)
  await expect(queue.withStoppedAnalysis([file], remove)).rejects.toThrow('Removal already in progress')
  queue.enqueue(file)
  expect(remove).not.toHaveBeenCalled()
  expect(queue.snapshot().queued).toEqual([])
  analysis.reject(new Error('cancelled'))
  expect(await result).toBe(true)
  expect(engine.request).toHaveBeenCalledOnce()
  expect(queue.snapshot()).toEqual({ analyzing: null, queued: [] })
})

test('a successful engine response after cancellation does not start a thumbnail', async () => {
  queue.enqueue(file)
  const result = queue.withStoppedAnalysis([file], () => library.remove(file))
  analysis.resolve(doc)
  expect(await result).toBe(true)
  expect(generateThumbnail).not.toHaveBeenCalled()
})

test('waits for an already running thumbnail and does not mark the cancelled job done', async () => {
  const thumbnail = deferred<string | undefined>()
  vi.mocked(generateThumbnail).mockReturnValue(thumbnail.promise)
  queue.enqueue(file)
  analysis.resolve(doc)
  await vi.waitFor(() => expect(generateThumbnail).toHaveBeenCalledOnce())
  const remove = vi.fn(() => library.remove(file))
  const result = queue.withStoppedAnalysis([file], remove)
  await Promise.resolve()
  expect(remove).not.toHaveBeenCalled()
  expect(fs.existsSync(file)).toBe(true)
  thumbnail.resolve(undefined)
  expect(await result).toBe(true)
  expect(library.get(file)).toBeUndefined()
})

test('batch cancellation removes queued sources before the current job can start them', async () => {
  const second = path.join(dir, 'second.mp4')
  fs.writeFileSync(second, 'fixture')
  library.add([second], 'recording')
  queue.enqueue(file)
  queue.enqueue(second)
  const result = queue.withStoppedAnalysis([file, second], () => library.removeMany([file, second]))
  analysis.reject(new Error('cancelled'))
  expect(await result).toEqual({ removed: [file, second], failed: [] })
  expect(engine.request).toHaveBeenCalledOnce()
})

test('a stuck job times out without deleting the source or library entry', async () => {
  vi.useFakeTimers()
  queue.enqueue(file)
  const remove = vi.fn(() => library.remove(file))
  const result = queue.withStoppedAnalysis([file], remove)
  const rejected = expect(result).rejects.toThrow('Analysis did not stop in time')
  await vi.advanceTimersByTimeAsync(10_000)
  await rejected
  expect(remove).not.toHaveBeenCalled()
  expect(fs.existsSync(file)).toBe(true)
  expect(library.get(file)).toBeDefined()
  analysis.reject(new Error('cancelled'))
  await Promise.resolve()
})

test('failed removal releases the enqueue guard and retains the source', async () => {
  await expect(queue.withStoppedAnalysis([file], () => { throw new Error('EPERM') })).rejects.toThrow('EPERM')
  expect(library.get(file)).toBeDefined()
  expect(fs.existsSync(file)).toBe(true)
  queue.enqueue(file)
  expect(engine.request).toHaveBeenCalledOnce()
  analysis.reject(new Error('cleanup'))
  await Promise.resolve()
})
