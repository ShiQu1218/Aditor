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
/** videos 底下各日期資料夾內的 mp4（不含 outputDir 根）。 */
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
  deps.liveCachePath = (file) => file + '.apexhl.json'
  return { root, dir, deps, outputPath, original }
}
describe.skipIf(!ffmpeg)('OBS 收尾與復原（真實 ffmpeg）', () => {
  it.each([false, true])('無段落仍匯入原檔、平移快取並遵守可信分析規則：%s', async (trusted) => {
    const r = await rig('session', trusted)
    expect(await finalizeSession(r.dir, r.deps)).toEqual([r.outputPath])
    expect(r.deps.addToLibrary).toHaveBeenCalledWith([r.outputPath])
    const cache = JSON.parse(fs.readFileSync(r.outputPath + '.apexhl.json', 'utf8'))
    expect(cache.events.map((e: any) => e.t)).toEqual([1, 3])
    expect(r.deps.enqueueAnalysis).toHaveBeenCalledTimes(trusted ? 0 : 1)
    expect(fs.readFileSync(r.outputPath)).toEqual(r.original)
  })
  it('OBS 剛停止、mkv 長度尚未寫入時等候檔案完成再剪', async () => {
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
  it('逐局串流複製保留原檔、不把原檔加入媒體庫', async () => {
    const r = await rig('match')
    const [cut] = await finalizeSession(r.dir, r.deps)
    expect(path.basename(cut)).toMatch(/^Apex_.*\.mp4$/)
    // 逐局輸出放進起點日期資料夾（資料夾名等於檔名的日期），outputDir 根不留 mp4
    expect(path.dirname(cut)).toBe(path.join(r.root, 'videos', path.basename(cut).slice(5, 15)))
    expect(DAY_FOLDER_PATTERN.test(path.basename(path.dirname(cut)))).toBe(true)
    expect(fs.readdirSync(path.join(r.root, 'videos')).filter((f) => f.endsWith('.mp4'))).toEqual([])
    expect(r.deps.addToLibrary).toHaveBeenCalledWith([cut])
    expect(cut).not.toBe(r.outputPath)
    expect(fs.existsSync(cut + '.apexhl.json')).toBe(true)
    expect(fs.readFileSync(r.outputPath)).toEqual(r.original)
    expect(spawnSync(ffmpeg!, ['-v', 'error', '-i', cut, '-f', 'null', '-'], { windowsHide: true }).status).toBe(0)
  })
  it('沒有對局保留整段；復原讀取 obs.json 而不依賴段落', async () => {
    const r = await rig('match')
    await writeJson(path.join(r.dir, 'live.json'), { events: [] })
    const failed = vi.fn(); const done = vi.fn()
    await recoverSessions(r.deps, done, failed)
    expect(failed).not.toHaveBeenCalled()
    expect(done).toHaveBeenCalledWith([r.outputPath])
    expect(fs.readFileSync(r.outputPath)).toEqual(r.original)
  })
  it('逐局從剪點前的關鍵影格開始（影音同起點）、前後各留五秒、平移事件；副作用失敗後復原不重剪', async () => {
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
    // 來源剪點 4、13 秒對齊到每 2 秒一個的關鍵影格（4、12），再加上 -1 秒的擷取時間差
    expect(marker.cuts.map((cut: any) => cut.offset)).toEqual([3, 11])
    const outputs = await finalizeSession(r.dir, r.deps)
    expect(outputs).toEqual(marker.cuts.map((cut: any) => cut.outputPath))
    const cache = JSON.parse(fs.readFileSync(outputs[0] + '.apexhl.json', 'utf8'))
    expect(cache.events.map((e: any) => e.t)).toEqual([2, 7])
    const firstPts = (stream: string): number => Number(spawnSync(path.join(path.dirname(ffmpeg!), `ffprobe${process.platform === 'win32' ? '.exe' : ''}`),
      ['-v', 'error', '-select_streams', stream, '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', '-read_intervals', '%+#1', outputs[1]],
      { windowsHide: true, encoding: 'utf8' }).stdout.trim().split(/\r?\n/)[0])
    // 影像與聲音都從 0 開始，不靠 MP4 edit list 隱藏多出的畫面（Chromium 播放時會不同步）
    expect(firstPts('v:0')).toBeCloseTo(0, 2)
    expect(Math.abs(firstPts('a:0'))).toBeLessThan(0.05)
    expect(datedMp4(r.root)).toHaveLength(2)
    expect(fs.readFileSync(r.outputPath)).toEqual(original)
  })
  it('遠端路徑通知後結束，不修改媒體庫', async () => {
    const r = await rig()
    await writeJson(path.join(r.dir, 'obs.json'), { outputPath: '\\\\remote\\OBS\\recording.mkv',
      recordStartedAt: 1, captureStartedAt: 2, adopted: false })
    r.deps.notify = vi.fn()
    expect(await finalizeSession(r.dir, r.deps)).toEqual([])
    expect(r.deps.notify).toHaveBeenCalled()
    expect(r.deps.addToLibrary).not.toHaveBeenCalled()
  })
  it('marker 落盤後改名失敗，復原沿用同一個預留檔', async () => {
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
  it('原檔在工作目錄內時保留整個目錄，不執行刪除', async () => {
    const r = await rig()
    const source = path.join(r.dir, 'OBS.mp4')
    fs.copyFileSync(r.outputPath, source)
    const meta = JSON.parse(fs.readFileSync(path.join(r.dir, 'obs.json'), 'utf8'))
    await writeJson(path.join(r.dir, 'obs.json'), { ...meta, outputPath: source })
    await expect(finalizeSession(r.dir, r.deps)).rejects.toThrow('OBS 原檔位於')
    expect(fs.readFileSync(source)).toEqual(r.original)
  })
})
