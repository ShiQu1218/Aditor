import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { finalizeSession, readIndex } from './finalize'
import { recoverSessions } from './recovery'
import { copySegments, createSegments, ffmpeg, makeDeps, sessionDir, tempRoot } from './test-support'

const roots: string[] = []
function root(): string { const value = tempRoot(); roots.push(value); return value }
afterEach(() => { for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true }) })

describe('錄影索引與安全邊界', () => {
  it('忽略未完成尾行，完整壞行或序號倒退則失敗', async () => {
    const dir = sessionDir(root())
    const index = path.join(dir, 'index.jsonl')
    fs.writeFileSync(index, '{"seq":1,"pts":0,"dur":2}\n{"seq":2')
    expect(await readIndex(dir)).toEqual([{ seq: 1, pts: 0, dur: 2 }])
    fs.appendFileSync(index, '\n')
    await expect(readIndex(dir)).rejects.toThrow('第 2 行')
    fs.writeFileSync(index, '{"seq":1,"pts":0,"dur":2}\n{"seq":1,"pts":2,"dur":2}\n')
    await expect(readIndex(dir)).rejects.toThrow('序號或時間')
  })

  it('零段落只移除該工作，不刪除其他工作或外部路徑', async () => {
    const base = root(); const deps = makeDeps(base)
    const dir = sessionDir(base)
    const other = sessionDir(base, 'other')
    expect(await finalizeSession(dir, deps)).toEqual([])
    expect(fs.existsSync(dir)).toBe(false)
    expect(fs.existsSync(other)).toBe(true)
    await expect(finalizeSession(base, deps)).rejects.toThrow('無效')
    expect(fs.existsSync(base)).toBe(true)
  })

  it('finalized marker 僅補加媒體庫，輸出遺失時保留工作', async () => {
    const base = root(); const deps = makeDeps(base)
    deps.addToLibrary = vi.fn(); deps.enqueueAnalysis = vi.fn()
    const dir = sessionDir(base)
    const outputPath = path.join(base, 'videos', 'finished.mp4')
    fs.writeFileSync(outputPath, 'already finalized')
    fs.writeFileSync(path.join(dir, 'finalized.json'), JSON.stringify({ outputPath }))
    expect(await finalizeSession(dir, deps)).toEqual([outputPath])
    expect(deps.addToLibrary).toHaveBeenCalledWith([outputPath])
    expect(deps.enqueueAnalysis).not.toHaveBeenCalled()
    const missing = sessionDir(base, 'missing')
    fs.writeFileSync(path.join(missing, 'finalized.json'), JSON.stringify({ outputPath: path.join(base, 'videos', 'missing.mp4') }))
    await expect(finalizeSession(missing, deps)).rejects.toThrow()
    expect(fs.existsSync(missing)).toBe(true)
  })

  it('恢復會掃描設定、監看與預設路徑，失敗的工作不影響其他工作', async () => {
    const base = root(); const deps = makeDeps(base)
    const extra = path.join(base, 'extra')
    const watched = path.join(base, 'watched')
    deps.getSettings = () => ({ ...makeDeps(base).getSettings(), outputDir: extra })
    deps.getWatchFolders = () => [watched, extra]
    const dirs = [extra, watched, deps.defaultOutputDir].map((folder) => {
      const dir = path.join(folder, '.sessions', 'empty'); fs.mkdirSync(dir, { recursive: true }); return dir
    })
    const bad = sessionDir(base, 'bad')
    fs.writeFileSync(path.join(bad, 'index.jsonl'), 'invalid\n')
    const failed = vi.fn()
    await recoverSessions(deps, vi.fn(), failed)
    expect(dirs.every((dir) => !fs.existsSync(dir))).toBe(true)
    expect(fs.existsSync(bad)).toBe(true)
    expect(failed).toHaveBeenCalledOnce()
  })
})

