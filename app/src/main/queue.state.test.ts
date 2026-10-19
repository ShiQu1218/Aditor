import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { AnalysisQueue } from './queue'
import { Library } from './library'
import type { EngineClient } from './engine'
import { cacheFilePath, saveCacheDoc } from './cache-io'

const V1 = path.join(os.tmpdir(), 'aditor-q', 'v1.mp4')
const V2 = path.join(os.tmpdir(), 'aditor-q', 'v2.mp4')
const V3 = path.join(os.tmpdir(), 'aditor-q', 'v3.mp4')

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Pending {
  path: string
  id: string
  resolve: (doc: unknown) => void
  reject: (err: Error) => void
  onProgress?: (p: { t: number; duration: number }) => void
  cancelled: boolean
}

/** 可手動完成／取消的假引擎（取消＝以 Cancelled 拒絕，與真引擎一致） */
function manualEngine(): { engine: EngineClient; pending: Pending[] } {
  const pending: Pending[] = []
  let n = 0
  const engine = {
    request: (_cmd: string, args: { path: string }, onProgress?: Pending['onProgress']) => {
      const id = `req_${++n}`
      let resolve!: Pending['resolve']
      let reject!: Pending['reject']
      const promise = new Promise((res, rej) => {
        resolve = res
        reject = rej
      })
      pending.push({ path: args.path, id, resolve, reject, onProgress, cancelled: false })
      return { id, promise }
    },
    cancel: (id: string) => {
      const p = pending.find((x) => x.id === id)
      if (p) {
        p.cancelled = true
        p.reject(new Error('cancelled'))
      }
    }
  } as unknown as EngineClient
  return { engine, pending }
}

