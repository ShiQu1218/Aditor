import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import { applyMatchEvent, countKills, LiveSession } from './live-session'
import { createRecordingService, type RecordingDeps } from './index'
import type { LiveEvent, LiveUpdate, RecordingService } from '../../shared/recording'
import * as disk from './disk'
import { fakeCommand, fakeLiveCommand, makeDeps, sessionDir, tempRoot, waitFor } from './test-support'

it('rejects failed live writes without marking detection complete, then permits a persisted retry', async () => {
  const dir = sessionDir(root())
  const live = new LiveSession({ sessionId: 'write-error', dir, profileDir: dir, recordEvent: vi.fn(), notice: vi.fn() })
  const engine = Object.assign(new EventEmitter(), {
    stop: vi.fn(async () => {}), engineVersion: () => '0.3.0', quality: () => ({ complete: true })
  })
  const internal = live as any
  internal.engine = engine
  internal.listen(engine)
  engine.emit('progress', 10)
  fs.writeFileSync(path.join(dir, 'live.json'), JSON.stringify({ matches: [] }))
  fs.writeFileSync(path.join(dir, 'seg_000001.m4s'), 'keep')
  const rename = fs.promises.rename.bind(fs.promises)
  const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
    if (String(to).endsWith('live.json')) throw new Error('file busy')
    return rename(from, to)
  })
  internal.onMatch({ ev: 'match_start', t: 0, reason: 'initial_match' })
  await expect(live.flush()).rejects.toThrow('file busy')
  await expect(live.stop()).rejects.toThrow('file busy')
  expect(fs.existsSync(path.join(dir, 'live-complete.json'))).toBe(false)
  expect(fs.existsSync(path.join(dir, 'seg_000001.m4s'))).toBe(true)
  spy.mockRestore()
  engine.emit('snapshot', { t: 10, events: [], spectating: [] })
  await live.stop()
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'live.json'), 'utf8')).matches).toEqual([{ start: 0, end: null }])
  expect(fs.existsSync(path.join(dir, 'live-complete.json'))).toBe(true)
})

const roots: string[] = []
const services: RecordingService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})
function root(): string { const value = tempRoot(); roots.push(value); return value }
const ev = (id: string, t: number, type = 'knock', counted = true): LiveEvent => ({ id, t, type, score: 1, damage_line: false,
  name_sig: null, counted, counted_reason: counted ? 'first' : 'duplicate', counted_override: null, source: 'auto' })
const initFixture = path.join(__dirname, '__fixtures__', 'init-hevc.mp4')

describe('matches and kills', () => {
  it('handles match start, a directly queued next match, and match end, while ignoring an end without a start', () => {
    let matches = applyMatchEvent([], { ev: 'match_end', t: 5, reason: 'lobby' })
    expect(matches).toEqual([])
    matches = applyMatchEvent(matches, { ev: 'match_start', t: 10, reason: 'countdown' })
    matches = applyMatchEvent(matches, { ev: 'match_start', t: 300, reason: 'countdown' })
    expect(matches).toEqual([{ start: 10, end: 300 }, { start: 300, end: null }])
    matches = applyMatchEvent(matches, { ev: 'match_end', t: 500, reason: 'lobby' })
    expect(matches).toEqual([{ start: 10, end: 300 }, { start: 300, end: 500 }])
  })

  it('counts only this match’s knocks and kills, excluding manual cancellations and assists', () => {
    const events = [ev('a', 5), ev('b', 20, 'elim'), ev('c', 21, 'assist_knock'), ev('d', 22, 'knock', false),
      { ...ev('e', 23), counted_override: false }, ev('f', 400)]
    expect(countKills(events, [])).toBe(3)
    expect(countKills(events, [{ start: 10, end: 300 }])).toBe(1)
    expect(countKills(events, [{ start: 10, end: 300 }, { start: 350, end: null }])).toBe(1)
  })

  it.each(['initial_match', 'initial_summary'])('Recovery event %s continues the unfinished match while allowing a new match to resume', (reason) => {
    const matches = [{ start: 10, end: null }]
    expect(applyMatchEvent(matches, { ev: 'match_start', t: 100, reason })).toBe(matches)
    expect(applyMatchEvent([], { ev: 'match_start', t: 100, reason })).toEqual([{ start: 100, end: null }])
    expect(applyMatchEvent([{ start: 10, end: 90 }], { ev: 'match_start', t: 100, reason }))
      .toEqual([{ start: 10, end: 90 }, { start: 100, end: null }])
  })
})

