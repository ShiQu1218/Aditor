import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import { PassThrough, Writable } from 'stream'
import { cutMatches, finalizeSession, selectMatchEntries } from './finalize'
import { RecordingSessionService } from './session'
import { pruneSegments } from './prune'
import { recoverSessions } from './recovery'
import { createRecordingService } from './index'
import type { RecordingService, RecordingSettings } from '../../shared/recording'
import * as disk from './disk'
import { fakeCommand, fakeLiveCommand, makeDeps, sessionDir, tempRoot, waitFor } from './test-support'

const remux = vi.hoisted(() => ({ inputs: [] as string[], fail: false, failAt: 0,
  hold: false, release: null as (() => void) | null, active: 0, maxActive: 0 }))
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawn: (command: string, args: string[], options: any) => {
      if (command !== 'fake-ffmpeg') return actual.spawn(command, args, options)
      const proc = new EventEmitter() as any
      const chunks: Buffer[] = []
      proc.stdout = new PassThrough()
      proc.stderr = new PassThrough()
      proc.kill = () => {}
      proc.stdin = new Writable({
        write(chunk, _encoding, done) {
          chunks.push(Buffer.from(chunk))
          done()
        },
        final(done) {
          remux.inputs.push(Buffer.concat(chunks).toString())
          remux.active++
          remux.maxActive = Math.max(remux.active, remux.maxActive)
          const failed = remux.fail || remux.inputs.length === remux.failAt
          if (!failed) fs.writeFileSync(args.at(-1)!, Buffer.concat(chunks))
          done()
          const finish = () => {
            remux.active--
            proc.emit('close', failed ? 1 : 0)
          }
          if (remux.hold) remux.release = finish
          else setImmediate(finish)
        }
      })
      return proc
    }
  }
})

const roots: string[] = []
const services: RecordingService[] = []
afterEach(async () => {
  remux.hold = false
  remux.release?.()
  remux.release = null
  for (const service of services.splice(0)) await service.stop()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  remux.inputs = []
  remux.fail = false
  remux.failAt = 0
  remux.active = 0
  remux.maxActive = 0
})

const entries = Array.from({ length: 50 }, (_, i) => ({ seq: i + 1, pts: i * 2, dur: 2 }))
const matches = [{ start: 10, end: 18 }, { start: 70, end: 80 }]
const event = (t: number) => ({ id: `a${t}`, t, type: 'knock', score: 1, source: 'auto', counted: true })
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'))

function rig(postAnalysis: 'none' | 'afterExit' | 'perMatch' = 'none') {
  const root = tempRoot()
  roots.push(root)
  const deps = makeDeps(root)
  const dir = sessionDir(root)
  const startedAt = new Date(2026, 9, 18, 12, 34).getTime()
  fs.writeFileSync(path.join(dir, 'recording.json'), JSON.stringify({ startedAt, postAnalysis, mode: 'match' }))
  fs.writeFileSync(path.join(dir, 'init.mp4'), '初始化|')
  for (const entry of entries) fs.writeFileSync(path.join(dir, `seg_${String(entry.seq).padStart(6, '0')}.m4s`), `${entry.pts}|`)
  fs.writeFileSync(path.join(dir, 'index.jsonl'), entries.map((e) => JSON.stringify(e) + '\n').join(''))
  const live = {
    engine_version: '0.3.0', matches, events: [0, 6, 12, 24, 60, 66, 75, 86, 96].map(event),
    spectating: [{ start: 0, end: 7 }, { start: 21, end: 30 }, { start: 60, end: 67 }, { start: 83, end: 96 }],
    quality: { complete: false }, width: 1920, height: 1080
  }
  const saveLive = (value: object) => fs.writeFileSync(path.join(dir, 'live.json'), JSON.stringify(value))
  saveLive(live)
  deps.ffmpegPath = 'fake-ffmpeg'
  deps.addToLibrary = vi.fn()
  deps.enqueueAnalysis = vi.fn()
  deps.onLiveAnalysis = vi.fn()
  deps.liveCachePath = (output) => output + '.aditor.json'
  return { root, dir, deps, live, saveLive, marker: () => read(path.join(dir, 'matches.json')) }
}

