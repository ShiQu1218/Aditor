import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { AnalysisQueue } from './queue'
import { Library } from './library'
import type { EngineClient } from './engine'
import { cacheFilePath, saveCacheDoc } from './cache-io'
import { clipsBackupPath, readClipsBackup } from './reanalysis'

const V1 = path.join(os.tmpdir(), 'apexhl-ra', 'v1.mp4')
const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('clips backup across cancelled re-analysis (F2)', () => {
  let dir: string
  let lib: Library
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apexhl-ra-'))
    lib = new Library(path.join(dir, 'library.json'))
    lib.add([V1])
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const cache = (): string => cacheFilePath(V1, dir)
  const backup = (): string => clipsBackupPath(cache())
  const readDoc = (): Record<string, any> => JSON.parse(fs.readFileSync(cache(), 'utf-8'))
  const analysis = (status: string): Record<string, unknown> => ({
    status,
    progress_t: status === 'done' ? 100 : 10,
    engine_version: '0.1.0',
    templates_version: 'zh-TW@1',
    h_scale: 1
  })
  const video = (mtime: number): Record<string, unknown> => ({
    path: V1,
    size: 100,
    mtime,
    duration: 100,
    width: 1920,
    height: 1080,
    codec: 'h264',
    start_time: 0
  })
  const doc = (status: string, mtime: number, clips: unknown[]): Record<string, unknown> => ({
    version: 1,
    video: video(mtime),
    profile: 'zh-TW',
    analysis: analysis(status),
    events: [],
    spectating: [],
    clips,
    keyframes: [],
    cache_path: cache()
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
  const manual = clip('m1', 400, { origin: 'manual' })

  /** 引擎行為：'done' ＝ 寫入完成文件（只剩手動片段）；'fail' ＝ 直接失敗 */
  function engine(mode: 'done' | 'fail', mtime = 2): EngineClient {
    return {
      request: () => {
        if (mode === 'fail') return { id: 'r', promise: Promise.reject(new Error('probe_failed')) }
        if (mode === 'done') {
          const d = doc('done', mtime, [manual])
          saveCacheDoc(d as { cache_path: string })
          return { id: 'r', promise: Promise.resolve(d) }
        }
        throw new Error('unreachable')
      },
      cancel: () => {}
    } as unknown as EngineClient
  }

  /** 取消用的引擎：先把快取覆寫成只剩手動片段的 partial（與真引擎一致），cancel(id) 以 Cancelled 拒絕 */
  function cancellableEngine(): EngineClient {
    let rej!: (e: Error) => void
    return {
      request: () => {
        saveCacheDoc(doc('partial', 2, [manual]) as { cache_path: string })
        const promise = new Promise((_res, r) => (rej = r))
        return { id: 'r', promise }
      },
      cancel: () => rej(new Error('cancelled'))
    } as unknown as EngineClient
  }

  const seedDone = (): void => {
    saveCacheDoc(
      doc('done', 1, [clip('a1', 100), clip('s1', 200, { status: 'suggested' }), clip('k1', 300, { status: 'skipped' }), manual]) as {
        cache_path: string
      }
    )
  }
  const summary = (clips: any[]): unknown[] => clips.map((c) => [c.id, c.status, c.stale ?? false])

  it('before a re-analysis of a done cache, a sidecar backup of its clips is written next to the cache', async () => {
    seedDone()
    const q = new AnalysisQueue(cancellableEngine(), lib, { profileDir: '/p', cacheDir: dir })
    q.enqueue(V1)
    await tick()
    expect(path.dirname(backup())).toBe(path.dirname(cache()))
    expect(backup().endsWith('.clips.json')).toBe(true)
    expect(readClipsBackup(cache())?.map((c) => c.id)).toEqual(['a1', 's1', 'k1', 'm1'])
    q.cancel(V1)
    await tick()
  })

  it('cancel keeps the backup (even though the engine overwrote the doc); a later successful run restores accepted(stale)+flag and removes the backup', async () => {
    seedDone()
    const q1 = new AnalysisQueue(cancellableEngine(), lib, { profileDir: '/p', cacheDir: dir })
    q1.enqueue(V1)
    await tick()
    q1.cancel(V1)
    await tick()
    // 引擎寫的 partial 只有手動片段；備份仍保有已接受的 AI 片段
    expect(readDoc().analysis.status).toBe('partial')
    expect(readDoc().clips.map((c: any) => c.id)).toEqual(['m1'])
    expect(readClipsBackup(cache())?.some((c) => c.id === 'a1')).toBe(true)

    // 之後的續跑／重跑：快取是 partial，仍要使用既有備份
    const q2 = new AnalysisQueue(engine('done'), lib, { profileDir: '/p', cacheDir: dir })
    q2.enqueue(V1)
    await tick(60)
    const out = readDoc()
    expect(summary(out.clips)).toEqual([
      ['a1', 'accepted', true],
      ['m1', 'accepted', false]
    ])
    expect(out.app).toEqual({ suggestionsPending: true })
    expect(fs.existsSync(backup())).toBe(false)
  })

  it('a second cancel keeps using the first backup (partial doc never replaces it)', async () => {
    seedDone()
    for (let i = 0; i < 2; i++) {
      const q = new AnalysisQueue(cancellableEngine(), lib, { profileDir: '/p', cacheDir: dir })
      q.enqueue(V1)
      await tick()
      q.cancel(V1)
      await tick()
    }
    expect(readClipsBackup(cache())?.some((c) => c.id === 'a1')).toBe(true)
  })

  it('failure leaves the backup untouched', async () => {
    seedDone()
    const q = new AnalysisQueue(engine('fail'), lib, { profileDir: '/p', cacheDir: dir })
    q.enqueue(V1)
    await tick(60)
    expect(lib.get(V1)?.status).toBe('error')
    expect(readClipsBackup(cache())?.some((c) => c.id === 'a1')).toBe(true)
  })

  it('first analysis (no prior doc, no backup) writes no flag and no backup', async () => {
    const q = new AnalysisQueue(engine('done'), lib, { profileDir: '/p', cacheDir: dir })
    q.enqueue(V1)
    await tick(60)
    expect(readDoc().app).toBeUndefined()
    expect(fs.existsSync(backup())).toBe(false)
  })

  it('direct successful re-analysis removes the backup it created', async () => {
    seedDone()
    const q = new AnalysisQueue(engine('done'), lib, { profileDir: '/p', cacheDir: dir })
    q.enqueue(V1)
    await tick(60)
    expect(readDoc().app).toEqual({ suggestionsPending: true })
    expect(fs.existsSync(backup())).toBe(false)
  })

  it('a corrupted backup next to a done doc is ignored and replaced; doc clips are used', async () => {
    seedDone()
    fs.writeFileSync(backup(), '{not json', 'utf-8')
    expect(readClipsBackup(cache())).toBeNull()
    const q = new AnalysisQueue(engine('done'), lib, { profileDir: '/p', cacheDir: dir })
    q.enqueue(V1)
    await tick(60)
    expect(summary(readDoc().clips)).toEqual([
      ['a1', 'accepted', true],
      ['m1', 'accepted', false]
    ])
  })

  it('a corrupted backup next to a partial doc is ignored: treated like an interrupted first analysis (no flag)', async () => {
    saveCacheDoc(doc('partial', 1, [manual]) as { cache_path: string })
    fs.writeFileSync(backup(), '{"version":1,"clips":"nope"}', 'utf-8')
    const q = new AnalysisQueue(engine('done'), lib, { profileDir: '/p', cacheDir: dir })
    q.enqueue(V1)
    await tick(60)
    expect(readDoc().app).toBeUndefined()
  })

  it('cache hit (same doc returned) is not a re-analysis: no flag, backup cleaned up', async () => {
    seedDone()
    const same = readDoc()
    const hit = { request: () => ({ id: 'r', promise: Promise.resolve(same) }), cancel: () => {} } as unknown as EngineClient
    const q = new AnalysisQueue(hit, lib, { profileDir: '/p', cacheDir: dir })
    q.enqueue(V1)
    await tick(60)
    expect(readDoc().app).toBeUndefined()
    expect(fs.existsSync(backup())).toBe(false)
  })

  it('a backup write failure never breaks the analysis', async () => {
    seedDone()
    fs.mkdirSync(backup()) // 讓 rename 到備份路徑失敗（目標是資料夾）
    const q = new AnalysisQueue(engine('done'), lib, { profileDir: '/p', cacheDir: dir })
    q.enqueue(V1)
    await tick(60)
    expect(lib.get(V1)?.status).toBe('done')
  })
})
