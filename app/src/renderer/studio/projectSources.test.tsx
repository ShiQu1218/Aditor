// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import App from '../App'
import type { CacheDoc } from '../../shared/types'
import type { LibraryEntry } from '../../main/library'
import type { ProjectItem } from '../editor/project'
import { createFakeApi, installFakeApi, type FakeApi, type FakeApiOptions } from '../../../test/fakeApi'
import { buttonByText, cleanupMounted, click, flush, installDomShims, mount, press } from '../../../test/dom'
import { i18n } from '../i18n'

const A = 'D:/a.mp4'
const B = 'D:/b.mp4'
const C = 'D:/c.mp4'
const q = <T extends HTMLElement = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!
const chips = (): HTMLElement[] => Array.from(document.querySelectorAll('.pclip'))
const item = (id: string, source: string, start: number, end: number): ProjectItem => ({ id, source, start, end })
const entry = (path: string, status: LibraryEntry['status'] = 'done'): LibraryEntry => ({ path, status, addedAt: 1, favorite: false, progress: 0 })
function doc(path: string, duration = 600, n = 1): CacheDoc {
  return {
    version: 1,
    video: { path, duration, size: 1, mtime: 1, width: 1920, height: 1080, codec: 'h264', start_time: 0 },
    analysis: { status: 'done', progress_t: duration, engine_version: '0.3.0', templates_version: 'icons@1', h_scale: 1 },
    events: Array.from({ length: n }, (_, i) => ({ id: `${path}_${i}`, t: 50 + i, type: 'knock', score: 1, damage_line: false, name_sig: null, counted: true, counted_reason: '', counted_override: null, source: 'auto' })),
    clips: [], spectating: [], keyframes: [], cache_path: `${path}.json`
  }
}