it('does not duplicate a match start after the engine restarts mid-match and keeps match state aligned with disk records', async () => {
  const dir = root()
  const recordEvent = vi.fn()
  const live = new LiveSession({ sessionId: 'restart', dir, profileDir: dir, recordEvent, notice: vi.fn(),
    command: fakeLiveCommand('crash-match-once', { FAKE_LIVE_STATE: path.join(dir, 'state') }), restartBaseMs: 10 })
  const listener = vi.fn()
  live.on('match', listener)
  live.startEngine('Local\\fake', 1920, 1080)
  try {
    await waitFor(() => live.kills() === 2)
    expect((await live.state()).matches).toEqual([{ start: 0.5, end: null }])
    expect(listener.mock.calls.filter(([ev]) => ev === 'match_start')).toHaveLength(1)
    expect(recordEvent.mock.calls.filter(([event]) => event.ev === 'match_start')).toHaveLength(1)
  } finally {
    await live.stop()
  }
  expect((await live.state()).matches).toEqual([{ start: 0.5, end: 3.5 }])
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'live.json'), 'utf8')).matches).toEqual([{ start: 0.5, end: 3.5 }])
})

it('keeps a match the game client reported before capture started, opening it at time 0', async () => {
  const dir = root()
  const live = new LiveSession({ sessionId: 'early', dir, profileDir: dir, recordEvent: vi.fn(), notice: vi.fn() })
  live.clientMatch('match_start', Date.now() - 5000)
  live.startEngine('Local\\x', 1920, 1080)
  expect((await live.state()).matches).toEqual([{ start: 0, end: null }])

  const ended = new LiveSession({ sessionId: 'ended', dir, profileDir: dir, recordEvent: vi.fn(), notice: vi.fn() })
  ended.clientMatch('match_start', Date.now() - 9000)
  ended.clientMatch('match_end', Date.now() - 5000)
  ended.startEngine('Local\\x', 1920, 1080)
  expect((await ended.state()).matches).toEqual([])
})

describe('LiveSession file reads', () => {
  function session(dir: string): LiveSession {
    return new LiveSession({ sessionId: '20261018-123456-abcd', dir, profileDir: dir, recordEvent: vi.fn(), notice: vi.fn() })
  }

  it('parses init.mp4 as MIME and requires segments to be indexed regular files inside the session directory', async () => {
    const dir = root()
    const live = session(dir)
    expect((await live.state()).mime).toBeNull()
    fs.copyFileSync(initFixture, path.join(dir, 'init.mp4'))
    fs.writeFileSync(path.join(dir, 'seg_000001.m4s'), 'one')
    fs.writeFileSync(path.join(dir, 'seg_000002.m4s'), 'two')
    live.addSegment({ seq: 1, pts: 0, dur: 2 })
    live.addSegment({ seq: 1, pts: 0, dur: 2 })
    const state = await live.state()
    expect(state.mime).toBe('video/mp4; codecs="hev1.1.6.L90.90, mp4a.40.2"')
    expect(state.segments).toEqual([{ seq: 1, pts: 0, dur: 2 }])
    expect(Buffer.from(await live.readSegment(1)).toString()).toBe('one')
    expect((await live.readInit()).byteLength).toBe(fs.statSync(initFixture).size)
    await expect(live.readSegment(2)).rejects.toThrow('索引')
    await expect(live.readSegment(1.5)).rejects.toThrow('索引')
    fs.mkdirSync(path.join(dir, 'seg_000003.m4s'))
    live.addSegment({ seq: 3, pts: 4, dur: 2 })
    await expect(live.readSegment(3)).rejects.toThrow('一般檔案')
  })

  it('notifies once and does not start when the live engine executable cannot be found', () => {
    const dir = root()
    const notice = vi.fn()
    const live = new LiveSession({ sessionId: 'x', dir, profileDir: dir, recordEvent: vi.fn(), notice,
      command: { command: path.join(dir, 'missing', 'aditor.exe'), args: [] } })
    live.startEngine('Local\\x', 1920, 1080)
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('找不到即時偵測引擎'))
  })
})

