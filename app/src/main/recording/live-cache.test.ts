import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { finalizeSession } from './finalize'
import { buildLiveCacheDoc, liveCounts } from './live-cache'
import { makeDeps, sessionDir, tempRoot } from './test-support'
import { cacheFilePath } from '../cache-io'
import type { EngineEvent } from '../../shared/types'

const roots: string[] = []
afterEach(() => { for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true }) })
function root(): string { const value = tempRoot(); roots.push(value); return value }
const ev = (id: string, t: number, type = 'knock', counted = true): EngineEvent => ({ id, t, type, score: 1, damage_line: false,
  name_sig: null, counted, counted_reason: counted ? 'first' : 'duplicate', counted_override: null, source: 'auto' })

/** 已串接的工作（finalized.json 已寫）：收尾只做 live 快取、媒體庫與分析，不需要 ffmpeg。 */
function finishedSession(base: string, postAnalysis: 'none' | 'afterExit', live: object | null): { dir: string; output: string } {
  const dir = sessionDir(base)
  const output = path.join(base, 'videos', 'Apex_2026-10-18_12-34.mp4')
  fs.writeFileSync(output, 'video-bytes')
  fs.copyFileSync(path.join(__dirname, '__fixtures__', 'init-h264.mp4'), path.join(dir, 'init.mp4'))
  fs.writeFileSync(path.join(dir, 'index.jsonl'), [0, 2, 4].map((pts, i) => JSON.stringify({ seq: i + 1, pts, dur: 2 }) + '\n').join(''))
  if (live) fs.writeFileSync(path.join(dir, 'live.json'), JSON.stringify(live))
  fs.writeFileSync(path.join(dir, 'finalized.json'), JSON.stringify({ outputPath: output, postAnalysis, analysisQueued: false }))
  return { dir, output }
}

const LIVE = {
  version: 1, engine_version: '0.3.0', t: 6,
  events: [ev('a1000', 1), ev('a2000', 2, 'assist_elim'), ev('a3000', 3, 'knock', false), ev('a9000', 9)],
  spectating: [{ start: 4, end: 7 }], matches: [{ start: 0.5, end: 5 }], width: 2560, height: 1440
}