describe('AnalysisQueue real queue state', () => {
  let lib: Library
  let cacheDir: string
  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-qcache-'))
    lib = new Library(path.join(cacheDir, 'library.json'))
  })
  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true })
  })

  const mkQueue = (engine: EngineClient): AnalysisQueue => new AnalysisQueue(engine, lib, { profileDir: '/p', cacheDir })

  it('snapshot() exposes the truly queued set: imported-but-not-enqueued items are NOT queued', async () => {
    const { engine, pending } = manualEngine()
    lib.add([V1, V2, V3])
    const q = mkQueue(engine)
    // 匯入但未排隊（autoAnalyze=false／手動匯入）：status 是 pending，但不在佇列
    expect(q.snapshot()).toEqual({ analyzing: null, queued: [] })

    q.enqueue(V1)
    q.enqueue(V2)
    expect(q.snapshot()).toEqual({ analyzing: V1, queued: [V2] })
    expect(lib.getEntries().find((e) => e.path === V3)?.status).toBe('pending') // 仍只是 pending

    pending[0].resolve({ video: { duration: 10 }, events: [] })
    await tick(30)
    expect(q.snapshot()).toEqual({ analyzing: V2, queued: [] })
    pending[1].resolve({ video: { duration: 10 }, events: [] })
    await tick(30)
    expect(q.snapshot()).toEqual({ analyzing: null, queued: [] })
  })

  it('records analyzingSince when analysis starts and clears it afterwards; payload() carries progress', async () => {
    const { engine, pending } = manualEngine()
    lib.add([V1, V2])
    const q = mkQueue(engine)
    const before = Date.now()
    q.enqueue(V1)
    q.enqueue(V2)
    const e1 = lib.get(V1)!
    expect(e1.status).toBe('analyzing')
    expect(e1.analyzingSince).toBeGreaterThanOrEqual(before)
    expect(lib.get(V2)?.analyzingSince).toBeUndefined() // 排隊中尚未開始

    pending[0].onProgress?.({ t: 25, duration: 100 })
    expect(q.payload()).toEqual({
      queue: { analyzing: V1, queued: [V2] },
      current: { path: V1, progress: 0.25, analyzingSince: e1.analyzingSince }
    })

    pending[0].resolve({ video: { duration: 10 }, events: [] })
    await tick(30)
    expect(lib.get(V1)?.analyzingSince).toBeUndefined()
    expect(lib.get(V2)?.analyzingSince).toBeGreaterThanOrEqual(before)
    expect(q.payload().current?.path).toBe(V2)
  })

  it('cancel() of a queued item removes it from the queue and leaves it visibly idle (pending, not queued)', () => {
    const { engine } = manualEngine()
    lib.add([V1, V2])
    const q = mkQueue(engine)
    q.enqueue(V1)
    q.enqueue(V2)
    q.cancel(V2)
    expect(q.snapshot()).toEqual({ analyzing: V1, queued: [] })
    expect(lib.get(V2)).toMatchObject({ status: 'pending', progress: 0 })
  })

  it('cancel() of the running item: idle immediately, never turns into an error, next item starts after the engine stops', async () => {
    const { engine, pending } = manualEngine()
    lib.add([V1, V2])
    const q = mkQueue(engine)
    q.enqueue(V1)
    q.enqueue(V2)
    q.cancel(V1)
    // 立刻可見：V1 不在佇列、閒置；V2 等引擎真的停下才開始
    expect(q.snapshot().analyzing).toBeNull()
    expect(q.snapshot().queued).toEqual([V2])
    await tick(30)
    expect(lib.get(V1)).toMatchObject({ status: 'pending', progress: 0 })
    expect(lib.get(V1)?.error).toBeUndefined()
    expect(lib.get(V1)?.analyzingSince).toBeUndefined()
    expect(q.snapshot()).toEqual({ analyzing: V2, queued: [] })
    expect(pending.map((p) => p.path)).toEqual([V1, V2])
  })

  it('a cancelled item can be re-enqueued right away (retry after cancel)', async () => {
    const { engine, pending } = manualEngine()
    lib.add([V1])
    const q = mkQueue(engine)
    q.enqueue(V1)
    q.cancel(V1)
    q.enqueue(V1)
    expect(q.snapshot()).toEqual({ analyzing: null, queued: [V1] })
    await tick(30)
    expect(q.snapshot()).toEqual({ analyzing: V1, queued: [] })
    expect(pending).toHaveLength(2)
  })

  it('a genuine failure still ends in error and is not queued', async () => {
    const { engine, pending } = manualEngine()
    lib.add([V1])
    const q = mkQueue(engine)
    q.enqueue(V1)
    pending[0].reject(new Error('probe_failed'))
    await tick(30)
    expect(lib.get(V1)).toMatchObject({ status: 'error', error: 'probe_failed' })
    expect(lib.get(V1)?.analyzingSince).toBeUndefined()
    expect(q.snapshot()).toEqual({ analyzing: null, queued: [] })
  })
})

