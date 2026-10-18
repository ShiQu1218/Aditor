// @vitest-environment jsdom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { IDLE_RECORDING_STATUS, type LiveState, type LiveUpdate, type RecordingStatus } from '../../shared/recording'
import type { EngineEvent } from '../../shared/types'
import type { RecordingApi } from '../global'
import { liveI18n as t, recordingI18n as rt } from '../i18n/zh-TW'
import { RecordingPanel } from '../shell/RecordingPanel'
import { LiveScreen } from './LiveScreen'
import { applyLiveUpdate, fill, newCountedEvents, pct } from './liveModel'
import { buttonByText, byLabel, cleanupMounted, click, flush, installDomShims, mount, press } from '../../../test/dom'
import { formatFindings, runAxe } from '../../../test/axe'

const ID = '20261018-123456-abcd'
const ev = (id: string, time: number, type = 'knock', counted = true): EngineEvent => ({ id, t: time, type, score: 1, damage_line: false,
  name_sig: null, counted, counted_reason: counted ? 'first' : 'duplicate', counted_override: null, source: 'auto' })
const segs = (n: number) => Array.from({ length: n }, (_, i) => ({ seq: i + 1, pts: i * 2, dur: 2 }))

/** 假 MediaSource／SourceBuffer：sourceopen 在 `video.src` 設定後非同步觸發；append 立即完成。 */
class FakeSourceBuffer extends EventTarget {
  mode = 'sequence'
  updating = false
  buffered = { length: 0, start: () => 0, end: () => 0 }
  appended: Uint8Array[] = []
  appendBuffer(data: Uint8Array): void {
    this.appended.push(data)
    this.updating = true
    setTimeout(() => { this.updating = false; this.dispatchEvent(new Event('updateend')) }, 0)
  }
  remove(): void { this.updating = true; setTimeout(() => { this.updating = false; this.dispatchEvent(new Event('updateend')) }, 0) }
}
const media = { supported: true, sb: null as FakeSourceBuffer | null, types: [] as string[] }
class FakeMediaSource extends EventTarget {
  readyState = 'open'
  duration = Number.NaN
  static isTypeSupported(type: string): boolean { media.types.push(type); return media.supported }
  constructor() { super(); setTimeout(() => this.dispatchEvent(new Event('sourceopen')), 0) }
  addSourceBuffer(): FakeSourceBuffer { media.sb = new FakeSourceBuffer(); return media.sb }
}

function rig(initial: Partial<RecordingStatus> = {}, live: LiveState | null = null) {
  let status: RecordingStatus = { ...IDLE_RECORDING_STATUS, ...initial }
  const statusListeners = new Set<(s: RecordingStatus) => void>()
  const liveListeners = new Set<(u: LiveUpdate) => void>()
  const api: RecordingApi = {
    getStatus: vi.fn(async () => status), getCapabilities: vi.fn(async () => null),
    startManual: vi.fn(async () => true), stopManual: vi.fn(async () => undefined), setPaused: vi.fn(async () => undefined),
    onStatus: (cb) => { statusListeners.add(cb); return () => statusListeners.delete(cb) },
    getLive: vi.fn(async () => live),
    readInit: vi.fn(async () => new Uint8Array([1])),
    readSegment: vi.fn(async (_id: string, seq: number) => new Uint8Array([seq])),
    onLive: (cb) => { liveListeners.add(cb); return () => liveListeners.delete(cb) }
  }
  window.api = { ...window.api, recording: api }
  return {
    api, liveListeners,
    status: (patch: Partial<RecordingStatus>) => { status = { ...status, ...patch }; act(() => statusListeners.forEach((cb) => cb(status))) },
    push: (u: LiveUpdate) => act(() => liveListeners.forEach((cb) => cb(u)))
  }
}
const LIVE: LiveState = {
  sessionId: ID, mime: 'video/mp4; codecs="hev1.1.6.L150.90, mp4a.40.2"', segments: segs(10),
  events: [ev('a3000', 3), ev('a12000', 12, 'elim'), ev('a14000', 14, 'assist_knock', false)],
  spectating: [], matches: [{ start: 1, end: null }]
}
const RECORDING = { phase: 'recording' as const, sessionId: ID, startedAt: Date.now(), kills: 2, matchIndex: 1 }

