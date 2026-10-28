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

describe('recording index and safety boundaries', () => {
  it('ignores an incomplete trailing line and fails on a malformed complete line or decreasing sequence number', async () => {
    const dir = sessionDir(root())
    const index = path.join(dir, 'index.jsonl')
    fs.writeFileSync(index, '{"seq":1,"pts":0,"dur":2}\n{"seq":2')
    expect(await readIndex(dir)).toEqual([{ seq: 1, pts: 0, dur: 2 }])
    fs.appendFileSync(index, '\n')
    await expect(readIndex(dir)).rejects.toThrow('第 2 行')
    fs.writeFileSync(index, '{"seq":1,"pts":0,"dur":2}\n{"seq":1,"pts":2,"dur":2}\n')
    await expect(readIndex(dir)).rejects.toThrow('序號或時間')
  })

  it('with zero segments, removes only that session and leaves other sessions and external paths untouched', async () => {
    const base = root(); const deps = makeDeps(base)
    const dir = sessionDir(base)
    const other = sessionDir(base, 'other')
    expect(await finalizeSession(dir, deps)).toEqual([])
    expect(fs.existsSync(dir)).toBe(false)
    expect(fs.existsSync(other)).toBe(true)
    await expect(finalizeSession(base, deps)).rejects.toThrow('無效')
    expect(fs.existsSync(base)).toBe(true)
  })

  it('a finalized marker only retries library insertion and preserves the session when output is missing', async () => {
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

  it('a finalized marker adds the output with the game recorded in recording.json', async () => {
    const base = root(); const deps = makeDeps(base)
    deps.addToLibrary = vi.fn(); deps.enqueueAnalysis = vi.fn()
    const dir = sessionDir(base)
    const outputPath = path.join(base, 'videos', 'Valorant.mp4')
    fs.writeFileSync(outputPath, 'already finalized')
    fs.writeFileSync(path.join(dir, 'recording.json'), JSON.stringify({ startedAt: 1, postAnalysis: 'none', mode: 'session', game: 'valorant' }))
    fs.writeFileSync(path.join(dir, 'finalized.json'), JSON.stringify({ outputPath, postAnalysis: 'none', analysisQueued: false, liveCached: true }))
    expect(await finalizeSession(dir, deps)).toEqual([outputPath])
    expect(deps.addToLibrary).toHaveBeenCalledWith([outputPath], 'valorant')
  })

  it('recovers legacy markers in outputDir and markers in date folders, while rejecting other subfolders and non-date folders', async () => {
    const base = root(); const deps = makeDeps(base)
    deps.addToLibrary = vi.fn()
    const mark = (id: string, outputPath: string) => {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true }); fs.writeFileSync(outputPath, 'x')
      const dir = sessionDir(base, id)
      fs.writeFileSync(path.join(dir, 'finalized.json'), JSON.stringify({ outputPath }))
      return dir
    }
    const legacy = path.join(base, 'videos', 'legacy.mp4')
    expect(await finalizeSession(mark('legacy', legacy), deps)).toEqual([legacy])
    const dated = path.join(base, 'videos', '2026-10-18', 'dated.mp4')
    expect(await finalizeSession(mark('dated', dated), deps)).toEqual([dated])
    for (const [id, bad] of [['named', path.join(base, 'videos', 'other', 'a.mp4')],
      ['nested', path.join(base, 'videos', '2026-10-18', 'sub', 'a.mp4')],
      ['sessions', path.join(base, 'videos', '.sessions', 'a.mp4')]] as const) {
      await expect(finalizeSession(mark(id, bad), deps)).rejects.toThrow('無效')
    }
  })

  it('recovery scans configured, watched, and default paths, and a failed session does not affect others', async () => {
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

describe.skipIf(!ffmpeg)('finalization with real ffmpeg streams', () => {
  let fixtureRoot: string
  let segments: string
  beforeAll(() => { fixtureRoot = tempRoot(); segments = createSegments(fixtureRoot) })
  afterAll(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }))

  it.each(['session', 'match'])('persists recording-time game aspect only when present: %s', async (mode) => {
    for (const gameAspect of ['1920x1440', null, undefined]) {
      const base = root(); const deps = makeDeps(base); deps.ffmpegPath = ffmpeg!
      const dir = sessionDir(base); copySegments(segments, dir)
      fs.writeFileSync(path.join(dir, 'recording.json'), JSON.stringify({ startedAt: Date.now(), postAnalysis: 'none', mode, gameAspect }))
      if (mode === 'match') fs.writeFileSync(path.join(dir, 'live.json'), JSON.stringify({ matches: [{ start: 0, end: 2 }] }))
      const [output] = await finalizeSession(dir, deps)
      const ffprobe = path.join(path.dirname(ffmpeg!), `ffprobe${process.platform === 'win32' ? '.exe' : ''}`)
      const result = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', output],
        { windowsHide: true, encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout).format.tags.aditor_game_aspect).toBe(gameAspect ?? undefined)
      const bytes = fs.readFileSync(output)
      expect(bytes.indexOf('moov')).toBeLessThan(bytes.indexOf('mdat'))
    }
  })

  it.each(['none', 'afterExit', 'perMatch'] as const)('Output is decodable, faststart, collision-free, and retains recording-time analysis settings: %s', async (postAnalysis) => {
    const base = root(); const deps = makeDeps(base); deps.ffmpegPath = ffmpeg!
    deps.addToLibrary = vi.fn(); deps.enqueueAnalysis = vi.fn()
    const dir = sessionDir(base); copySegments(segments, dir)
    fs.writeFileSync(path.join(dir, 'recording.json'), JSON.stringify({ startedAt: new Date(2026, 9, 18, 12, 34).getTime(), postAnalysis }))
    fs.appendFileSync(path.join(dir, 'index.jsonl'), '{"seq":')
    const existing = path.join(base, 'videos', '2026-10-18', 'Apex_2026-10-18_12-34.mp4')
    fs.mkdirSync(path.dirname(existing), { recursive: true })
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

  it('places the full output in the local date folder for its start time, not in outputDir root, and keeps .sessions in place', async () => {
    const base = root(); const deps = makeDeps(base); deps.ffmpegPath = ffmpeg!
    deps.addToLibrary = vi.fn()
    const dir = sessionDir(base); copySegments(segments, dir)
    fs.writeFileSync(path.join(dir, 'recording.json'), JSON.stringify({ startedAt: new Date(2026, 9, 18, 23, 59).getTime(), postAnalysis: 'none' }))
    const [output] = await finalizeSession(dir, deps)
    expect(path.dirname(output)).toBe(path.join(base, 'videos', '2026-10-18'))
    expect(fs.readdirSync(path.join(base, 'videos')).filter((n) => n.endsWith('.mp4'))).toEqual([])
    expect(fs.existsSync(path.join(base, 'videos', '.sessions'))).toBe(true)
  })

  it('skips missing segments in a full recording, outputs the rest, and warns about the gap', async () => {
    const base = root(); const deps = makeDeps(base); deps.ffmpegPath = ffmpeg!
    deps.addToLibrary = vi.fn(); deps.notify = vi.fn()
    const dir = sessionDir(base); copySegments(segments, dir)
    fs.unlinkSync(path.join(dir, 'seg_000001.m4s'))
    const [output] = await finalizeSession(dir, deps)
    const decoded = spawnSync(ffmpeg!, ['-v', 'error', '-i', output, '-map', '0:v', '-f', 'null', '-'],
      { windowsHide: true, encoding: 'utf8' })
    expect(decoded.status, decoded.stderr).toBe(0)
    expect(deps.addToLibrary).toHaveBeenCalledWith([output])
    expect(deps.notify).toHaveBeenCalledWith('warning', expect.stringContaining('1'))
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('preserves the session when every segment of a full recording is missing', async () => {
    const base = root(); const deps = makeDeps(base); deps.ffmpegPath = ffmpeg!
    const dir = sessionDir(base); copySegments(segments, dir)
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.m4s'))) fs.unlinkSync(path.join(dir, name))
    await expect(finalizeSession(dir, deps)).rejects.toThrow('遺失')
    expect(fs.existsSync(dir)).toBe(true)
    expect(fs.existsSync(path.join(base, 'videos', '2026-10-18'))).toBe(false)
  })

  it('preserves segments after concatenation fails and recovers on startup after repair', async () => {
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

  it('retries only the marker after library failure without rerunning ffmpeg, and re-enqueues analysis after analysis failure', async () => {
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

  it.each([
    ['marker write', (operation: 'open' | 'rename', file: string) => operation === 'open' && file.endsWith('finalized.json.tmp')],
    ['rename', (operation: 'open' | 'rename', file: string) => operation === 'rename' && file.endsWith('.part.mp4')]
  ] as const)('recovers from a %s failure without producing a second output', async (name, failsOn) => {
    const base = root(); const deps = makeDeps(base); deps.ffmpegPath = ffmpeg!
    const dir = sessionDir(base); copySegments(segments, dir)
    const open = fs.promises.open.bind(fs.promises)
    const rename = fs.promises.rename.bind(fs.promises)
    let failed = false
    const fail = (operation: 'open' | 'rename', file: unknown) => {
      if (!failed && failsOn(operation, String(file))) { failed = true; throw new Error('simulated failure') }
    }
    const spies = [
      vi.spyOn(fs.promises, 'open').mockImplementation((async (file: string, ...rest: unknown[]) => { fail('open', file); return (open as any)(file, ...rest) }) as never),
      vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => { fail('rename', from); return rename(from, to) })
    ]
    try {
      await expect(finalizeSession(dir, deps)).rejects.toThrow('simulated failure')
      // The rename row recovers the part left by the first attempt without remuxing again.
      if (name === 'rename') deps.ffmpegPath = 'must-not-run'
      const [output] = await finalizeSession(dir, deps)
      expect(path.basename(output)).not.toMatch(/_2\.mp4$/)
      const names = fs.readdirSync(path.dirname(output))
      expect(names.filter((name) => name.endsWith('.mp4'))).toEqual([path.basename(output)])
      expect(fs.existsSync(dir)).toBe(false)
    } finally { for (const spy of spies) spy.mockRestore() }
  })

  it('re-finalizes from segments when a reserved part disappeared after the final marker was written', async () => {
    const base = root(); const deps = makeDeps(base); deps.ffmpegPath = ffmpeg!
    const dir = sessionDir(base); copySegments(segments, dir)
    const rename = fs.promises.rename.bind(fs.promises)
    let failed = false
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (!failed && String(from).endsWith('.part.mp4')) { failed = true; throw new Error('simulated failure') }
      return rename(from, to)
    })
    try {
      await expect(finalizeSession(dir, deps)).rejects.toThrow('simulated failure')
      expect(fs.existsSync(path.join(dir, 'finalized.json'))).toBe(true)
      const pending = JSON.parse(fs.readFileSync(path.join(dir, 'match-part.json'), 'utf8')) as { output: string; part: string }
      fs.unlinkSync(pending.part)
      const unlink = fs.promises.unlink.bind(fs.promises)
      vi.spyOn(fs.promises, 'unlink').mockImplementationOnce(async () => { throw new Error('marker busy') })
      await expect(finalizeSession(dir, deps)).rejects.toThrow('marker busy')
      expect(fs.existsSync(path.join(dir, 'match-part.json'))).toBe(true)
      vi.spyOn(fs.promises, 'unlink').mockImplementation(unlink)
      const [output] = await finalizeSession(dir, deps)
      expect(output).toBe(pending.output)
      expect(fs.readdirSync(path.dirname(output)).filter((entry) => entry.endsWith('.mp4'))).toEqual([path.basename(output)])
      expect(fs.existsSync(dir)).toBe(false)
    } finally { spy.mockRestore() }
  })
})