describe('recording service integration with the live engine', () => {
  function rig(): { root: string; deps: RecordingDeps; service: RecordingService; trace: string; pid: { value: number | null } } {
    const base = root()
    const deps = makeDeps(base)
    const segments = path.join(base, 'segs')
    fs.mkdirSync(segments)
    fs.copyFileSync(initFixture, path.join(segments, 'init.mp4'))
    fs.writeFileSync(path.join(segments, 'seg_000001.m4s'), 'segment-1')
    const trace = path.join(base, 'live-trace.jsonl')
    deps.recorderCommand = fakeCommand('normal', { FAKE_SEGMENT_DIR: segments })
    deps.liveEngineCommand = fakeLiveCommand('normal', { FAKE_LIVE_TRACE: trace })
    deps.sceneDir = path.join(base, 'scene')
    deps.readGameAspect = vi.fn(async () => '1920x1440')
    deps.notify = vi.fn()
    const pid = { value: 1234 as number | null }
    deps.findApexPid = vi.fn(async () => pid.value)
    vi.spyOn(disk, 'diskFreeBytes').mockResolvedValue(100 * 1024 ** 3)
    const service = createRecordingService(deps)
    services.push(service)
    return { root: base, deps, service, trace, pid }
  }

  it('starts the live engine after started, includes kills and match count in status, publishes segments/events/matches, and waits for the final snapshot on stop', async () => {
    const r = rig()
    const updates: LiveUpdate[] = []
    r.service.onLive!((update) => updates.push(update))
    r.service.start()
    await waitFor(() => r.service.status().kills === 1 && r.service.status().matchIndex === 1)
    const status = r.service.status()
    const live = (await r.service.live!())!
    expect(live.sessionId).toBe(status.sessionId)
    expect(live.mime).toContain('hev1')
    expect(live.segments).toEqual([{ seq: 1, pts: 0, dur: 2 }, { seq: 2, pts: 2, dur: 2 }])
    expect(live.events.map((e) => e.id)).toEqual(['a1000'])
    expect(live.matches).toEqual([{ start: 0.5, end: null }])
    expect(updates.some((u) => u.segment?.seq === 2)).toBe(true)
    expect(updates.some((u) => u.match?.index === 1)).toBe(true)
    expect(Buffer.from(await r.service.readSegment!(status.sessionId!, 1)).toString()).toBe('segment-1')
    await expect(r.service.readSegment!('20990101-000000-ffff', 1)).rejects.toThrow('不存在')
    const argv = JSON.parse(fs.readFileSync(r.trace, 'utf8').split('\n')[0]).argv
    expect(argv).toEqual(['--shm', 'Local\\fake', '--profile-dir', r.deps.profileDir, '--scene-dir', r.deps.sceneDir, '--aspect', '1920x1440'])
    const sessionDir = path.join(r.deps.defaultOutputDir, '.sessions', status.sessionId!)
    expect(JSON.parse(fs.readFileSync(path.join(sessionDir, 'recording.json'), 'utf8')).gameAspect).toBe('1920x1440')
    await waitFor(() => fs.existsSync(path.join(sessionDir, 'live.json')))
    expect(fs.readFileSync(path.join(sessionDir, 'events.jsonl'), 'utf8')).toContain('"ev":"match_start"')
    expect(r.deps.notify).toHaveBeenCalledWith('matchStart', '第 1 局開始')

    // This fixture only serves the live read above; it is not a finalized, indexed recording.
    fs.unlinkSync(path.join(sessionDir, 'seg_000001.m4s'))
    // Read the final live.json before finalization to prevent the work directory from being deleted.
    const rm = vi.spyOn(fs.promises, 'rm')
    let finalLive: Record<string, any> | null = null
    let finalEvents = ''
    rm.mockImplementation(async (target) => {
      finalLive = JSON.parse(fs.readFileSync(path.join(String(target), 'live.json'), 'utf8'))
      finalEvents = fs.readFileSync(path.join(String(target), 'events.jsonl'), 'utf8')
    })
    r.pid.value = null
    await waitFor(() => r.service.status().phase === 'idle')
    expect(fs.readFileSync(r.trace, 'utf8')).toContain('"stop":true')
    expect(finalLive!.events.map((e: LiveEvent) => e.id)).toEqual(['a1000', 'a3500'])
    expect(finalLive!.matches).toEqual([{ start: 0.5, end: 3.5 }])
    expect(finalLive!.engine_version).toBe('0.3.0')
    expect(finalEvents).toContain('"ev":"match_end"')
    expect(r.service.status()).toMatchObject({ kills: 0, matchIndex: null })
    expect(updates.at(-1)).toEqual({ sessionId: status.sessionId, finalized: [] })
    expect(await r.service.live!()).toBeNull()
  })
})

it('records and forwards countdown and cancellation events without changing confirmed matches or kills', async () => {
  const dir = root()
  const recordEvent = vi.fn()
  const live = new LiveSession({ sessionId: 'pending', dir, profileDir: dir, recordEvent, notice: vi.fn() })
  const listener = vi.fn()
  live.on('match', listener)
  ;(live as any).onMatch({ ev: 'match_start', t: 0, reason: 'initial_match' })
  const matches = (await live.state()).matches
  for (const ev of ['match_pending', 'match_cancel'] as const) {
    const event = { ev, t: 5, reason: '測試' }
    expect(applyMatchEvent(matches, event)).toBe(matches)
    ;(live as any).onMatch(event)
    expect(recordEvent).toHaveBeenLastCalledWith(event)
    expect(listener).toHaveBeenLastCalledWith(ev, 2, 5)
  }
  await live.flush()
  expect((await live.state()).matches).toEqual(matches)
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'live.json'), 'utf8')).matches).toEqual(matches)
})

