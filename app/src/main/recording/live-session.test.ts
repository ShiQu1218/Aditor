import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { applyMatchEvent, countKills, LiveSession } from './live-session'
import { createRecordingService, type RecordingDeps } from './index'
import type { LiveEvent, LiveUpdate, RecordingService } from '../../shared/recording'
import * as disk from './disk'
import { fakeCommand, fakeLiveCommand, makeDeps, tempRoot, waitFor } from './test-support'

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

describe('對局與擊殺', () => {
  it('開局、直接排下一場、結束；沒有開局的結束忽略', () => {
    let matches = applyMatchEvent([], { ev: 'match_end', t: 5, reason: 'lobby' })
    expect(matches).toEqual([])
    matches = applyMatchEvent(matches, { ev: 'match_start', t: 10, reason: 'countdown' })
    matches = applyMatchEvent(matches, { ev: 'match_start', t: 300, reason: 'countdown' })
    expect(matches).toEqual([{ start: 10, end: 300 }, { start: 300, end: null }])
    matches = applyMatchEvent(matches, { ev: 'match_end', t: 500, reason: 'lobby' })
    expect(matches).toEqual([{ start: 10, end: 300 }, { start: 300, end: 500 }])
  })

  it('只計本局計入的擊倒與消滅；手動取消計入與助攻不算', () => {
    const events = [ev('a', 5), ev('b', 20, 'elim'), ev('c', 21, 'assist_knock'), ev('d', 22, 'knock', false),
      { ...ev('e', 23), counted_override: false }, ev('f', 400)]
    expect(countKills(events, [])).toBe(3)
    expect(countKills(events, [{ start: 10, end: 300 }])).toBe(1)
    expect(countKills(events, [{ start: 10, end: 300 }, { start: 350, end: null }])).toBe(1)
  })
})

describe('LiveSession 檔案讀取', () => {
  function session(dir: string): LiveSession {
    return new LiveSession({ sessionId: '20261018-123456-abcd', dir, profileDir: dir, recordEvent: vi.fn(), notice: vi.fn() })
  }

  it('init.mp4 解析成 MIME；段落必須在索引中且是工作目錄內的一般檔案', async () => {
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

  it('找不到 live 引擎執行檔時只通知一次，不啟動', () => {
    const dir = root()
    const notice = vi.fn()
    const live = new LiveSession({ sessionId: 'x', dir, profileDir: dir, recordEvent: vi.fn(), notice,
      command: { command: path.join(dir, 'missing', 'python.exe'), args: [] } })
    live.startEngine('Local\\x', 1920, 1080)
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('找不到即時偵測引擎'))
  })
})

describe('錄影服務整合 live 引擎', () => {
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
    deps.notify = vi.fn()
    const pid = { value: 1234 as number | null }
    deps.findApexPid = vi.fn(async () => pid.value)
    vi.spyOn(disk, 'diskFreeBytes').mockResolvedValue(100 * 1024 ** 3)
    const service = createRecordingService(deps)
    services.push(service)
    return { root: base, deps, service, trace, pid }
  }

  it('started 後啟動 live 引擎；狀態帶擊殺與局數，推播段落／事件／對局，停止時等最終快照並收尾', async () => {
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
    expect(argv).toEqual(['--shm', 'Local\\fake', '--profile-dir', r.deps.profileDir, '--scene-dir', r.deps.sceneDir])
    const sessionDir = path.join(r.deps.defaultOutputDir, '.sessions', status.sessionId!)
    await waitFor(() => fs.existsSync(path.join(sessionDir, 'live.json')))
    expect(fs.readFileSync(path.join(sessionDir, 'events.jsonl'), 'utf8')).toContain('"ev":"match_start"')
    expect(r.deps.notify).toHaveBeenCalledWith('matchStart', '第 1 局開始')

    // 收尾前讀出最終 live.json：把工作目錄的刪除攔下來
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