describe('per-match segment ranges', () => {
  it('keeps five seconds on each side and strictly excludes segments that only touch a boundary', () => {
    expect(selectMatchEntries(entries, 11, 19)).toEqual(entries.slice(3, 12))
  })

  it.each([[0, 1, 0, 3], [97, 100, 46, 50], [0, 100, 0, 50]])('Clamp range %s–%s to recorded segments', (start, end, first, last) => {
    expect(selectMatchEntries(entries, start, end)).toEqual(entries.slice(first, last))
  })

  it('handles a match contained in one segment, an empty index, and a non-intersecting range', () => {
    const single = [{ seq: 1, pts: 0, dur: 30 }]
    expect(selectMatchEntries(single, 10, 11)).toEqual(single)
    expect(selectMatchEntries([], 10, 11)).toEqual([])
    expect(selectMatchEntries(entries, 120, 130)).toEqual([])
  })
})

describe('per-match clipping and recovery', () => {
  it('names two outputs from segment time, drops lobby footage, and shifts and filters cached events, spectator intervals, and matches', async () => {
    const r = rig()
    const outputs = await finalizeSession(r.dir, r.deps)
    expect(outputs.map((p) => path.basename(p))).toEqual(['Apex_2026-10-18_12-34.mp4', 'Apex_2026-10-18_12-35.mp4'])
    expect(remux.inputs).toEqual([
      '初始化|' + entries.slice(2, 12).map((e) => `${e.pts}|`).join(''),
      '初始化|' + entries.slice(32, 43).map((e) => `${e.pts}|`).join('')
    ])
    const docs = outputs.map((p) => read(r.deps.liveCachePath!(p)))
    expect(docs.map((d) => d.events.map((e: any) => [e.id, e.t]))).toEqual([
      [['a6', 2], ['a12', 8], ['a24', 20]], [['a66', 2], ['a75', 11], ['a86', 22]]
    ])
    expect(docs.map((d) => d.spectating)).toEqual([
      [{ start: 0, end: 3 }, { start: 17, end: 20 }], [{ start: 0, end: 3 }, { start: 19, end: 22 }]
    ])
    expect(docs.map((d) => d.live.matches)).toEqual([[{ start: 6, end: 14 }], [{ start: 6, end: 16 }]])
    expect(r.deps.addToLibrary).toHaveBeenCalledTimes(2)
    expect(r.deps.onLiveAnalysis).toHaveBeenCalledTimes(2)
    expect(r.deps.enqueueAnalysis).not.toHaveBeenCalled()
    expect(fs.existsSync(r.dir)).toBe(false)
  })

  it.each(['missing', 'empty'])('Keep the full recording when no matches exist (%s)', async (kind) => {
    const r = rig()
    if (kind === 'missing') fs.unlinkSync(path.join(r.dir, 'live.json'))
    else r.saveLive({ ...r.live, matches: [] })
    expect(await finalizeSession(r.dir, r.deps)).toHaveLength(1)
    expect(remux.inputs).toEqual(['初始化|' + entries.map((e) => `${e.pts}|`).join('')])
  })

  it('produces no output when live detection stayed healthy but saw no matches (lobby only)', async () => {
    const r = rig()
    r.saveLive({ ...r.live, matches: [] })
    fs.writeFileSync(path.join(r.dir, 'live-complete.json'), '{"version":1}')
    expect(await finalizeSession(r.dir, r.deps)).toEqual([])
    expect(remux.inputs).toEqual([])
    expect(fs.existsSync(r.dir)).toBe(false)
  })

  it('preserves the full recording if live.json is missing after one match was clipped, to avoid losing the rest', async () => {
    const r = rig()
    r.saveLive({ ...r.live, matches: [matches[0]] })
    const [cut] = await cutMatches(r.dir, r.deps)
    fs.unlinkSync(path.join(r.dir, 'live.json'))
    const [whole] = await finalizeSession(r.dir, r.deps)
    expect(whole).not.toBe(cut)
    expect(remux.inputs[1]).toBe('初始化|' + entries.map((e) => `${e.pts}|`).join(''))
    expect(r.deps.addToLibrary).toHaveBeenCalledWith([cut])
  })

  it.each([undefined, 'invalid'])('Treat legacy snapshot mode=%s as full-session mode', async (mode) => {
    const r = rig()
    fs.writeFileSync(path.join(r.dir, 'recording.json'), JSON.stringify({ startedAt: Date.now(), postAnalysis: 'none', mode }))
    expect(await finalizeSession(r.dir, r.deps)).toHaveLength(1)
    expect(remux.inputs).toHaveLength(1)
    expect(remux.inputs[0]).toContain('98|')
  })

  it('closes the final open match during finalization without waiting for the trailing five seconds', async () => {
    const r = rig()
    r.saveLive({ ...r.live, matches: [{ start: 97, end: null }] })
    expect(await cutMatches(r.dir, r.deps)).toEqual([])
    const [output] = await finalizeSession(r.dir, r.deps)
    expect(remux.inputs).toEqual(['初始化|92|94|96|98|'])
    expect(read(r.deps.liveCachePath!(output)).live.matches).toEqual([{ start: 5, end: 8 }])
  })

  it('places per-match outputs in date folders, assigns a match crossing midnight to its start date, and finalizes legacy markers in outputDir', async () => {
    const r = rig()
    const outputs = await finalizeSession(r.dir, r.deps)
    expect(outputs.map((p) => path.dirname(p))).toEqual([path.join(r.root, 'videos', '2026-10-18'), path.join(r.root, 'videos', '2026-10-18')])
    expect(fs.readdirSync(path.join(r.root, 'videos')).filter((p) => p.endsWith('.mp4'))).toEqual([])

    const night = rig()
    const startedAt = new Date(2026, 9, 18, 23, 59, 30).getTime()
    fs.writeFileSync(path.join(night.dir, 'recording.json'), JSON.stringify({ startedAt, postAnalysis: 'none', mode: 'match' }))
    night.saveLive({ ...night.live, matches: [{ start: 10, end: 18 }] })
    const [cut] = await finalizeSession(night.dir, night.deps)
    // The first segment PTS is 10 seconds (earlier with five seconds of preroll), but its start is still at 23:59, so use that date; build the filename from the start time.
    expect(path.dirname(cut)).toBe(path.join(night.root, 'videos', '2026-10-18'))
    expect(path.basename(cut)).toMatch(/^Apex_2026-10-18_23-5\d\.mp4$/)

    const legacy = rig()
    const old = path.join(legacy.root, 'videos', 'Apex_old.mp4')
    fs.mkdirSync(path.dirname(old), { recursive: true }); fs.writeFileSync(old, 'old')
    fs.writeFileSync(path.join(legacy.dir, 'matches.json'), JSON.stringify({ cuts: [{ index: 0, start: 10, end: 18,
      firstSeq: 3, lastSeq: 12, outputPath: old, analysisQueued: false, liveCached: false, liveTrusted: false }] }))
    legacy.saveLive({ ...legacy.live, matches: [{ start: 10, end: 18 }] })
    await finalizeSession(legacy.dir, legacy.deps)
    expect(legacy.deps.addToLibrary).toHaveBeenCalledWith([old])
    expect(fs.existsSync(legacy.dir)).toBe(false)
  })

  it('uses collision suffixes for outputs created in the same minute', async () => {
    const r = rig()
    r.saveLive({ ...r.live, matches: [{ start: 10, end: 18 }, { start: 30, end: 40 }] })
    const outputs = await finalizeSession(r.dir, r.deps)
    expect(outputs[1]).toBe(outputs[0].replace('.mp4', '_2.mp4'))
  })

  it('waits for trailing segments before clipping, clips once available, and does not trust final quality during recording', async () => {
    const r = rig('perMatch')
    r.saveLive({ ...r.live, matches: [matches[0]], quality: { complete: true } })
    const index = path.join(r.dir, 'index.jsonl')
    fs.writeFileSync(index, entries.slice(0, 12).map((e) => JSON.stringify(e) + '\n').join(''))
    expect(await cutMatches(r.dir, r.deps)).toEqual([])
    fs.appendFileSync(index, JSON.stringify(entries[12]) + '\n')
    const [output] = await cutMatches(r.dir, r.deps)
    expect(read(r.deps.liveCachePath!(output)).analysis.engine_version).toBe('live-0.3.0')
    expect(r.marker().cuts[0]).toMatchObject({ index: 0, start: 10, end: 18, firstSeq: 3, lastSeq: 12, outputPath: output,
      analysisQueued: true, liveCached: true, liveTrusted: false })
    expect(r.deps.enqueueAnalysis).toHaveBeenCalledWith(output)
    expect(await cutMatches(r.dir, r.deps)).toEqual([])
    expect(await finalizeSession(r.dir, r.deps)).toEqual([])
    expect(r.deps.enqueueAnalysis).toHaveBeenCalledOnce()
    expect(remux.inputs).toHaveLength(1)
  })

  it('preserves segments after clipping fails and retries during finalization', async () => {
    const r = rig()
    remux.fail = true
    await expect(cutMatches(r.dir, r.deps)).rejects.toThrow('串接失敗')
    expect(fs.existsSync(path.join(r.dir, 'seg_000001.m4s'))).toBe(true)
    remux.fail = false
    expect(await finalizeSession(r.dir, r.deps)).toHaveLength(2)
  })

  it('notifies immediately about a later clipping failure while retaining earlier completed clips', async () => {
    const r = rig()
    remux.failAt = 2
    const saved = vi.fn()
    await expect(cutMatches(r.dir, r.deps, { onCut: saved })).rejects.toThrow('串接失敗')
    expect(saved).toHaveBeenCalledOnce()
    expect(fs.existsSync(saved.mock.calls[0][0])).toBe(true)
    remux.failAt = 0
    expect(await finalizeSession(r.dir, r.deps)).toHaveLength(1)
  })

  it('does not leave a final video when marker writing fails and avoids duplicate names on retry', async () => {
    const r = rig()
    const rename = fs.promises.rename.bind(fs.promises)
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('matches.json')) throw new Error('模擬 marker 寫入失敗')
      await rename(from, to)
    })
    await expect(cutMatches(r.dir, r.deps)).rejects.toThrow('marker')
    expect(fs.readdirSync(path.join(r.root, 'videos', '2026-10-18')).filter((p) => p.endsWith('.mp4'))).toEqual([])
    spy.mockRestore()
    expect((await finalizeSession(r.dir, r.deps)).map((p) => path.basename(p)))
      .toEqual(['Apex_2026-10-18_12-34.mp4', 'Apex_2026-10-18_12-35.mp4'])
  })

  it('removes the temporary file and avoids duplicate output when interrupted after concatenation but before marker write', async () => {
    const r = rig()
    const output = path.join(r.root, 'videos', '2026-10-18', 'Apex_2026-10-18_12-34.mp4')
    fs.mkdirSync(path.dirname(output), { recursive: true })
    const part = output.replace('.mp4', '.part.mp4')
    fs.writeFileSync(part, '尚未登記的剪檔')
    fs.writeFileSync(path.join(r.dir, 'match-part.json'), JSON.stringify({ output, part }))
    expect(await finalizeSession(r.dir, r.deps)).toHaveLength(2)
    expect(fs.existsSync(part)).toBe(false)
    expect(fs.readdirSync(path.dirname(output)).filter((p) => p.endsWith('.mp4'))).toHaveLength(2)
    expect(remux.inputs).toHaveLength(2)
  })

  it('writes the marker before rename and side effects, and reuses the concatenated file after an interrupted rename', async () => {
    const r = rig()
    const rename = fs.promises.rename.bind(fs.promises)
    let interrupted = false
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(from).endsWith('.part.mp4') && !interrupted) {
        interrupted = true
        expect(r.marker().cuts).toHaveLength(1)
        expect(r.deps.addToLibrary).not.toHaveBeenCalled()
        throw new Error('模擬改名時中斷')
      }
      await rename(from, to)
    })
    await expect(finalizeSession(r.dir, r.deps)).rejects.toThrow('中斷')
    const outputs = await finalizeSession(r.dir, r.deps)
    expect(outputs).toHaveLength(1)
    expect(remux.inputs).toHaveLength(2)
    expect(r.deps.addToLibrary).toHaveBeenCalledTimes(2)
  })

  it('final trusted results rewrite their own live cache, skip afterExit, and add all existing clips', async () => {
    const r = rig('afterExit')
    const outputs = await cutMatches(r.dir, r.deps)
    expect(r.deps.enqueueAnalysis).not.toHaveBeenCalled()
    r.saveLive({ ...r.live, quality: { complete: true, hScale: 1.05 } })
    r.deps.addToLibrary = vi.fn()
    const rm = vi.spyOn(fs.promises, 'rm').mockRejectedValueOnce(new Error('保留 marker 供檢查'))
    await expect(finalizeSession(r.dir, r.deps)).rejects.toThrow('供檢查')
    for (const output of outputs) {
      expect(read(r.deps.liveCachePath!(output)).analysis).toMatchObject({ source: 'live', engine_version: '0.3.0', h_scale: 1.05 })
      expect(r.deps.addToLibrary).toHaveBeenCalledWith([output])
    }
    expect(r.marker().cuts.every((c: any) => c.liveTrusted)).toBe(true)
    expect(r.deps.enqueueAnalysis).not.toHaveBeenCalled()
    rm.mockRestore()
    expect(await finalizeSession(r.dir, r.deps)).toEqual([])
  })

  it('does not overwrite a full analysis cache with final trusted results', async () => {
    const r = rig('afterExit')
    const outputs = await cutMatches(r.dir, r.deps)
    const full = JSON.stringify({ analysis: { source: 'full', engine_version: '0.3.0' }, events: [event(3)] })
    fs.writeFileSync(r.deps.liveCachePath!(outputs[0]), full)
    r.saveLive({ ...r.live, quality: { complete: true } })
    await finalizeSession(r.dir, r.deps)
    expect(fs.readFileSync(r.deps.liveCachePath!(outputs[0]), 'utf8')).toBe(full)
    expect(r.deps.enqueueAnalysis).not.toHaveBeenCalled()
  })

  it.each(['afterExit', 'perMatch'] as const)('Queue each untrusted %s result once per match; retries do not re-notify for old cuts', async (postAnalysis) => {
    const r = rig(postAnalysis)
    const outputs = await cutMatches(r.dir, r.deps)
    expect(r.deps.enqueueAnalysis).toHaveBeenCalledTimes(postAnalysis === 'perMatch' ? 2 : 0)
    vi.spyOn(fs.promises, 'rm').mockRejectedValueOnce(new Error('模擬刪除前中斷'))
    await expect(finalizeSession(r.dir, r.deps)).rejects.toThrow('中斷')
    expect(await finalizeSession(r.dir, r.deps)).toEqual([])
    expect(r.deps.enqueueAnalysis).toHaveBeenCalledTimes(2)
    for (const output of outputs) expect(r.deps.enqueueAnalysis).toHaveBeenCalledWith(output)
    expect(remux.inputs).toHaveLength(2)
  })
})