describe('live.json → 分析快取', () => {
  it('組出引擎相同格式，done 但 engine_version 標成 live（完整分析仍會重跑），超出影片的事件剔除', () => {
    const doc = buildLiveCacheDoc(LIVE, { path: 'D:\\v.mp4', size: 10, mtime: 1.5, duration: 6, width: 2560, height: 1440, codec: 'hevc' }, 0, 'tv1', 'C:\\c.json')
    expect(doc).toMatchObject({
      version: 1,
      video: { path: 'D:\\v.mp4', size: 10, mtime: 1.5, duration: 6, width: 2560, height: 1440, codec: 'hevc', start_time: 0 },
      analysis: { status: 'done', source: 'live', progress_t: 6, engine_version: 'live-0.3.0', templates_version: 'tv1' },
      spectating: [{ start: 4, end: 6 }], clips: [], live: { matches: [{ start: 0.5, end: 5 }] }, cache_path: 'C:\\c.json'
    })
    expect(doc.events.map((e) => e.id)).toEqual(['a1000', 'a2000', 'a3000'])
    expect(liveCounts(doc.events)).toEqual({ knock: 1, assist: 1 })
    const shifted = buildLiveCacheDoc(LIVE, { path: 'v', size: 1, mtime: 1, duration: 6, width: 0, height: 0, codec: '' }, 2, '', 'c')
    expect(shifted.events.map((e) => [e.id, e.t])).toEqual([['a2000', 0], ['a3000', 1]])
  })

  it('即時結果判定完整時寫正式引擎版本與尺度，收尾不再排完整分析', async () => {
    const base = root()
    const deps = makeDeps(base)
    deps.enqueueAnalysis = vi.fn()
    deps.onLiveAnalysis = vi.fn()
    const cacheDir = path.join(base, 'cache')
    deps.liveCachePath = (video) => cacheFilePath(video, cacheDir)
    const trusted = { ...LIVE, quality: { complete: true, reasons: [], hScale: 1.05 } }
    const { dir, output } = finishedSession(base, 'afterExit', trusted)
    expect(await finalizeSession(dir, deps)).toEqual([output])
    expect(deps.enqueueAnalysis).not.toHaveBeenCalled()
    expect(deps.onLiveAnalysis).toHaveBeenCalledWith(output, expect.objectContaining({ trusted: true }))
    const doc = JSON.parse(fs.readFileSync(cacheFilePath(output, cacheDir), 'utf8'))
    expect(doc.analysis).toMatchObject({ engine_version: '0.3.0', h_scale: 1.05 })
  })

  it.each([
    ['不完整', { complete: false, reasons: ['frames_lost'], hScale: 1 }],
    ['沒有判定（被強制結束）', null]
  ])('即時結果%s時照常排完整分析', async (_label, quality) => {
    const base = root()
    const deps = makeDeps(base)
    deps.enqueueAnalysis = vi.fn()
    const cacheDir = path.join(base, 'cache')
    deps.liveCachePath = (video) => cacheFilePath(video, cacheDir)
    const { dir, output } = finishedSession(base, 'afterExit', { ...LIVE, quality })
    await finalizeSession(dir, deps)
    expect(deps.enqueueAnalysis).toHaveBeenCalledWith(output)
    expect(JSON.parse(fs.readFileSync(cacheFilePath(output, cacheDir), 'utf8')).analysis.engine_version).toBe('live-0.3.0')
  })

  it.each(['none', 'afterExit'] as const)('收尾寫入快取並在排分析前通知媒體庫（%s）', async (postAnalysis) => {
    const base = root()
    const deps = makeDeps(base)
    fs.writeFileSync(path.join(base, 'profile.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(base, 'profile.json'), 'utf8')), templates_version: 'icons-7' }))
    const order: string[] = []
    deps.addToLibrary = vi.fn(() => { order.push('library') })
    deps.enqueueAnalysis = vi.fn(() => { order.push('analysis') })
    deps.onLiveAnalysis = vi.fn(() => { order.push('live') })
    const cacheDir = path.join(base, 'cache')
    deps.liveCachePath = (video) => cacheFilePath(video, cacheDir)
    const { dir, output } = finishedSession(base, postAnalysis, LIVE)
    expect(await finalizeSession(dir, deps)).toEqual([output])
    expect(order).toEqual(postAnalysis === 'none' ? ['library', 'live'] : ['library', 'live', 'analysis'])
    expect(deps.onLiveAnalysis).toHaveBeenCalledWith(output, { counts: { knock: 1, assist: 1 }, durationSec: 6, codec: 'h264', trusted: false })
    const doc = JSON.parse(fs.readFileSync(cacheFilePath(output, cacheDir), 'utf8'))
    expect(doc.video).toMatchObject({ path: output, size: 11, duration: 6, width: 2560, height: 1440, codec: 'h264' })
    expect(doc.video.mtime).toBeCloseTo(fs.statSync(output).mtimeMs / 1000, 3)
    expect(doc.analysis).toMatchObject({ status: 'done', engine_version: 'live-0.3.0', templates_version: 'icons-7' })
    expect(doc.cache_path).toBe(cacheFilePath(output, cacheDir))
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('沒有 live.json、已有快取或轉換失敗都不阻擋收尾，也不覆蓋既有快取', async () => {
    const base = root()
    const deps = makeDeps(base)
    deps.onLiveAnalysis = vi.fn()
    deps.addToLibrary = vi.fn()
    const cacheDir = path.join(base, 'cache')
    deps.liveCachePath = (video) => cacheFilePath(video, cacheDir)
    const first = finishedSession(base, 'none', null)
    expect(await finalizeSession(first.dir, deps)).toEqual([first.output])
    expect(deps.onLiveAnalysis).not.toHaveBeenCalled()

    const existing = finishedSession(base, 'none', LIVE)
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(cacheFilePath(existing.output, cacheDir), '{"analysis":{"status":"done"}}')
    await finalizeSession(existing.dir, deps)
    expect(fs.readFileSync(cacheFilePath(existing.output, cacheDir), 'utf8')).toBe('{"analysis":{"status":"done"}}')
    expect(deps.onLiveAnalysis).not.toHaveBeenCalled()

    const broken = finishedSession(base, 'none', LIVE)
    fs.writeFileSync(path.join(broken.dir, 'live.json'), '{broken')
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await finalizeSession(broken.dir, deps)).toEqual([broken.output])
    expect(fs.existsSync(broken.dir)).toBe(false)
  })
})