it.each([false, true])('clamps late starts only after segments have been pruned (%s)', async (pruneFirst) => {
  const dir = sessionDir(root())
  const recordEvent = vi.fn()
  const notice = vi.fn()
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const live = new LiveSession({ sessionId: 'late-start', dir, profileDir: dir, recordEvent, notice })
  for (let i = 1; i <= 30; i++) {
    fs.writeFileSync(path.join(dir, `seg_${String(i).padStart(6, '0')}.m4s`), 'segment')
    live.addSegment({ seq: i, pts: (i - 1) * 2 + (pruneFirst ? 0 : 12), dur: 2 })
  }
  const internal = live as any
  internal.engine = { engineVersion: () => null, quality: () => null }
  internal.onProgress(pruneFirst ? 60 : 10)
  await live.prune()
  if (pruneFirst) expect(JSON.parse(fs.readFileSync(path.join(dir, 'live.json'), 'utf8')).retained_from).toBe(42)
  const event = { ev: 'match_start', t: 0, reason: 'initial_match' }
  internal.onMatch(event)
  await live.flush()
  const start = pruneFirst ? 42 : 0
  expect((await live.state()).matches).toEqual([{ start, end: null }])
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'live.json'), 'utf8'))
  expect(stored.matches).toEqual([{ start, end: null }])
  expect(stored.retained_from).toBe(pruneFirst ? 42 : undefined)
  expect(recordEvent).toHaveBeenLastCalledWith({ ...event, t: start })
  expect(event.t).toBe(0)
  internal.onMatch(event)
  expect(log).toHaveBeenCalledTimes(pruneFirst ? 1 : 0)
  expect(notice).not.toHaveBeenCalled()
})

it('skips cleanup before startup, before the first snapshot, during restart waits, and after failure; removes the playback list and publishes updates when healthy', async () => {
  const dir = sessionDir(root())
  const live = new LiveSession({ sessionId: '清理', dir, profileDir: dir, recordEvent: vi.fn(), notice: vi.fn() })
  for (let i = 1; i <= 30; i++) {
    fs.writeFileSync(path.join(dir, `seg_${String(i).padStart(6, '0')}.m4s`), '片段')
    live.addSegment({ seq: i, pts: (i - 1) * 2, dur: 2 })
  }
  const internal = live as any
  await live.prune()
  expect(live.hasSegment(1)).toBe(true)
  internal.engine = { engineVersion: () => null, quality: () => null }
  await live.prune()
  expect(live.hasSegment(1)).toBe(true)
  internal.onSnapshot({ t: 60, events: [], spectating: [] })
  internal.restartedAt = Date.now()
  await live.prune()
  expect(live.hasSegment(1)).toBe(true)
  internal.restartedAt = Date.now() - 31_000
  const update = vi.fn(); live.on('update', update)
  await live.prune()
  expect(live.hasSegment(1)).toBe(false)
  await expect(live.readSegment(1)).rejects.toThrow('索引')
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ segments: expect.any(Array) }))
  internal.failed = true
  live.addSegment({ seq: 31, pts: 100, dur: 2 })
  await live.prune()
  expect(live.hasSegment(22)).toBe(true)
  await live.flush()
})

it('keeps segments protected through the delay after countdown confirmation and unprotects them after cancellation', async () => {
  const dir = sessionDir(root())
  const live = new LiveSession({ sessionId: '倒數', dir, profileDir: dir, recordEvent: vi.fn(), notice: vi.fn() })
  const internal = live as any
  internal.engine = { engineVersion: () => null, quality: () => null }
  internal.onSnapshot({ t: 1000, events: [], spectating: [] })
  const add = (from: number, to: number) => {
    for (let i = from; i <= to; i++) {
      fs.writeFileSync(path.join(dir, `seg_${String(i).padStart(6, '0')}.m4s`), '片段')
      live.addSegment({ seq: i, pts: (i - 1) * 2, dur: 2 })
    }
  }
  add(1, 15)
  internal.onMatch({ ev: 'match_pending', t: 24, reason: '倒數' })
  await live.prune()
  expect(live.hasSegment(10)).toBe(true)
  internal.onMatch({ ev: 'match_start', t: 24, reason: '倒數確認' })
  add(16, 50)
  await live.prune()
  expect(live.hasSegment(23)).toBe(true)
  internal.onMatch({ ev: 'match_end', t: 40, reason: '大廳延遲確認' })
  await live.prune()
  expect(live.hasSegment(23)).toBe(true)
  expect(live.hasSegment(24)).toBe(false)
  internal.onMatch({ ev: 'match_pending', t: 94, reason: '倒數' })
  add(51, 70)
  await live.prune()
  expect(live.hasSegment(45)).toBe(true)
  internal.onMatch({ ev: 'match_cancel', t: 140, reason: '取消' })
  await live.prune()
  expect(live.hasSegment(45)).toBe(false)
  expect(live.hasSegment(10)).toBe(true)
  await live.flush()
})