describe('per-match recording service', () => {
  function serviceRig(liveMode = 'closed-match', tailSegments = 2) {
    const r = rig('perMatch')
    fs.rmSync(r.dir, { recursive: true })
    const source = path.join(r.root, 'segments')
    fs.mkdirSync(source)
    fs.copyFileSync(path.join(__dirname, '__fixtures__', 'init-h264.mp4'), path.join(source, 'init.mp4'))
    const gate = path.join(r.root, 'post-pad-ready')
    const trace = path.join(r.root, 'recorder.jsonl')
    const settings: RecordingSettings = { ...r.deps.getSettings(), mode: 'match', postAnalysis: 'perMatch' }
    r.deps.getSettings = () => settings
    r.deps.notify = vi.fn()
    r.deps.recorderCommand = fakeCommand('match', { FAKE_SEGMENT_DIR: source, FAKE_POST_PAD_GATE: gate,
      FAKE_RECORDER_TRACE: trace, FAKE_TAIL_SEGMENTS: String(tailSegments) })
    r.deps.liveEngineCommand = fakeLiveCommand(liveMode)
    vi.spyOn(disk, 'diskFreeBytes').mockResolvedValue(100 * 1024 ** 3)
    const service = createRecordingService(r.deps)
    services.push(service)
    const finalized = vi.fn()
    service.onFinalized(finalized)
    service.start()
    return { ...r, service, finalized, settings, gate, trace }
  }

  it('waits for trailing segments after a match closes before clipping, while recording and playback continue without restarts or duplicate notices', async () => {
    const r = serviceRig()
    const { service, finalized } = r
    await waitFor(() => service.status().matchIndex === 1)
    await waitFor(() => service.status().durationSec === 8)
    const before = (await service.live!())!
    expect(before.matches).toEqual([{ start: 0.5, end: 3 }])
    expect(finalized).not.toHaveBeenCalled()
    const dir = path.join(r.deps.defaultOutputDir, '.sessions', before.sessionId)
    expect(read(path.join(dir, 'recording.json')).mode).toBe('match')
    r.settings.mode = 'session'
    r.settings.postAnalysis = 'none'
    fs.writeFileSync(r.gate, '')
    await waitFor(() => finalized.mock.calls.length === 1)
    expect(service.status().phase).toBe('recording')
    expect((await service.live!())!.sessionId).toBe(before.sessionId)
    expect((await service.live!())!.segments).toHaveLength(6)
    expect(r.deps.enqueueAnalysis).toHaveBeenCalledOnce()
    await service.stopManual()
    expect(finalized).toHaveBeenCalledOnce()
    expect(remux.inputs).toHaveLength(1)
    expect(fs.readFileSync(r.trace, 'utf8').split('\n').filter((line) => line && JSON.parse(line).cmd === 'start')).toHaveLength(1)
  })

  it('keeps segments and events flowing during slow clipping and runs ffmpeg serially across two matches', async () => {
    const r = serviceRig('two-matches', 3)
    await waitFor(() => r.service.status().matchIndex === 2)
    remux.hold = true
    fs.writeFileSync(r.gate, '')
    await waitFor(() => remux.release !== null)
    await waitFor(() => r.service.status().segments === 7)
    expect(r.service.status().phase).toBe('recording')
    expect((await r.service.live!())!.matches).toHaveLength(2)
    expect(remux.inputs).toHaveLength(1)
    remux.hold = false
    remux.release!()
    remux.release = null
    await waitFor(() => r.finalized.mock.calls.length === 2)
    expect(remux.inputs).toHaveLength(2)
    expect(remux.maxActive).toBe(1)
    await r.service.stopManual()
    expect(r.finalized).toHaveBeenCalledTimes(2)
  })

  it('notifies about clipping failure during recording, keeps recording, and succeeds on retry after stop', async () => {
    const r = serviceRig()
    await waitFor(() => r.service.status().matchIndex === 1)
    remux.fail = true
    fs.writeFileSync(r.gate, '')
    await waitFor(() => vi.mocked(r.deps.notify).mock.calls.some(([kind, message]) => kind === 'error' && message.includes('逐局剪檔失敗')))
    expect(r.service.status().phase).toBe('recording')
    expect(r.finalized).not.toHaveBeenCalled()
    remux.fail = false
    await r.service.stopManual()
    expect(r.service.status().phase).toBe('idle')
    expect(r.finalized).toHaveBeenCalledOnce()
    expect(r.deps.enqueueAnalysis).toHaveBeenCalledOnce()
  })

  it('does not delay later matches when one clip fails and retries the failed match only during finalization', async () => {
    const r = serviceRig('two-matches', 3)
    await waitFor(() => r.service.status().matchIndex === 2)
    remux.failAt = 1
    fs.writeFileSync(r.gate, '')
    await waitFor(() => r.finalized.mock.calls.length === 1)
    expect(r.service.status().phase).toBe('recording')
    expect(remux.inputs).toHaveLength(2)
    expect(r.deps.enqueueAnalysis).toHaveBeenCalledOnce()
    await r.service.stopManual()
    expect(remux.inputs).toHaveLength(3)
    expect(r.finalized).toHaveBeenCalledTimes(2)
    expect(r.deps.enqueueAnalysis).toHaveBeenCalledTimes(2)
  })
})

