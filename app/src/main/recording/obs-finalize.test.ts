import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { finalizeSession, writeJson } from './finalize'
import { recoverSessions } from './recovery'
import { DAY_FOLDER_PATTERN } from '../../shared/storage'
import { createSegments, ffmpeg, makeDeps, sessionDir, tempRoot } from './test-support'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
/** MP4 files in each date folder under videos (excluding the outputDir root). */
const datedMp4 = (root: string): string[] => fs.readdirSync(path.join(root, 'videos'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && DAY_FOLDER_PATTERN.test(d.name))
  .flatMap((d) => fs.readdirSync(path.join(root, 'videos', d.name)).filter((f) => f.endsWith('.mp4')))
const event = (t: number) => ({ id: `a${t}`, t, type: 'knock', counted: true })
async function rig(mode = 'session', trusted = false) {
  const root = tempRoot(); roots.push(root)
  const deps = makeDeps(root)
  const dir = sessionDir(root)
  createSegments(root)
  const outputPath = path.join(root, 'source.mp4')
  const original = fs.readFileSync(outputPath)
  const recordStartedAt = Date.now() - 2000
  await writeJson(path.join(dir, 'recording.json'), { backend: 'obs', mode, startedAt: recordStartedAt, postAnalysis: 'afterExit' })
  await writeJson(path.join(dir, 'obs.json'), { outputPath, recordStartedAt, captureStartedAt: recordStartedAt + 1000, adopted: false })
  await writeJson(path.join(dir, 'live.json'), { engine_version: '0.3.0', quality: { complete: trusted },
    events: [event(0), event(2), event(5)], matches: mode === 'match' ? [{ start: 0.5, end: 1.5 }] : [] })
  deps.ffmpegPath = ffmpeg!
  deps.addToLibrary = vi.fn(); deps.enqueueAnalysis = vi.fn()
  deps.liveCachePath = (file) => file + '.aditor.json'
  return { root, dir, deps, outputPath, original }
}
describe.skipIf(!ffmpeg)('OBS finalization and recovery (real ffmpeg)', () => {
  it.each(['1920x1440', null, undefined])('persists recording-time game aspect on remuxed match output: %s', async (gameAspect) => {
    const r = await rig('match')
    const config = JSON.parse(fs.readFileSync(path.join(r.dir, 'recording.json'), 'utf8'))
    await writeJson(path.join(r.dir, 'recording.json'), { ...config, gameAspect })
    const [cut] = await finalizeSession(r.dir, r.deps)
    const ffprobe = path.join(path.dirname(ffmpeg!), `ffprobe${process.platform === 'win32' ? '.exe' : ''}`)
    const result = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', cut],
      { windowsHide: true, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).format.tags.aditor_game_aspect).toBe(gameAspect ?? undefined)
    const bytes = fs.readFileSync(cut)
    expect(bytes.indexOf('moov')).toBeLessThan(bytes.indexOf('mdat'))
    expect(fs.readFileSync(r.outputPath)).toEqual(r.original)
  })
  it.each([false, true])('Without segments, still import the original, shift the cache, and follow trusted-analysis rules: %s', async (trusted) => {
    const r = await rig('session', trusted)
    expect(await finalizeSession(r.dir, r.deps)).toEqual([r.outputPath])
    expect(r.deps.addToLibrary).toHaveBeenCalledWith([r.outputPath])
    const cache = JSON.parse(fs.readFileSync(r.outputPath + '.aditor.json', 'utf8'))
    expect(cache.events.map((e: any) => e.t)).toEqual([1, 3])
    expect(r.deps.enqueueAnalysis).toHaveBeenCalledTimes(trusted ? 0 : 1)
    expect(fs.readFileSync(r.outputPath)).toEqual(r.original)
  })
  it('waits for OBS to finish writing the file before clipping when MKV duration is not yet available after stop', async () => {
    const r = await rig('match')
    const real = await import('../export/keyframe')
    const ffprobe = path.join(path.dirname(ffmpeg!), `ffprobe${process.platform === 'win32' ? '.exe' : ''}`)
    const measure = real.createMediaEndProbe(ffprobe)
    let calls = 0
    r.deps.obsFileSettleMs = 1
    r.deps.probeVideo = vi.fn(async (file: string) => {
      calls++
      return calls < 3 ? { duration: 0 } : { duration: await measure(file) }
    }) as never
    const [cut] = await finalizeSession(r.dir, r.deps)
    expect(calls).toBeGreaterThanOrEqual(3)
    expect(path.basename(cut)).toMatch(/^Apex_.*\.mp4$/)
    expect(fs.existsSync(r.dir)).toBe(false)
  })
  it('preserves the original file during per-match stream copy and does not add it to the library', async () => {
    const r = await rig('match')
    const [cut] = await finalizeSession(r.dir, r.deps)
    expect(path.basename(cut)).toMatch(/^Apex_.*\.mp4$/)
    // Put per-match output in the folder for its start date (the folder name matches the filename date); leave no MP4 files in the outputDir root.
    expect(path.dirname(cut)).toBe(path.join(r.root, 'videos', path.basename(cut).slice(5, 15)))
    expect(DAY_FOLDER_PATTERN.test(path.basename(path.dirname(cut)))).toBe(true)
    expect(fs.readdirSync(path.join(r.root, 'videos')).filter((f) => f.endsWith('.mp4'))).toEqual([])
    expect(r.deps.addToLibrary).toHaveBeenCalledWith([cut])
    expect(cut).not.toBe(r.outputPath)
    expect(fs.existsSync(cut + '.aditor.json')).toBe(true)
    expect(fs.readFileSync(r.outputPath)).toEqual(r.original)
    expect(spawnSync(ffmpeg!, ['-v', 'error', '-i', cut, '-f', 'null', '-'], { windowsHide: true }).status).toBe(0)
  })
  it('preserves the full recording when there are no matches and recovers from obs.json without relying on segments', async () => {
    const r = await rig('match')
    await writeJson(path.join(r.dir, 'live.json'), { events: [] })
    const failed = vi.fn(); const done = vi.fn()
    await recoverSessions(r.deps, done, failed)
    expect(failed).not.toHaveBeenCalled()
    expect(done).toHaveBeenCalledWith([r.outputPath])
    expect(fs.readFileSync(r.outputPath)).toEqual(r.original)
  })
  it('starts per-match clips at the preceding keyframe with aligned audio/video, keeps five seconds on each side, shifts events, and avoids reclipping during recovery after a side-effect failure', async () => {
    const r = await rig('match')
    const generated = spawnSync(ffmpeg!, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=26',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=26',
      '-c:v', 'mpeg4', '-g', '20', '-bf', '0', '-c:a', 'aac', r.outputPath], { windowsHide: true, encoding: 'utf8' })
    expect(generated.status, generated.stderr).toBe(0)
    const original = fs.readFileSync(r.outputPath)
    await writeJson(path.join(r.dir, 'live.json'), { engine_version: '0.3.0', events: [5, 10, 20].map(event),
      matches: [{ start: 8, end: 10 }, { start: 17, end: 18 }] })
    r.deps.addToLibrary = vi.fn().mockImplementationOnce(() => { throw new Error('媒體庫寫入失敗') })
    await expect(finalizeSession(r.dir, r.deps)).rejects.toThrow('媒體庫')
    const marker = JSON.parse(fs.readFileSync(path.join(r.dir, 'matches.json'), 'utf8'))
    // Align source cuts at 4 and 13 seconds to keyframes every 2 seconds (4 and 12), then apply the -1 second capture offset.
    expect(marker.cuts.map((cut: any) => cut.offset)).toEqual([3, 11])
    const outputs = await finalizeSession(r.dir, r.deps)
    expect(outputs).toEqual(marker.cuts.map((cut: any) => cut.outputPath))
    const cache = JSON.parse(fs.readFileSync(outputs[0] + '.aditor.json', 'utf8'))
    expect(cache.events.map((e: any) => e.t)).toEqual([2, 7])
    const firstPts = (stream: string): number => Number(spawnSync(path.join(path.dirname(ffmpeg!), `ffprobe${process.platform === 'win32' ? '.exe' : ''}`),
      ['-v', 'error', '-select_streams', stream, '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', '-read_intervals', '%+#1', outputs[1]],
      { windowsHide: true, encoding: 'utf8' }).stdout.trim().split(/\r?\n/)[0])
    // Start both audio and video at 0; do not rely on an MP4 edit list to hide extra frames (Chromium playback would desynchronize).
    expect(firstPts('v:0')).toBeCloseTo(0, 2)
    expect(Math.abs(firstPts('a:0'))).toBeLessThan(0.05)
    expect(datedMp4(r.root)).toHaveLength(2)
    expect(fs.readFileSync(r.outputPath)).toEqual(original)
  })
  it('notifies and exits for a remote path without changing the library', async () => {
    const r = await rig()
    await writeJson(path.join(r.dir, 'obs.json'), { outputPath: '\\\\remote\\OBS\\recording.mkv',
      recordStartedAt: 1, captureStartedAt: 2, adopted: false })
    r.deps.notify = vi.fn()
    expect(await finalizeSession(r.dir, r.deps)).toEqual([])
    expect(r.deps.notify).toHaveBeenCalled()
    expect(r.deps.addToLibrary).not.toHaveBeenCalled()
  })
  it('keeps the job and live.json when a local OBS file is temporarily unreadable, then finalizes once it returns', async () => {
    const r = await rig()
    const folder = path.join(r.root, 'obs')
    const source = path.join(folder, 'source.mp4')
    fs.mkdirSync(folder)
    fs.copyFileSync(r.outputPath, source)
    const meta = JSON.parse(fs.readFileSync(path.join(r.dir, 'obs.json'), 'utf8'))
    await writeJson(path.join(r.dir, 'obs.json'), { ...meta, outputPath: source })
    // Hide the whole parent folder: a missing folder or volume may come back, so this must stay retryable.
    const offline = folder + '.offline'
    fs.renameSync(folder, offline)
    r.deps.notify = vi.fn()
    await expect(finalizeSession(r.dir, r.deps)).rejects.toThrow('暫時無法讀取')
    expect(fs.existsSync(path.join(r.dir, 'live.json'))).toBe(true)
    expect(r.deps.addToLibrary).not.toHaveBeenCalled()
    fs.renameSync(offline, folder)
    expect(await finalizeSession(r.dir, r.deps)).toEqual([source])
    expect(fs.existsSync(source + '.aditor.json')).toBe(true)
  })
  it('removes the job when the local OBS file was permanently deleted but its folder still exists', async () => {
    const r = await rig()
    fs.rmSync(r.outputPath)
    r.deps.notify = vi.fn()
    expect(await finalizeSession(r.dir, r.deps)).toEqual([])
    expect(r.deps.notify).toHaveBeenCalledWith('warning', 'OBS 影片已不存在，已移除這次錄影的收尾工作')
    expect(r.deps.addToLibrary).not.toHaveBeenCalled()
    expect(fs.existsSync(r.dir)).toBe(false)
  })
  it('reuses the same reserved file during recovery when rename fails after the marker is persisted', async () => {
    const r = await rig('match')
    const rename = fs.promises.rename.bind(fs.promises)
    let interrupted = false
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (!interrupted && String(from).endsWith('.part.mp4')) { interrupted = true; throw new Error('模擬中斷') }
      return rename(from, to)
    })
    await expect(finalizeSession(r.dir, r.deps)).rejects.toThrow('模擬中斷')
    const marker = JSON.parse(fs.readFileSync(path.join(r.dir, 'matches.json'), 'utf8'))
    const outputs = await finalizeSession(r.dir, r.deps)
    expect(outputs).toEqual(marker.cuts.map((cut: any) => cut.outputPath))
    expect(datedMp4(r.root)).toHaveLength(1)
    expect(fs.readFileSync(r.outputPath)).toEqual(r.original)
  })
  it('preserves the entire directory and skips deletion when the source file is inside the session directory', async () => {
    const r = await rig()
    const source = path.join(r.dir, 'OBS.mp4')
    fs.copyFileSync(r.outputPath, source)
    const meta = JSON.parse(fs.readFileSync(path.join(r.dir, 'obs.json'), 'utf8'))
    await writeJson(path.join(r.dir, 'obs.json'), { ...meta, outputPath: source })
    await expect(finalizeSession(r.dir, r.deps)).rejects.toThrow('OBS 原檔位於')
    expect(fs.readFileSync(source)).toEqual(r.original)
  })
})