it('treats processed frames as healthy in a lobby with no kill snapshots, cleans up only through analyzed time', async () => {
  const dir = sessionDir(root())
  const live = new LiveSession({ sessionId: '大廳', dir, profileDir: dir, recordEvent: vi.fn(), notice: vi.fn() })
  for (let i = 1; i <= 60; i++) {
    fs.writeFileSync(path.join(dir, `seg_${String(i).padStart(6, '0')}.m4s`), '片段')
    live.addSegment({ seq: i, pts: (i - 1) * 2, dur: 2 })
  }
  const internal = live as any
  const engine = Object.assign(new EventEmitter(), { engineVersion: () => null, quality: () => null })
  internal.engine = engine
  internal.listen(engine)
  await live.prune()
  expect(live.hasSegment(1)).toBe(true)
  engine.emit('progress', 60)
  await live.prune()
  expect(live.hasSegment(22)).toBe(false)
  expect(live.hasSegment(23)).toBe(true)
  engine.emit('progress', 120)
  await live.prune()
  expect(live.hasSegment(51)).toBe(false)
  expect(live.hasSegment(52)).toBe(true)
  await live.flush()
})

it('marks detection as healthy throughout only when live detection is healthy at stop, not when unstarted, failed, restarting, killed without a final snapshot, or lossy', async () => {
  const marker = (dir: string) => fs.existsSync(path.join(dir, 'live-complete.json'))
  const make = () => {
    const dir = sessionDir(root())
    const live = new LiveSession({ sessionId: '標記', dir, profileDir: dir, recordEvent: vi.fn(), notice: vi.fn() })
    const engine = Object.assign(new EventEmitter(), { stop: vi.fn(async () => {}), quality: vi.fn((): unknown => ({ complete: true, reasons: [] })) })
    return { dir, live, engine, internal: live as any }
  }
  const never = make()
  await never.live.stop()
  expect(marker(never.dir)).toBe(false)
  const ok = make()
  ok.internal.engine = ok.engine; ok.internal.listen(ok.engine)
  ok.engine.emit('progress', 10)
  await ok.live.stop()
  expect(marker(ok.dir)).toBe(true)
  const failed = make()
  failed.internal.engine = failed.engine; failed.internal.listen(failed.engine)
  failed.engine.emit('progress', 10)
  failed.engine.emit('failed', new Error('壞了'))
  await failed.live.stop()
  expect(marker(failed.dir)).toBe(false)
  const restarting = make()
  restarting.internal.engine = restarting.engine; restarting.internal.listen(restarting.engine)
  restarting.engine.emit('progress', 10)
  restarting.engine.emit('restarting', { message: '重啟' })
  await restarting.live.stop()
  expect(marker(restarting.dir)).toBe(false)
  // Killed after the stop timeout: no final snapshot, so healthy progress alone is not proof that no match was missed.
  const killed = make()
  killed.internal.engine = killed.engine; killed.internal.listen(killed.engine)
  killed.engine.emit('progress', 10)
  killed.engine.quality.mockReturnValue(null)
  await killed.live.stop()
  expect(marker(killed.dir)).toBe(false)
  const lossy = make()
  lossy.internal.engine = lossy.engine; lossy.internal.listen(lossy.engine)
  lossy.engine.emit('progress', 10)
  lossy.engine.quality.mockReturnValue({ complete: false, reasons: ['frames_lost'] })
  await lossy.live.stop()
  expect(marker(lossy.dir)).toBe(false)
  // External match boundaries (the Riot Client) dropped out, so a match may have been missed.
  const distrusted = make()
  distrusted.internal.engine = distrusted.engine; distrusted.internal.listen(distrusted.engine)
  distrusted.engine.emit('progress', 10)
  distrusted.live.distrust()
  await distrusted.live.stop()
  expect(marker(distrusted.dir)).toBe(false)
})