it('recovers matches and preserves countdowns after cleanup, and produces no output when there are no matches', async () => {
  const r = rig()
  await pruneSegments(r.dir, entries, matches, null)
  const done = vi.fn(); const failed = vi.fn()
  await recoverSessions(r.deps, done, failed)
  expect(failed).not.toHaveBeenCalled()
  expect(remux.inputs[0]).toBe('初始化|' + entries.slice(2, 12).map(e => `${e.pts}|`).join(''))
  expect(fs.existsSync(r.dir)).toBe(false)
  const empty = rig()
  empty.saveLive({ ...empty.live, matches: [] })
  await pruneSegments(empty.dir, entries, [], null)
  const count = remux.inputs.length
  await recoverSessions(empty.deps, vi.fn(), failed)
  expect(failed).not.toHaveBeenCalled()
  expect(remux.inputs).toHaveLength(count)
  expect(fs.existsSync(empty.dir)).toBe(false)
})
it('reports a clear failure and preserves the session when a required clipping segment is missing', async () => {
  const r = rig()
  fs.unlinkSync(path.join(r.dir, 'seg_000005.m4s'))
  await expect(finalizeSession(r.dir, r.deps)).rejects.toThrow()
  expect(fs.existsSync(r.dir)).toBe(true)
  expect(remux.inputs).toEqual([])
})

it.each([{ backend: 'builtin', mode: 'session' }, { backend: 'obs', mode: 'match' }])('Do not queue pruning for other modes: %j', async ({ backend, mode }) => {
  const r = rig()
  const service = new RecordingSessionService(r.deps) as any
  const session = { backend, mode, ending: false, live: { prune: vi.fn() }, cuts: Promise.resolve() }
  service.scheduleCuts(session)
  await session.cuts
  expect(session.live.prune).not.toHaveBeenCalled()
})