let fake: FakeApi
let restore: (() => void) | undefined
let cache: Map<string, CacheDoc>
let playing: WeakMap<HTMLMediaElement, boolean>
let play: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  installDomShims({ width: 1366, height: 768 })
  playing = new WeakMap()
  vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(function (this: HTMLMediaElement) { return !playing.get(this) })
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    playing.set(this, true)
    this.dispatchEvent(new Event('play'))
    return Promise.resolve()
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    playing.set(this, false)
    this.dispatchEvent(new Event('pause'))
  })
  let frame = 0
  vi.stubGlobal('requestAnimationFrame', () => ++frame)
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  cache = new Map([[A, doc(A)], [B, doc(B, 1200, 2)]])
})
afterEach(() => {
  cleanupMounted()
  restore?.()
  restore = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function start(items: ProjectItem[], options: FakeApiOptions = {}): Promise<void> {
  fake = createFakeApi({
    entries: [entry(A), entry(B)],
    ...options,
    settings: { lastProjectId: 'p_test', autoSuggestOnOpen: false, ...options.settings },
    overrides: {
      projects: { load: async () => ({ version: 1, id: 'p_test', name: '測試專案', items }) },
      cache: {
        loadByVideo: vi.fn(async (path: string) => cache.get(path) ?? null),
        saveSync: vi.fn((d: CacheDoc) => { cache.set(d.video.path, d); return true })
      },
      engine: { probe: vi.fn(async (path: string) => doc(path, path === B ? 123 : 240).video) },
      ...options.overrides
    }
  })
  restore = installFakeApi(fake)
  mount(<App />)
  await flush()
  const card = Array.from(document.querySelectorAll('.vcard')).find((el) => el.getAttribute('data-vcard-path') === A)!
  click(card.querySelector('.vcard-open')!)
  await flush()
  expect(q('.studio-file').textContent).toBe('a.mp4')
  metadata()
}
function metadata(): HTMLVideoElement {
  const video = q<HTMLVideoElement>('video')
  act(() => { video.dispatchEvent(new Event('loadedmetadata')) })
  return video
}
function time(video: HTMLVideoElement, t: number, ended = false): void {
  act(() => {
    video.currentTime = t
    video.dispatchEvent(new Event('timeupdate'))
    if (ended) video.dispatchEvent(new Event('ended'))
  })
}
function addManualEvent(): void {
  press(document.body, 'm')
  click(q('.add-event .btn-accent'))
}

describe('Project clips stay in sync with studio sources', () => {
  test('clicking a clip synchronizes custom viewport, source playhead, playback, and return-to-source position', async () => {
    await start([item('a1', A, 500, 510)])
    const slider = q<HTMLInputElement>('.tl-toolbar input[type="range"]')
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, '3')
      slider.dispatchEvent(new Event('input', { bubbles: true }))
    })
    click(chips()[0])
    const video = q<HTMLVideoElement>('video')
    expect(video.currentTime).toBe(500)
    expect(video.paused).toBe(false)
    expect(q('.transport-time').textContent).toContain('8:20 /')
    expect(Number(q('[role="scrollbar"]').getAttribute('aria-valuenow'))).toBe(462.5)
    time(video, 505)
    expect(q('.transport-time').textContent).toContain('8:25 /')
    expect(q('.tl-playhead').style.opacity).toBe('1')
    expect(q('.pclip .prog').getAttribute('style')).toContain('50%')
    press(document.body, 'Escape')
    expect(q('.mode-pill').textContent).toContain(i18n.studio.mode.source)
    expect(video.currentTime).toBe(505)
    expect(video.paused).toBe(true)
  })

  test('continuous A → B → A playback remounts once per source, saves edits first, and preserves speed', async () => {
    await start([item('a1', A, 10, 20), item('b1', B, 100, 110), item('a2', A, 400, 410)])
    addManualEvent()
    for (let i = 0; i < 3; i++) press(document.body, 's')
    click(chips()[0])
    const a = q<HTMLVideoElement>('video')
    play.mockClear()
    time(a, 20, true)
    await flush()
    expect(q('.studio-file').textContent).toBe('b.mp4')
    // Cross-source navigation is direct; do not show the preview banner.
    expect(document.querySelector('.ctx-banner')).toBeNull()
    expect(document.querySelector('.grayed')).toBeNull()
    expect(q<HTMLVideoElement>('video')).not.toBe(a)
    expect(fake.api.cache.saveSync).toHaveBeenCalledTimes(1)
    const saved = (fake.api.cache.saveSync as ReturnType<typeof vi.fn>).mock.calls[0][0] as CacheDoc
    expect(saved.events.some((e) => e.source === 'manual')).toBe(true)
    expect(fake.api.cache.saveSync.mock.invocationCallOrder[0]).toBeLessThan(fake.api.cache.loadByVideo.mock.invocationCallOrder[1])
    const b = metadata()
    expect(b.currentTime).toBe(100)
    expect(b.playbackRate).toBe(2)
    expect(b.paused).toBe(false)
    expect(play).toHaveBeenCalledTimes(1)
    expect(q('.transport-time').textContent).toContain('/ 20:00')
    expect(q('.studio-meta').textContent).toContain('2 個事件')
    expect(chips()[1].classList.contains('sel')).toBe(true)
    time(b, 110, true)
    await flush()
    const a2 = metadata()
    expect(q('.studio-file').textContent).toBe('a.mp4')
    expect(a2.currentTime).toBe(400)
    expect(a2.playbackRate).toBe(2)
    expect(play).toHaveBeenCalledTimes(2)
    expect(fake.api.cache.loadByVideo.mock.calls).toEqual([[A], [B], [A]])
    time(a2, 410, true)
    expect(a2.paused).toBe(true)
  })

  test('an unanalyzed source can be cut immediately; library completion updates events without restarting playback', async () => {
    cache.delete(B)
    await start([item('b1', B, 10, 110)], { entries: [entry(A), entry(B, 'analyzing')] })
    click(chips()[0])
    await flush()
    const video = metadata()
    expect(q('.studio-file').textContent).toBe('b.mp4')
    expect(q('.transport-time').textContent).toContain('0:10 / 2:03')
    expect(q('.studio-meta').textContent).toContain('0 個事件')
    expect(fake.api.engine.analyze).not.toHaveBeenCalled()
    press(document.body, 'Escape')
    addManualEvent()
    press(document.body, 'b')
    for (const t of [30, 40]) {
      act(() => {
        q('.tl-wrap').dispatchEvent(new MouseEvent('mousedown', { clientX: t / 123 * 1366, clientY: 110, button: 0, bubbles: true }))
        window.dispatchEvent(new MouseEvent('mouseup', { clientX: t / 123 * 1366, clientY: 110, button: 0, bubbles: true }))
      })
    }
    expect(chips()).toHaveLength(2)
    press(document.body, 'Escape')
    click(chips()[0])
    time(video, 25)
    play.mockClear()
    cache.set(B, doc(B, 123, 2))
    fake.setEntries([entry(A), entry(B)])
    act(() => { fake.emit('library:updated') })
    await flush()
    expect(q<HTMLVideoElement>('video')).toBe(video)
    expect(video.currentTime).toBe(25)
    expect(video.paused).toBe(false)
    expect(play).not.toHaveBeenCalled()
    expect(q('.studio-meta').textContent).toContain('3 個事件')
    act(() => { window.dispatchEvent(new Event('beforeunload')) })
    const saved = (fake.api.cache.saveSync as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as CacheDoc
    expect(saved.analysis.status).toBe('done')
    expect(saved.events).toHaveLength(3)
    expect(saved.events.some((e) => e.source === 'manual')).toBe(true)
  })

  test('missing project sources keep the current studio and show the existing toast', async () => {
    await start([item('b1', B, 10, 20)], { overrides: { library: { fileExists: async (path: string) => path !== B } } })
    click(chips()[0])
    expect(q('.studio-file').textContent).toBe('a.mp4')
    expect(q('.toast').textContent).toContain(i18n.studio.track.missingToast)
    expect(fake.api.cache.loadByVideo.mock.calls).toEqual([[A]])
  })

  test('a proxy becoming available after the source switch preserves project playback position', async () => {
    let ready: (path: string) => void = () => undefined
    await start([item('b1', B, 100, 110)], {
      overrides: { proxy: { get: (path: string) => path === B ? new Promise<string>((resolve) => { ready = resolve }) : Promise.resolve(null) } }
    })
    click(chips()[0])
    await flush()
    const video = metadata()
    time(video, 105)
    ready('D:/proxy-b.mp4')
    await flush()
    expect(video.getAttribute('src')).toBe('file://D:/proxy-b.mp4')
    metadata()
    expect(video.currentTime).toBe(105)
    expect(video.paused).toBe(false)
    expect(q('.transport-time').textContent).toContain('1:45 /')
  })

  test('failed synchronous cache save blocks a source switch and retains the edit', async () => {
    await start([item('b1', B, 10, 20)])
    addManualEvent()
    fake.api.cache.saveSync.mockReturnValue(false)
    click(chips()[0])
    expect(q('.studio-file').textContent).toBe('a.mp4')
    expect(q('.toast').textContent).toContain(i18n.studio.toast.sourceSaveFailed)
    expect(fake.api.cache.loadByVideo.mock.calls).toEqual([[A]])
    fake.api.cache.saveSync.mockReturnValue(true)
    click(chips()[0])
    await flush()
    expect(q('.studio-file').textContent).toBe('b.mp4')
    const saved = (fake.api.cache.saveSync as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as CacheDoc
    expect(saved.events.some((e) => e.source === 'manual')).toBe(true)
  })

  test('export lock blocks both clicked and automatically advanced cross-source playback', async () => {
    let finish: (value: unknown) => void = () => undefined
    await start([item('a1', A, 10, 20), item('b1', B, 100, 110)], {
      settings: { defaultOutDir: 'D:/out' },
      overrides: { export: { start: () => new Promise((resolve) => { finish = resolve }) } }
    })
    click(chips()[0])
    press(document.body, 'E', { ctrlKey: true, shiftKey: true })
    await flush()
    click(q('.xd-foot .btn-accent'))
    await flush()
    expect(q('.xd').getAttribute('data-phase')).toBe('running')
    click(chips()[1])
    expect(q('.toast').textContent).toContain(i18n.export.backBlocked)
    time(q<HTMLVideoElement>('video'), 20, true)
    await flush()
    expect(q('.studio-file').textContent).toBe('a.mp4')
    expect(q<HTMLVideoElement>('video').paused).toBe(true)
    expect(fake.api.cache.loadByVideo.mock.calls).toEqual([[A]])
    finish({ ok: true, outputs: [] })
    await flush()
  })

  test('continuous playback skips a missing source and keeps the next available clip', async () => {
    await start([item('a1', A, 10, 20), item('missing', B, 100, 110), item('a2', A, 400, 410)], {
      overrides: { library: { fileExists: async (path: string) => path !== B } }
    })
    click(chips()[0])
    const video = q<HTMLVideoElement>('video')
    time(video, 20, true)
    expect(q<HTMLVideoElement>('video')).toBe(video)
    expect(video.currentTime).toBe(400)
    expect(chips()[2].classList.contains('sel')).toBe(true)
    expect(fake.api.cache.loadByVideo.mock.calls).toEqual([[A]])
  })

  test('external import appends full videos and plays the first; one Undo removes the whole batch after remount', async () => {
    cache.delete(B)
    await start([item('a1', A, 10, 20)], {
      overrides: {
        library: { selectFiles: async () => [B, C] },
        queue: { getState: async () => ({ queue: { analyzing: B, queued: [C] }, current: null }) }
      }
    })
    fake.setEntries([entry(A), entry(B, 'analyzing'), entry(C, 'pending')])
    click(buttonByText(document, i18n.studio.track.addExternalVideo)!)
    await flush()
    const video = metadata()
    expect(q('.studio-file').textContent).toBe('b.mp4')
    expect(video.currentTime).toBe(0)
    expect(video.paused).toBe(false)
    expect(chips()).toHaveLength(3)
    expect(chips()[1].classList.contains('sel')).toBe(true)
    expect(fake.api.queue.enqueue).not.toHaveBeenCalled()
    act(() => { window.dispatchEvent(new Event('beforeunload')) })
    const saved = (fake.api.projects.flushSync as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as { items: ProjectItem[] }
    expect(saved.items.slice(1)).toMatchObject([{ source: B, start: 0, end: 123 }, { source: C, start: 0, end: 240 }])
    press(document.body, 'z', { ctrlKey: true })
    expect(chips()).toHaveLength(1)
    expect(q('.mode-pill').textContent).toContain(i18n.studio.mode.source)
    play.mockClear()
    press(document.body, 'y', { ctrlKey: true })
    expect(chips()).toHaveLength(3)
    expect(play).not.toHaveBeenCalled()
  })
})
