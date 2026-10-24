import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { AnalysisQueue } from './queue'
import { Library } from './library'
import type { EngineClient } from './engine'
import { cacheFilePath, legacyCacheFilePath, saveCacheDoc } from './cache-io'
import { capturePriorCache, clipsBackupPath, readClipsBackup } from './reanalysis'

const V1 = path.join(os.tmpdir(), 'aditor-ra', 'v1.mp4')
const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('clips backup across cancelled re-analysis (F2)', () => {
  let dir: string
  let lib: Library
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-ra-'))
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
  const doc = (status: string, mtime: number, clips: unknown[], events: unknown[] = [], cachePath = cache()): Record<string, unknown> => ({
    version: 1,
    video: video(mtime),
    profile: 'zh-TW',
    analysis: analysis(status),
    events,
    spectating: [],
    clips,
    keyframes: [],
    cache_path: cachePath
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
  const event = (id: string, t: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id,
    t,
    type: 'knock',
    score: 0.9,
    damage_line: true,
    name_sig: null,
    counted: true,
    counted_reason: 'score',
    counted_override: null,
    source: 'auto',
    ...over
  })

  /** Engine behavior: 'done' writes a completed document (manual clips only); 'fail' fails immediately. */
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

  /** Cancellation fake engine: overwrite the cache with a partial containing only manual clips (matching the real engine), then have cancel(id) reject with Cancelled. */
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
    // The engine-written partial contains manual clips only; the backup still has accepted AI clips.
    expect(readDoc().analysis.status).toBe('partial')
    expect(readDoc().clips.map((c: any) => c.id)).toEqual(['m1'])
    expect(readClipsBackup(cache())?.some((c) => c.id === 'a1')).toBe(true)

    // On a later resume/rerun, the cache is partial, so continue using the existing backup.
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

  it('forced re-analysis preserves accepted AI clips even when video and analysis metadata are unchanged', async () => {
    seedDone()
    const q = new AnalysisQueue(engine('done', 1), lib, { profileDir: '/p', cacheDir: dir })
    q.enqueue(V1, true)
    await tick(60)
    expect(summary(readDoc().clips)).toEqual([
      ['a1', 'accepted', true],
      ['m1', 'accepted', false]
    ])
    expect(readDoc().app).toEqual({ suggestionsPending: true })
    expect(fs.existsSync(backup())).toBe(false)
  })

  it('a backup write failure never breaks the analysis', async () => {
    seedDone()
    fs.mkdirSync(backup()) // Make renaming to the backup path fail by creating a directory there.
    const q = new AnalysisQueue(engine('done'), lib, { profileDir: '/p', cacheDir: dir })
    q.enqueue(V1)
    await tick(60)
    expect(lib.get(V1)?.status).toBe('done')
  })

  it('keeps deleted events, overrides, accepted AI clips, and manual clips when switching cache locations', async () => {
    const besideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-ra-switch-'))
    const videoPath = path.join(besideDir, 'switch.mp4')
    const appdataPath = cacheFilePath(videoPath, dir)
    const besidePath = cacheFilePath(videoPath, dir, true)
    const oldEvents = [
      event('deleted-old', 10, { deleted: true }),
      event('override-old', 20, { counted_override: false }),
      event('manual-event', 30, { source: 'manual' })
    ]
    const freshEvents = [
      event('deleted-fresh', 10.2),
      event('override-fresh', 20.3),
      event('override-duplicate', 20.8),
      event('new-auto', 70)
    ]
    const oldClips = [clip('accepted-ai', 100), manual]
    const switchDoc = (status: string, mtime: number, clips: unknown[], events: unknown[], target: string): Record<string, unknown> => ({
      ...doc(status, mtime, clips, events, target),
      video: { ...video(mtime), path: videoPath }
    })
    const old = switchDoc('done', 1, oldClips, oldEvents, appdataPath)
    saveCacheDoc(old as { cache_path: string })
    const switchedEngine = (target: string, events: Record<string, unknown>[], mtime = 2): EngineClient => ({
      request: () => {
        const result = switchDoc('done', mtime, [], events, target)
        saveCacheDoc(result as { cache_path: string })
        return { id: 'r', promise: Promise.resolve(result) }
      },
      cancel: () => {}
    } as unknown as EngineClient)

    try {
      const q = new AnalysisQueue(switchedEngine(besidePath, freshEvents), lib, {
        profileDir: '/p',
        cacheDir: dir,
        getSettings: () => ({ decode: 'auto', cacheLocation: 'besideVideo' })
      })
      lib.add([videoPath])
      q.enqueue(videoPath)
      await tick(60)

      const besideDoc = JSON.parse(fs.readFileSync(besidePath, 'utf-8'))
      expect(besideDoc.events.map((e: any) => [e.id, e.deleted ?? false, e.counted_override])).toEqual([
        ['deleted-fresh', true, null],
        ['override-fresh', false, false],
        ['override-duplicate', false, null],
        ['manual-event', false, null],
        ['new-auto', false, null]
      ])
      expect(summary(besideDoc.clips)).toEqual([
        ['accepted-ai', 'accepted', true],
        ['m1', 'accepted', false]
      ])

      // A user can edit the newly selected location before switching back.
      besideDoc.events.push(event('post-switch-manual', 80, { source: 'manual' }))
      besideDoc.clips.push(clip('post-switch-clip', 500, { origin: 'manual' }))
      fs.writeFileSync(besidePath, JSON.stringify(besideDoc))
      fs.utimesSync(appdataPath, new Date(1000), new Date(1000))
      fs.utimesSync(besidePath, new Date(2000), new Date(2000))
      const backEngine = switchedEngine(appdataPath, freshEvents, 3)
      const backQueue = new AnalysisQueue(backEngine, lib, {
        profileDir: '/p',
        cacheDir: dir,
        getSettings: () => ({ decode: 'auto', cacheLocation: 'appdata' })
      })
      backQueue.enqueue(videoPath)
      await tick(60)
      const appdataDoc = JSON.parse(fs.readFileSync(appdataPath, 'utf-8'))
      expect(appdataDoc.events.map((e: any) => [e.id, e.deleted ?? false, e.counted_override])).toEqual(
        besideDoc.events.map((e: any) => [e.id, e.deleted ?? false, e.counted_override])
      )
      expect(summary(appdataDoc.clips)).toEqual(summary(besideDoc.clips))
    } finally {
      fs.rmSync(besideDir, { recursive: true, force: true })
    }
  })
})

describe('re-analysis with cacheLocation=besideVideo', () => {
  it('capturePriorCache(beside) reads/backs up the cache beside the video, not the appdata one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-rb-'))
    const video = path.join(dir, 'videos', 'x.mp4')
    const beside = cacheFilePath(video, path.join(dir, 'cache'), true)
    const mk = (p: string, id: string): void => {
      saveCacheDoc({
        cache_path: p,
        video: { path: video, mtime: 1 },
        analysis: { status: 'done' },
        clips: [{ id, start: 1, end: 2, origin: 'manual', event_ids: [] }]
      } as unknown as { cache_path: string })
    }
    mk(beside, 'beside-clip')
    const appdata = cacheFilePath(video, path.join(dir, 'cache'), false)
    mk(appdata, 'appdata-clip')
    fs.utimesSync(beside, new Date(1000), new Date(1000))
    fs.utimesSync(appdata, new Date(1000), new Date(1000))
    try {
      const prior = capturePriorCache(video, path.join(dir, 'cache'), true)
      expect(prior?.clips.map((c) => c.id)).toEqual(['beside-clip'])
      expect(fs.existsSync(clipsBackupPath(beside))).toBe(true)
      expect(path.dirname(clipsBackupPath(beside))).toBe(path.dirname(video))
      expect(capturePriorCache(video, path.join(dir, 'cache'))?.clips.map((c) => c.id)).toEqual(['appdata-clip'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps a legacy partial cache and its v1 clips backup available after migrating its name', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-rb-legacy-'))
    const video = path.join(dir, 'videos', 'same.mp4')
    const cacheDir = path.join(dir, 'cache')
    const legacy = legacyCacheFilePath(video, cacheDir, true)
    const target = cacheFilePath(video, cacheDir, true)
    const oldDoc = {
      version: 1,
      video: { path: video, mtime: 1 },
      analysis: { status: 'partial' },
      events: [],
      clips: [{ id: 'manual', start: 1, end: 2, origin: 'manual', event_ids: [] }],
      cache_path: legacy
    }
    try {
      saveCacheDoc(oldDoc as unknown as { cache_path: string })
      fs.writeFileSync(clipsBackupPath(legacy), JSON.stringify({ version: 1, clips: [
        { id: 'accepted-ai', start: 3, end: 4, origin: 'ai', status: 'accepted', event_ids: [] }
      ] }))
      const prior = capturePriorCache(video, cacheDir, true)
      expect(prior?.clips.map((c) => c.id)).toEqual(['accepted-ai'])
      expect(prior?.backupPath).toBe(target)
      expect(fs.existsSync(target)).toBe(true)
      expect(fs.existsSync(legacy)).toBe(true)
      expect(readClipsBackup(target)?.map((c) => c.id)).toEqual(['accepted-ai'])
      expect(readClipsBackup(legacy)?.map((c) => c.id)).toEqual(['accepted-ai'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