describe.skipIf(!ffmpeg)('真實 ffmpeg 串流收尾', () => {
  let fixtureRoot: string
  let segments: string
  beforeAll(() => { fixtureRoot = tempRoot(); segments = createSegments(fixtureRoot) })
  afterAll(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }))

  it.each(['none', 'afterExit', 'perMatch'] as const)('影音可解碼、faststart、不撞名，並保留錄影時的分析設定：%s', async (postAnalysis) => {
    const base = root(); const deps = makeDeps(base); deps.ffmpegPath = ffmpeg!
    deps.addToLibrary = vi.fn(); deps.enqueueAnalysis = vi.fn()
    const dir = sessionDir(base); copySegments(segments, dir)
    fs.writeFileSync(path.join(dir, 'recording.json'), JSON.stringify({ startedAt: new Date(2026, 9, 18, 12, 34).getTime(), postAnalysis }))
    fs.appendFileSync(path.join(dir, 'index.jsonl'), '{"seq":')
    const existing = path.join(base, 'videos', 'Apex_2026-10-18_12-34.mp4')
    fs.writeFileSync(existing, 'keep')
    const [output] = await finalizeSession(dir, deps)
    expect(output).toBe(existing.replace('.mp4', '_2.mp4'))
    expect(fs.readFileSync(existing, 'utf8')).toBe('keep')
    expect(fs.existsSync(dir)).toBe(false)
    expect(deps.addToLibrary).toHaveBeenCalledWith([output])
    expect(deps.enqueueAnalysis).toHaveBeenCalledTimes(postAnalysis === 'none' ? 0 : 1)
    const bytes = fs.readFileSync(output)
    expect(bytes.indexOf('moov')).toBeLessThan(bytes.indexOf('mdat'))
    const decoded = spawnSync(ffmpeg!, ['-v', 'error', '-i', output, '-map', '0:v', '-map', '0:a', '-f', 'null', '-'],
      { windowsHide: true, encoding: 'utf8' })
    expect(decoded.status, decoded.stderr).toBe(0)
    const ffprobe = path.join(path.dirname(ffmpeg!), 'ffprobe' + (process.platform === 'win32' ? '.exe' : ''))
    const probe = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', output], { windowsHide: true, encoding: 'utf8' })
    expect(probe.status, probe.stderr).toBe(0)
    expect(Number(probe.stdout)).toBeGreaterThanOrEqual(4)
    expect(fs.readdirSync(path.dirname(output)).some((name) => name.endsWith('.part.mp4'))).toBe(false)
  })

  it('串接失敗保留段落，修復後可由啟動補收尾', async () => {
    const base = root(); const deps = makeDeps(base)
    const dir = sessionDir(base); copySegments(segments, dir)
    await expect(finalizeSession(dir, deps)).rejects.toThrow('串接失敗')
    expect(fs.existsSync(path.join(dir, 'seg_000001.m4s'))).toBe(true)
    deps.ffmpegPath = ffmpeg!
    const finalized = vi.fn(); const failed = vi.fn()
    await recoverSessions(deps, finalized, failed)
    expect(failed).not.toHaveBeenCalled()
    expect(finalized).toHaveBeenCalledOnce()
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('媒體庫失敗後只重試 marker，不重跑 ffmpeg；分析失敗會再次排入', async () => {
    const base = root(); const deps = makeDeps(base); deps.ffmpegPath = ffmpeg!
    const dir = sessionDir(base); copySegments(segments, dir)
    fs.writeFileSync(path.join(dir, 'recording.json'), JSON.stringify({ startedAt: Date.now(), postAnalysis: 'afterExit' }))
    deps.addToLibrary = vi.fn(() => { throw new Error('媒體庫失敗') })
    await expect(finalizeSession(dir, deps)).rejects.toThrow('媒體庫失敗')
    expect(fs.existsSync(path.join(dir, 'finalized.json'))).toBe(true)
    deps.ffmpegPath = 'must-not-run'
    deps.addToLibrary = vi.fn()
    deps.enqueueAnalysis = vi.fn(() => { throw new Error('分析失敗') })
    await expect(finalizeSession(dir, deps)).rejects.toThrow('分析失敗')
    deps.enqueueAnalysis = vi.fn()
    const [output] = await finalizeSession(dir, deps)
    expect(deps.enqueueAnalysis).toHaveBeenCalledWith(output)
    expect(fs.readdirSync(path.dirname(output)).filter((name) => name.endsWith('.mp4'))).toHaveLength(1)
  })
})