let previousApi: Window['api']
beforeEach(() => {
  installDomShims()
  previousApi = window.api
  media.supported = true; media.sb = null; media.types = []
  vi.stubGlobal('MediaSource', FakeMediaSource)
  URL.createObjectURL = vi.fn(() => 'blob:live')
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => { cleanupMounted(); window.api = previousApi; vi.unstubAllGlobals(); vi.restoreAllMocks() })

function screen(onOpenVideo = vi.fn(), onBack = vi.fn(), onOpenLibrary = vi.fn()) {
  mount(<LiveScreen onBack={onBack} onOpenVideo={onOpenVideo} onOpenLibrary={onOpenLibrary} />)
  return { onOpenVideo, onBack, onOpenLibrary }
}
/** live 快照 → 渲染 → MediaSource sourceopen → 取檔／append 各需一輪計時器。 */
async function settle(): Promise<void> { for (let i = 0; i < 4; i++) await flush(5) }
const timeText = (): string => document.querySelector('.live-time')!.textContent!

describe('liveModel', () => {
  test('套用推播：段落去重、整份事件、對局依序號；其他工作忽略', () => {
    let s = applyLiveUpdate(LIVE, { sessionId: ID, segment: { seq: 11, pts: 20, dur: 2 } })
    s = applyLiveUpdate(s, { sessionId: ID, segment: { seq: 11, pts: 20, dur: 2 } })
    expect(s.segments).toHaveLength(11)
    s = applyLiveUpdate(s, { sessionId: ID, match: { index: 1, start: 1, end: 15 } })
    s = applyLiveUpdate(s, { sessionId: ID, match: { index: 2, start: 15, end: null } })
    expect(s.matches).toEqual([{ start: 1, end: 15 }, { start: 15, end: null }])
    expect(applyLiveUpdate(s, { sessionId: 'other', events: [] })).toBe(s)
    expect(newCountedEvents(LIVE.events, [...LIVE.events, ev('n', 20), ev('u', 21, 'knock', false)]).map((e) => e.id)).toEqual(['n'])
    expect(pct(5, 10)).toBe(50)
    expect(pct(5, 0)).toBe(0)
    expect(fill('{a}-{b}-{c}', { a: 1, b: 'x' })).toBe('1-x-{c}')
  })
})

describe('RecordingPanel 觀看當局', () => {
  test('OBS 顯示錄影結束後播放提示，仍保留事件與對局且不讀取段落', async () => {
    const r = rig({ ...RECORDING, backend: 'obs' }, { ...LIVE, mime: null, segments: [] })
    screen()
    await settle()
    expect(document.body.textContent).toContain('OBS 錄影中，錄影結束後即可播放')
    expect(document.body.textContent).toContain('錄影中（OBS）')
    expect(document.querySelectorAll('.live-events li')).toHaveLength(3)
    expect(document.querySelector('video')).toBeNull()
    expect(r.api.readInit).not.toHaveBeenCalled()
    expect(r.api.readSegment).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })
  test('只有錄影中可用，點擊開啟錄影中觀看', async () => {
    const r = rig()
    const onWatch = vi.fn()
    mount(<RecordingPanel onClose={() => undefined} onWatchLive={onWatch} />)
    await flush()
    expect(buttonByText(document.body, rt.watchLive)!.disabled).toBe(true)
    r.status(RECORDING)
    const watch = buttonByText(document.body, rt.watchLive)!
    expect(watch.disabled).toBe(false)
    expect(document.body.textContent).toContain(`${rt.kills}2`)
    click(watch)
    expect(onWatch).toHaveBeenCalledOnce()
  })
})

describe('LiveScreen', () => {
  test('MSE：依 MIME 建立 SourceBuffer，先 init 再抓最新附近的段落；新段落推播後繼續抓', async () => {
    const r = rig(RECORDING, LIVE)
    screen()
    await settle()
    expect(media.types).toEqual([LIVE.mime])
    expect(media.sb!.mode).toBe('segments')
    expect(r.api.readInit).toHaveBeenCalledWith(ID)
    // 開啟時停在最新（20 秒 − 3 秒）附近：抓 17 秒前後的段落，不從頭抓
    const seqs = vi.mocked(r.api.readSegment!).mock.calls.map(([, seq]) => seq)
    expect(seqs).toContain(9)
    expect(seqs).not.toContain(1)
    expect(media.sb!.appended[0]).toEqual(new Uint8Array([1]))
    r.push({ sessionId: ID, segment: { seq: 11, pts: 20, dur: 2 } })
    await settle()
    expect(vi.mocked(r.api.readSegment!).mock.calls.map(([, seq]) => seq)).toContain(11)
    expect(timeText()).toContain('0:22')
  })

  test('狀態列、事件清單（新的在上）、點事件跳到事件前 3 秒、新計入事件以 aria-live 宣告', async () => {
    const r = rig(RECORDING, LIVE)
    screen()
    await settle()
    expect(document.body.textContent).toContain(fill(t.match, { n: 1 }))
    expect(document.body.textContent).toContain(fill(t.kills, { n: 2 }))
    const items = Array.from(document.querySelectorAll('.live-events button')).map((b) => b.getAttribute('aria-label'))
    expect(items).toEqual(['助攻擊倒 · 0:14（不計入）', '已消滅 · 0:12', '擊倒 · 0:03'])
    expect(document.querySelectorAll('.live-marker')).toHaveLength(3)
    expect(document.querySelectorAll('.live-marker.uncounted')).toHaveLength(1)
    expect(document.querySelectorAll('.live-match')).toHaveLength(1)
    click(byLabel(document.body, '已消滅 · 0:12')!)
    expect(timeText()).toMatch(/^0:09/)
    const live = document.querySelector('[aria-live="polite"]')!
    expect(live.textContent).toBe('')
    r.push({ sessionId: ID, events: [...LIVE.events, ev('a18000', 18)] })
    expect(live.textContent).toBe(fill(t.newKill, { type: '擊倒', time: '0:18' }))
    r.push({ sessionId: ID, events: [...LIVE.events, ev('a18000', 18), ev('a19000', 19, 'knock', false)] })
    expect(live.textContent).toBe(fill(t.newKill, { type: '擊倒', time: '0:18' }))
  })

  test('鍵盤：空白鍵播放、方向鍵 ±5 秒、End 跳到最新；時間軸 slider 自己處理方向鍵', async () => {
    rig(RECORDING, LIVE)
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play')
    screen()
    await settle()
    click(byLabel(document.body, '擊倒 · 0:03')!)
    expect(timeText()).toMatch(/^0:00/)
    press(document.body, 'ArrowRight')
    expect(timeText()).toMatch(/^0:05/)
    press(document.body, 'ArrowLeft')
    expect(timeText()).toMatch(/^0:00/)
    const before = play.mock.calls.length
    press(document.body, ' ')
    expect(play.mock.calls.length).toBe(before + 1)
    const slider = document.querySelector<HTMLElement>('[role="slider"]')!
    expect(slider.getAttribute('aria-valuemax')).toBe('20')
    press(slider, 'ArrowRight')
    expect(timeText()).toMatch(/^0:05/)
    expect(slider.getAttribute('aria-valuenow')).toBe('5')
    press(slider, 'Home')
    expect(timeText()).toMatch(/^0:00/)
    press(document.body, 'End')
    expect(timeText()).toMatch(/^0:17/)
    expect(buttonByText(document.body, t.atLive)!.disabled).toBe(true)
  })

  test('錄影結束：顯示已加入媒體庫並可在工作室開啟輸出檔', async () => {
    const r = rig(RECORDING, LIVE)
    const { onOpenVideo } = screen()
    await settle()
    expect(document.body.textContent).not.toContain(t.ended)
    r.status({ phase: 'finalizing' })
    expect(document.body.textContent).not.toContain(t.ended)
    r.push({ sessionId: ID, finalized: ['D:\\videos\\Apex_2026-10-18_12-34.mp4'] })
    expect(document.body.textContent).toContain(t.ended)
    click(buttonByText(document.body, t.openStudio)!)
    expect(onOpenVideo).toHaveBeenCalledWith('D:\\videos\\Apex_2026-10-18_12-34.mp4')
  })

  test('狀態離開本次錄影但沒收到輸出檔時改為前往媒體庫', async () => {
    const r = rig(RECORDING, LIVE)
    const { onOpenLibrary } = screen()
    await settle()
    r.status({ ...IDLE_RECORDING_STATUS })
    click(buttonByText(document.body, t.openLibrary)!)
    expect(onOpenLibrary).toHaveBeenCalledOnce()
  })

  test('沒有錄影、不支援的編碼與 init 尚未寫出', async () => {
    rig()
    const { onBack } = screen()
    await flush()
    expect(document.body.textContent).toContain(t.notRecording)
    click(buttonByText(document.body, t.back)!)
    expect(onBack).toHaveBeenCalled()
    cleanupMounted()

    media.supported = false
    rig(RECORDING, LIVE)
    screen()
    await settle()
    expect(document.querySelector('[role="alert"]')!.textContent).toBe(fill(t.unsupported, { mime: LIVE.mime! }))
    expect(document.querySelectorAll('.live-events button')).toHaveLength(3)
    cleanupMounted()

    media.supported = true
    const r = rig(RECORDING, { ...LIVE, mime: null })
    screen()
    await settle()
    expect(document.body.textContent).toContain(t.waitingInit)
    vi.mocked(r.api.getLive!).mockResolvedValue(LIVE)
    r.push({ sessionId: ID, segment: { seq: 11, pts: 20, dur: 2 } })
    await settle()
    expect(document.body.textContent).not.toContain(t.waitingInit)
    expect(r.api.readInit).toHaveBeenCalled()
  })

  test('無 serious／critical axe 違規', async () => {
    rig(RECORDING, LIVE)
    screen()
    await settle()
    const findings = await runAxe(document.querySelector('.live-screen')!)
    expect(findings, formatFindings(findings)).toEqual([])
  })
})
