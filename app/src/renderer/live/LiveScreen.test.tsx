// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { IDLE_RECORDING_STATUS, type LiveState, type LiveUpdate, type RecordingStatus } from '../../shared/recording'
import type { EngineEvent } from '../../shared/types'
import { formatTime } from '../../shared/time'
import type { RecordingApi } from '../global'
import { i18n, liveI18n as t, recordingI18n as rt } from '../i18n'
import { RecordingPanel } from '../shell/RecordingPanel'
import { LiveScreen } from './LiveScreen'
import { applyLiveUpdate, fill, newCountedEvents, pct } from './liveModel'
import { buttonByText, byLabel, cleanupMounted, click, flush, installDomShims, mount, press } from '../../../test/dom'
import { formatFindings, runAxe } from '../../../test/axe'

const ID = '20261018-123456-abcd'
const ev = (id: string, time: number, type = 'knock', counted = true): EngineEvent => ({ id, t: time, type, score: 1, damage_line: false,
  name_sig: null, counted, counted_reason: counted ? 'first' : 'duplicate', counted_override: null, source: 'auto' })
const segs = (n: number) => Array.from({ length: n }, (_, i) => ({ seq: i + 1, pts: i * 2, dur: 2 }))

/** Fake MediaSource/SourceBuffer: sourceopen fires asynchronously after setting `video.src`; append completes immediately. */
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
/** One timer cycle each for live snapshot -> render -> MediaSource sourceopen -> fetch/append. */
async function settle(): Promise<void> { for (let i = 0; i < 4; i++) await flush(5) }
const timeText = (): string => document.querySelector('.live-time')!.textContent!