describe('AnalysisQueue + cache clip preservation (Fix F)', () => {
  let lib: Library
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-qf-'))
    lib = new Library(path.join(dir, 'library.json'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const baseDoc = (videoPath: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    version: 1,
    video: { path: videoPath, size: 100, mtime: 1, duration: 100, width: 1920, height: 1080, codec: 'h264', start_time: 0 },
    profile: 'zh-TW',
    analysis: { status: 'done', progress_t: 100, engine_version: '0.1.0', templates_version: 'zh-TW@1', h_scale: 1 },
    events: [],
    spectating: [],
    clips: [],
    keyframes: [],
    cache_path: cacheFilePath(videoPath, dir),
    ...over
  })
  const clip = (id: string, start: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id,
    start,
    end: start + 10,
    origin: 'ai',
    event_ids: [],
    status: 'accepted',
    ...over
  })

  /** 模擬引擎：寫入新快取（只留手動片段）並回傳該文件 */
  const engineWriting = (make: (videoPath: string) => Record<string, unknown>): EngineClient =>
    ({
      request: (_cmd: string, args: { path: string }) => ({
        id: 'r',
        promise: (async () => {
          const doc = make(args.path)
          saveCacheDoc(doc as { cache_path: string })
          return doc
        })()
      }),
      cancel: () => {}
    }) as unknown as EngineClient

  const readCache = (videoPath: string): Record<string, any> =>
    JSON.parse(fs.readFileSync(cacheFilePath(videoPath, dir), 'utf-8'))

  it('re-analysis: accepted ai kept as stale, manual kept, suggested/skipped dropped, app.suggestionsPending set', async () => {
    saveCacheDoc(
      baseDoc(V1, {
        clips: [
          clip('a1', 100),
          clip('s1', 200, { status: 'suggested' }),
          clip('k1', 300, { status: 'skipped' }),
          clip('m1', 400, { origin: 'manual' })
        ]
      }) as { cache_path: string }
    )
    lib.add([V1])
    // 引擎重新分析（影片 mtime 變了）：文件只剩手動片段
    const engine = engineWriting((p) =>
      baseDoc(p, {
        video: { path: p, size: 100, mtime: 2, duration: 100, width: 1920, height: 1080, codec: 'h264', start_time: 0 },
        clips: [clip('m1', 400, { origin: 'manual' })]
      })
    )
    const q = new AnalysisQueue(engine, lib, { profileDir: '/p', cacheDir: dir })
    q.enqueue(V1)
    await tick(60)
    const doc = readCache(V1)
    expect(doc.clips.map((c: any) => [c.id, c.status, c.stale ?? false])).toEqual([
      ['a1', 'accepted', true],
      ['m1', 'accepted', false]
    ])
    expect(doc.app).toEqual({ suggestionsPending: true })
    expect(doc.analysis.status).toBe('done')
    expect(lib.get(V1)?.status).toBe('done')
  })

  it('first analysis (no prior cache) writes no flag and leaves the engine doc untouched', async () => {
    lib.add([V1])
    const engine = engineWriting((p) => baseDoc(p))
    const q = new AnalysisQueue(engine, lib, { profileDir: '/p', cacheDir: dir })
    q.enqueue(V1)
    await tick(60)
    expect(readCache(V1).app).toBeUndefined()
  })

  it('cache hit (engine returns the same cached doc) is not treated as a re-analysis', async () => {
    const prior = baseDoc(V1, { clips: [clip('a1', 100), clip('s1', 200, { status: 'suggested' })] })
    saveCacheDoc(prior as { cache_path: string })
    lib.add([V1])
    const engine = { request: () => ({ id: 'r', promise: Promise.resolve(readCache(V1)) }), cancel: () => {} } as unknown as EngineClient
    const q = new AnalysisQueue(engine, lib, { profileDir: '/p', cacheDir: dir })
    q.enqueue(V1)
    await tick(60)
    const doc = readCache(V1)
    expect(doc.app).toBeUndefined()
    expect(doc.clips.map((c: any) => [c.id, c.status, c.stale ?? false])).toEqual([
      ['a1', 'accepted', false],
      ['s1', 'suggested', false]
    ])
  })

  it('failed analysis leaves the old cache byte-for-byte untouched', async () => {
    saveCacheDoc(baseDoc(V1, { clips: [clip('a1', 100)] }) as { cache_path: string })
    const before = fs.readFileSync(cacheFilePath(V1, dir), 'utf-8')
    lib.add([V1])
    const engine = { request: () => ({ id: 'r', promise: Promise.reject(new Error('probe_failed')) }), cancel: () => {} } as unknown as EngineClient
    const q = new AnalysisQueue(engine, lib, { profileDir: '/p', cacheDir: dir })
    q.enqueue(V1)
    await tick(60)
    expect(lib.get(V1)?.status).toBe('error')
    expect(fs.readFileSync(cacheFilePath(V1, dir), 'utf-8')).toBe(before)
  })

  it('a prior partial (interrupted first analysis) is not a re-analysis: no flag', async () => {
    saveCacheDoc(baseDoc(V1, { analysis: { status: 'partial', progress_t: 10, engine_version: '0.1.0', templates_version: 'zh-TW@1', h_scale: 1 } }) as { cache_path: string })
    lib.add([V1])
    const engine = engineWriting((p) => baseDoc(p))
    const q = new AnalysisQueue(engine, lib, { profileDir: '/p', cacheDir: dir })
    q.enqueue(V1)
    await tick(60)
    expect(readCache(V1).app).toBeUndefined()
  })
})