describe('liveModel', () => {
  test('Applies updates: deduplicates segments, replaces the full event list, orders matches by sequence, and ignores other jobs', () => {
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

describe('RecordingPanel live match view', () => {
  test('OBS shows a playback prompt after recording ends, keeps events and matches, and does not read segments', async () => {
    const r = rig({ ...RECORDING, backend: 'obs', obsRecording: true }, { ...LIVE, mime: null, segments: [] })
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
  test('OBS lobby standby preserves detection status', async () => {
    rig({ ...RECORDING, backend: 'obs', obsRecording: false }, { ...LIVE, mime: null, segments: [] })
    screen()
    await settle()
    expect(document.body.textContent).toContain('待命（OBS，等待對局）')
    expect(document.body.textContent).not.toContain('錄影中（OBS）')
  })
  test('Available only while recording; clicking opens the live recording view', async () => {
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
  test.each([[20, 9.9], [80, 90], [10, 9.9], [90, 90], [9.95, 9.95], [100, 99.9]])('dragging to %s resolves a pruned gap to %s and keeps buffering', async (target, expected) => {
    const segments = [...segs(5), ...segs(5).map(s => ({ ...s, seq: s.seq + 45, pts: s.pts + 90 }))]
    const r = rig(RECORDING, { ...LIVE, segments })
    screen()
    await settle()
    const video = document.querySelector('video')!
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })
    media.sb!.buffered = { length: 1, start: () => 90, end: () => 100 }
    act(() => video.dispatchEvent(new Event('loadedmetadata')))
    expect(video.currentTime).toBe(97)
    vi.mocked(r.api.readSegment!).mockClear()
    const slider = document.querySelector<HTMLElement>('[role="slider"]')!
    vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 100 } as DOMRect)
    for (const type of ['pointerdown', 'pointerup']) {
      const event = new MouseEvent(type, { bubbles: true, clientX: target, buttons: 1 })
      Object.defineProperty(event, 'pointerId', { value: 1 })
      act(() => slider.dispatchEvent(event))
    }
    expect(timeText()).toBe(fill(t.time, { cur: formatTime(expected), end: formatTime(100) }))
    await settle()
    if (expected < 10) {
      expect(r.api.readSegment).toHaveBeenCalledWith(ID, 5)
      act(() => video.dispatchEvent(new Event('timeupdate')))
      expect(slider.getAttribute('aria-valuenow')).toBe('10')
      media.sb!.buffered = { length: 1, start: () => 8, end: () => 10 }
      act(() => media.sb!.dispatchEvent(new Event('updateend')))
    }
    expect(video.currentTime).toBe(expected)
    r.push({ sessionId: ID, segment: { seq: 51, pts: 100, dur: 2 } })
    act(() => { video.currentTime = 99; video.dispatchEvent(new Event('timeupdate')) })
    await settle()
    expect(r.api.readSegment).toHaveBeenCalledWith(ID, 51)
  })

  test('pruning the pending seek target moves it to a remaining segment before fetching', async () => {
    const r = rig(RECORDING, LIVE)
    screen()
    await settle()
    const video = document.querySelector('video')!
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })
    media.sb!.buffered = { length: 1, start: () => 14, end: () => 20 }
    act(() => video.dispatchEvent(new Event('loadedmetadata')))
    click(byLabel(document.body, '已消滅 · 0:12')!)
    expect(timeText()).toMatch(/^0:09/)
    r.push({ sessionId: ID, segments: LIVE.segments.filter(s => s.pts < 8 || s.pts >= 12) })
    expect(timeText()).toMatch(/^0:08/)
    media.sb!.buffered = { length: 1, start: () => 6, end: () => 8 }
    act(() => media.sb!.dispatchEvent(new Event('updateend')))
    expect(video.currentTime).toBe(7.9)
  })

  test('opening near a short newest segment skips the preceding gap', async () => {
    rig(RECORDING, { ...LIVE, segments: [{ seq: 1, pts: 0, dur: 10 }, { seq: 2, pts: 90, dur: 1 }] })
    screen()
    await settle()
    const video = document.querySelector('video')!
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })
    media.sb!.buffered = { length: 1, start: () => 90, end: () => 91 }
    act(() => video.dispatchEvent(new Event('loadedmetadata')))
    expect(video.currentTime).toBe(90)
  })

  test('an initially empty recording seeks into the first available segment', async () => {
    const r = rig(RECORDING, { ...LIVE, segments: [] })
    screen()
    await settle()
    const video = document.querySelector('video')!
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })
    r.push({ sessionId: ID, segment: { seq: 46, pts: 90, dur: 2 } })
    await settle()
    expect(r.api.readSegment).toHaveBeenCalledWith(ID, 46)
    media.sb!.buffered = { length: 1, start: () => 90, end: () => 92 }
    act(() => media.sb!.dispatchEvent(new Event('updateend')))
    expect(video.currentTime).toBe(90)
  })

  test('an unbuffered seek keeps its target through stale media events and applies only the latest seek when buffered', async () => {
    rig(RECORDING, LIVE)
    screen()
    await settle()
    const video = document.querySelector('video')!
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })
    media.sb!.buffered = { length: 1, start: () => 14, end: () => 20 }
    act(() => video.dispatchEvent(new Event('loadedmetadata')))
    expect(video.currentTime).toBe(17)

    const slider = document.querySelector<HTMLElement>('[role="slider"]')!
    press(slider, 'Home')
    expect(video.currentTime).toBe(17)
    press(slider, 'ArrowRight')
    act(() => {
      video.currentTime = 19
      video.dispatchEvent(new Event('timeupdate'))
      video.dispatchEvent(new Event('waiting'))
    })
    expect(slider.getAttribute('aria-valuenow')).toBe('5')
    // Completion of an earlier fetch must not apply the superseded seek to zero.
    media.sb!.buffered = { length: 1, start: () => 0, end: () => 2 }
    act(() => media.sb!.dispatchEvent(new Event('updateend')))
    expect(video.currentTime).toBe(19)
    media.sb!.buffered = { length: 1, start: () => 4, end: () => 8 }
    act(() => media.sb!.dispatchEvent(new Event('updateend')))
    expect(video.currentTime).toBe(5)
    act(() => {
      video.currentTime = 6
      video.dispatchEvent(new Event('timeupdate'))
    })
    expect(slider.getAttribute('aria-valuenow')).toBe('6')
  })

  test('MSE creates SourceBuffer from MIME, appends init before fetching recent segments, and keeps fetching after new segment updates', async () => {
    const r = rig(RECORDING, LIVE)
    screen()
    await settle()
    expect(media.types).toEqual([LIVE.mime])
    expect(media.sb!.mode).toBe('segments')
    expect(r.api.readInit).toHaveBeenCalledWith(ID)
    // On open, stay near the latest point (20 seconds - 3 seconds): fetch around 17 seconds, not from the beginning.
    const seqs = vi.mocked(r.api.readSegment!).mock.calls.map(([, seq]) => seq)
    expect(seqs).toContain(9)
    expect(seqs).not.toContain(1)
    expect(media.sb!.appended[0]).toEqual(new Uint8Array([1]))
    r.push({ sessionId: ID, segment: { seq: 11, pts: 20, dur: 2 } })
    await settle()
    expect(vi.mocked(r.api.readSegment!).mock.calls.map(([, seq]) => seq)).toContain(11)
    expect(timeText()).toContain('0:22')
  })

  test('Status bar, newest-first event list, seek to 3 seconds before an event, and aria-live announcement for newly counted events', async () => {
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

  test('Keyboard: Space toggles playback, arrows seek ±5 seconds, End jumps to live; the timeline slider handles its own arrows', async () => {
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

  test('Dragging follows the pointer during live updates and seeks once on release', async () => {
    const r = rig(RECORDING, LIVE)
    screen()
    await settle()
    const slider = document.querySelector<HTMLElement>('[role="slider"]')!
    vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 100 } as DOMRect)
    const pointer = (type: string, x: number): void => {
      const event = new MouseEvent(type, { bubbles: true, clientX: x, buttons: 1 })
      Object.defineProperty(event, 'pointerId', { value: 1 })
      act(() => { slider.dispatchEvent(event) })
    }
    const before = timeText()
    pointer('pointerdown', 20)
    expect(slider.getAttribute('aria-valuenow')).toBe('4')
    r.push({ sessionId: ID, segment: { seq: 11, pts: 20, dur: 2 } })
    expect(document.querySelector<HTMLElement>('.live-playhead')!.style.left).toBe('20%')
    pointer('pointermove', 90)
    expect(slider.getAttribute('aria-valuenow')).toBe('20')
    expect(document.querySelector<HTMLElement>('.live-playhead')!.style.left).toBe('90%')
    expect(timeText()).toBe(before.replace('0:20', '0:22'))
    pointer('pointerup', 90)
    expect(timeText()).toMatch(/^0:20/)
  })

  test('A drag that lost its pointerup ends on the next move instead of following the mouse', async () => {
    rig(RECORDING, LIVE)
    screen()
    await settle()
    const slider = document.querySelector<HTMLElement>('[role="slider"]')!
    vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 100 } as DOMRect)
    const pointer = (type: string, x: number, buttons = 1): void => {
      const event = new MouseEvent(type, { bubbles: true, clientX: x, buttons })
      Object.defineProperty(event, 'pointerId', { value: 1 })
      act(() => { slider.dispatchEvent(event) })
    }
    pointer('pointerdown', 80)
    expect(slider.getAttribute('aria-valuenow')).toBe('16')
    expect(document.querySelector<HTMLElement>('.live-playhead')!.style.left).toBe('80%')
    // The button was released outside the window, so no pointerup reached the element.
    pointer('pointermove', 90, 0)
    expect(slider.getAttribute('aria-valuenow')).toBe('0')
    expect(document.querySelector<HTMLElement>('.live-playhead')!.style.left).toBe('0%')
  })

  test('The drag preview is clamped to the retained range so it matches where the player lands', async () => {
    const retained: LiveState = { ...LIVE, segments: segs(10).map((s, i) => ({ ...s, pts: 100 + i * 2 })),
      matches: [{ start: 100, end: null }] }
    rig(RECORDING, retained)
    screen()
    await settle()
    const slider = document.querySelector<HTMLElement>('[role="slider"]')!
    vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 100 } as DOMRect)
    const pointer = (type: string, x: number): void => {
      const event = new MouseEvent(type, { bubbles: true, clientX: x, buttons: 1 })
      Object.defineProperty(event, 'pointerId', { value: 1 })
      act(() => { slider.dispatchEvent(event) })
    }
    // The released part of the timeline is no longer playable, so the preview shows the retained range start.
    pointer('pointerdown', 0)
    expect(slider.getAttribute('aria-valuenow')).toBe('100')
    pointer('pointerup', 0)
    expect(timeText()).toMatch(/^1:40/)
  })

  test('A timeline without width does not seek', async () => {
    rig(RECORDING, LIVE)
    screen()
    await settle()
    const slider = document.querySelector<HTMLElement>('[role="slider"]')!
    vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 0 } as DOMRect)
    const pointer = (type: string, x: number): void => {
      const event = new MouseEvent(type, { bubbles: true, clientX: x, buttons: 1 })
      Object.defineProperty(event, 'pointerId', { value: 1 })
      act(() => { slider.dispatchEvent(event) })
    }
    const before = timeText()
    pointer('pointerdown', 10)
    pointer('pointerup', 10)
    expect(timeText()).toBe(before)
  })

  test('After recording ends, confirms the file was added to the library and opens it in the studio', async () => {
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

  test('Switches to a new recording that starts while the screen stays open, ignoring late updates from the old one', async () => {
    const ID2 = '20261018-130000-beef'
    const LIVE2: LiveState = { ...LIVE, sessionId: ID2, events: [ev('b5000', 5, 'elim')], matches: [{ start: 0, end: null }] }
    const r = rig(RECORDING, LIVE)
    screen()
    await settle()
    r.push({ sessionId: ID, finalized: ['D:\videos\old.mp4'] })
    r.status({ ...IDLE_RECORDING_STATUS })
    expect(document.body.textContent).toContain(t.ended)
    vi.mocked(r.api.getLive!).mockResolvedValue(LIVE2)
    r.status({ ...RECORDING, sessionId: ID2 })
    r.push({ sessionId: ID2, segment: { seq: 11, pts: 20, dur: 2 } })
    await settle()
    expect(document.body.textContent).not.toContain(t.ended)
    const list = (): string => document.querySelector('.live-aside')!.textContent!
    expect(list()).toContain(fill(t.eventItem, { type: i18n.timeline.types.elim, time: formatTime(5) }))
    r.push({ sessionId: ID, events: [ev('late', 30)] })
    await settle()
    expect(list()).not.toContain(formatTime(30))
  })

  test('The play button reflects the new recording after a source switch, not the old one that was playing', async () => {
    const ID2 = '20261018-130000-beef'
    const r = rig(RECORDING, LIVE)
    screen()
    await settle()
    act(() => { document.querySelector('video')!.dispatchEvent(new Event('play')) })
    expect(byLabel(document.body, t.pause)).toBeTruthy()
    // The new recording has not loaded yet, so nothing is playing.
    vi.mocked(r.api.readInit!).mockReturnValue(new Promise(() => {}))
    vi.mocked(r.api.getLive!).mockResolvedValue({ ...LIVE, sessionId: ID2 })
    r.status({ ...RECORDING, sessionId: ID2 })
    r.push({ sessionId: ID2, segment: { seq: 11, pts: 20, dur: 2 } })
    await settle()
    expect(byLabel(document.body, t.play)).toBeTruthy()
    expect(byLabel(document.body, t.pause)).toBeFalsy()
  })

  test('Shows a recording that starts after the screen opened with nothing to watch', async () => {
    const r = rig()
    screen()
    await flush()
    expect(document.body.textContent).toContain(t.notRecording)
    vi.mocked(r.api.getLive!).mockResolvedValue(LIVE)
    r.status(RECORDING)
    r.push({ sessionId: ID, segment: { seq: 11, pts: 20, dur: 2 } })
    await settle()
    expect(document.body.textContent).not.toContain(t.notRecording)
    expect(document.querySelector('.live-aside')!.textContent).toContain(formatTime(12))
  })

  test('When the current recording ends without an output file, offers navigation to the library', async () => {
    const r = rig(RECORDING, LIVE)
    const { onOpenLibrary } = screen()
    await settle()
    r.status({ ...IDLE_RECORDING_STATUS })
    click(buttonByText(document.body, t.openLibrary)!)
    expect(onOpenLibrary).toHaveBeenCalledOnce()
  })

  test('No recording, unsupported codec, and init segment not yet written', async () => {
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

  test('No serious or critical axe violations', async () => {
    rig(RECORDING, LIVE)
    screen()
    await settle()
    const findings = await runAxe(document.querySelector('.live-screen')!)
    expect(findings, formatFindings(findings)).toEqual([])
  })
})
