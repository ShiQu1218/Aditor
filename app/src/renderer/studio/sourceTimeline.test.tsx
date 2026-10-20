// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { buttonByText, cleanupMounted, click, focusEl, press } from '../../../test/dom'
import { mountStudio, STUDIO_VIDEO, type StudioMount } from '../../../test/studioHarness'
import type { Project } from '../editor/project'
import type { CacheDoc, Clip } from '../../shared/types'
import { i18n } from '../i18n'

let studio: StudioMount | null = null
let frames: Map<number, FrameRequestCallback>
const q = <T extends HTMLElement = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!
const doc = (d: CacheDoc): CacheDoc => ({ ...d, video: { ...d.video, duration: 600 }, events: [], spectating: [], cache_path: 'C:/cache/source.json' })
const quick = (): HTMLButtonElement => buttonByText(document.querySelector('.transport')!, i18n.studio.quickClip)!
const length = (): string | null => q('.pclip .cap .mono').textContent

beforeEach(() => {
  frames = new Map()
  let id = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++id, cb); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
})
afterEach(() => {
  cleanupMounted()
  studio?.restore()
  studio = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function nextFrame(): void {
  act(() => {
    for (const [id, cb] of Array.from(frames)) {
      frames.delete(id)
      cb(0)
    }
  })
}
function mouse(type: string, time: number, y = 110): void {
  const target = type === 'mouseup' ? window : q('.tl-wrap')
  act(() => { target.dispatchEvent(new MouseEvent(type, { clientX: time / 600 * 1366, clientY: y, button: 0, buttons: 1, bubbles: true, relatedTarget: document.body })) })
}
function point(time: number): void {
  mouse('mousedown', time)
  mouse('mouseup', time)
}
function storedProject(): Project {
  act(() => { studio!.fake.emit('projects:flushRequest') })
  return (studio!.fake.api.projects.flushSync as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]
}
function player(time = 10) {
  const video = q<HTMLVideoElement>('video')
  let paused = true
  Object.defineProperty(video, 'paused', { configurable: true, get: () => paused })
  const play = vi.spyOn(video, 'play').mockImplementation(() => {
    paused = false
    video.dispatchEvent(new Event('play'))
    return Promise.resolve()
  })
  const pause = vi.spyOn(video, 'pause').mockImplementation(() => {
    paused = true
    video.dispatchEvent(new Event('pause'))
  })
  act(() => {
    video.dispatchEvent(new Event('loadedmetadata'))
    video.currentTime = time
    video.dispatchEvent(new Event('timeupdate'))
  })
  return { video, play, pause }
}

describe('Source timeline player wiring', () => {
  test.each([true, false])('scrub restores the original playing=%s state and seeks the precise release time', async (playing) => {
    studio = await mountStudio({ doc, clips: [] })
    const { video, play, pause } = player()
    if (playing) act(() => { void video.play() })
    play.mockClear()
    mouse('mousedown', 60)
    mouse('mousemove', 90)
    mouse('mousemove', 120)
    expect(pause).toHaveBeenCalledTimes(1)
    expect(video.paused).toBe(true)
    expect(video.currentTime).toBe(10)
    nextFrame()
    expect(video.currentTime).toBeCloseTo(120)
    mouse('mousemove', 140)
    mouse('mouseup', 150.125)
    expect(video.currentTime).toBeCloseTo(150.125)
    expect(play).toHaveBeenCalledTimes(playing ? 1 : 0)
    expect(video.paused).toBe(!playing)
    nextFrame()
    expect(video.currentTime).toBeCloseTo(150.125)
  })

  test.each(['Escape', 'blur'])('%s restores the original playback position and playback state', async (cancel) => {
    studio = await mountStudio({ doc, clips: [] })
    const { video } = player(15)
    act(() => { void video.play() })
    mouse('mousedown', 60)
    mouse('mousemove', 90)
    nextFrame()
    expect(video.currentTime).toBeCloseTo(90)
    if (cancel === 'Escape') press(document.body, 'Escape')
    else act(() => { window.dispatchEvent(new Event('blur')) })
    expect(video.currentTime).toBe(15)
    expect(video.paused).toBe(false)
    mouse('mouseup', 160)
    nextFrame()
    expect(video.currentTime).toBe(15)
  })

  test('blade hover previews the latest frame without moving the source playhead; leave restores and resumes', async () => {
    studio = await mountStudio({ doc, clips: [] })
    const { video, pause } = player(10)
    act(() => { void video.play() })
    video.currentTime = 10.25
    nextFrame()
    const head = q('.tl-playhead').style.transform
    press(document.body, 'b')
    expect(quick().getAttribute('aria-pressed')).toBe('true')
    mouse('mousemove', 30)
    mouse('mousemove', 45)
    expect(video.currentTime).toBe(10.25)
    nextFrame()
    expect(video.currentTime).toBeCloseTo(45)
    expect(pause).toHaveBeenCalledTimes(1)
    act(() => { video.dispatchEvent(new Event('timeupdate')) })
    expect(q('.transport-time').textContent).toContain('0:10 /')
    expect(q('.tl-playhead').style.transform).toBe(head)
    mouse('mousemove', 60)
    mouse('mouseout', 60)
    expect(video.currentTime).toBe(10.25)
    expect(video.paused).toBe(false)
    nextFrame()
    expect(video.currentTime).toBe(10.25)
  })

  test('blade clips are accepted, persisted and reversible; continuous reversed cuts and short-range warning work', async () => {
    studio = await mountStudio({ doc, clips: [], api: { settings: { projectAutosave: false } } })
    click(quick())
    expect(document.querySelectorAll('.pclip')).toHaveLength(0)
    point(30)
    point(30.1)
    expect(q('.toast').textContent).toContain(i18n.timeline.bladeTooShort)
    expect(document.querySelectorAll('.pclip')).toHaveLength(0)
    point(45)
    expect(storedProject().items).toMatchObject([{ source: STUDIO_VIDEO, start: 30, end: 45 }])
    expect(quick().getAttribute('aria-pressed')).toBe('true')
    point(80)
    point(60)
    expect(storedProject().items.map(({ start, end }) => [start, end])).toEqual([[30, 45], [60, 80]])
    click(Array.from(document.querySelectorAll('.toast button')).at(-1)!)
    expect(storedProject().items.map(({ start, end }) => [start, end])).toEqual([[30, 45]])
    act(() => { window.dispatchEvent(new Event('beforeunload')) })
    const cached = (studio.fake.api.cache.saveSync as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as CacheDoc
    expect(cached.clips).toHaveLength(1)
    expect(cached.clips[0]).toMatchObject({ start: 30, end: 45, origin: 'manual', status: 'accepted' })
  })

  test('first Esc cancels the unfinished marker; second Esc exits blade mode; Ctrl+Q toggles it', async () => {
    studio = await mountStudio({ doc, clips: [] })
    press(document.body, 'q', { ctrlKey: true })
    point(30)
    expect(press(document.body, 'Escape').defaultPrevented).toBe(true)
    expect(quick().getAttribute('aria-pressed')).toBe('true')
    point(45)
    point(60)
    expect(storedProject().items).toMatchObject([{ start: 45, end: 60 }])
    press(document.body, 'Escape')
    expect(quick().getAttribute('aria-pressed')).toBe('false')
    point(90)
    expect(q('.transport-time').textContent).toContain('1:30 /')
  })

  test('Ctrl+Q in project mode still splits at the playhead', async () => {
    studio = await mountStudio({ doc, clips: [], items: [{ id: 'p', source: STUDIO_VIDEO, start: 10, end: 30 }] })
    const { video } = player()
    click(q('.pclip'))
    act(() => { video.currentTime = 20 })
    press(q('.pclip'), 'q', { ctrlKey: true })
    expect(storedProject().items.map(({ start, end }) => [start, end])).toEqual([[10, 20], [20, 30]])
  })

  test.each(['B', 'transport button'])('%s in project mode leaves the preview and enters blade mode at the current frame', async (via) => {
    studio = await mountStudio({ doc, clips: [], items: [{ id: 'p', source: STUDIO_VIDEO, start: 10, end: 30 }] })
    const { video } = player()
    click(q('.pclip'))
    // During project preview, the transport-bar button is still Quick Clip, not Split.
    expect(quick()).toBeTruthy()
    expect(q('.transport').textContent).not.toContain('分割')
    act(() => { video.currentTime = 20 })
    if (via === 'B') press(q('.pclip'), 'b')
    else click(quick())
    expect(q('.mode-pill').textContent).toContain(i18n.studio.mode.source)
    expect(quick().getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelectorAll('.pclip')).toHaveLength(1) // It was not split.
    point(40)
    point(55)
    expect(storedProject().items.map(({ start, end }) => [start, end])).toEqual([[10, 30], [40, 55]])
  })

  test.each([true, false])('cancelling a project-mode scrub restores its preview position (before first seek=%s)', async (beforeFrame) => {
    studio = await mountStudio({ doc, clips: [], items: [{ id: 'p', source: STUDIO_VIDEO, start: 10, end: 30 }] })
    const { video } = player()
    click(q('.pclip'))
    act(() => { video.currentTime = 15 })
    mouse('mousedown', 60)
    mouse('mousemove', 90)
    if (!beforeFrame) nextFrame()
    press(document.body, 'Escape')
    expect(q('.mode-pill').textContent).toContain(i18n.studio.mode.project)
    expect(video.currentTime).toBe(15)
    expect(video.paused).toBe(false)
  })
})

describe('Highlights sidebar follows the playhead', () => {
  const ai = (id: string, start: number): Clip => ({ id, start, end: start + 20, origin: 'ai', event_ids: [], status: 'suggested' })
  const activeCard = (): string | undefined => document.querySelector<HTMLElement>('.hl-card.active')?.dataset.clipId

  test('entering a highlight range makes its card active and scrolls it into view', async () => {
    // Keep the fixture events: suggestions are only placed when the document has events.
    studio = await mountStudio({ doc: (d) => ({ ...d, video: { ...d.video, duration: 600 } }), clips: [ai('h1', 100), ai('h2', 300)] })
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
    const { video } = player(10)
    expect(activeCard()).toBe('h1')
    act(() => {
      video.currentTime = 305
      video.dispatchEvent(new Event('timeupdate'))
    })
    expect(activeCard()).toBe('h2')
    expect(scroll.mock.contexts.some((el) => (el as HTMLElement).dataset?.clipId === 'h2')).toBe(true)
    act(() => {
      video.currentTime = 200
      video.dispatchEvent(new Event('timeupdate'))
    })
    expect(activeCard()).toBe('h2')
    act(() => {
      video.currentTime = 110
      video.dispatchEvent(new Event('timeupdate'))
    })
    expect(activeCard()).toBe('h1')
  })
})

describe('Project trimming on the source timeline', () => {
  const item = { id: 'p', source: STUDIO_VIDEO, start: 100, end: 200 }

  test('draft updates project length live; release persists once, Undo/Redo restore the full gesture and remount keeps it', async () => {
    studio = await mountStudio({ doc, clips: [], items: [item], api: { settings: { projectAutosave: false } } })
    focusEl(q('.pclip'))
    mouse('mousedown', 100, 60)
    mouse('mousemove', 150, 60)
    expect(length()).toBe('0:50')
    expect((q('[aria-label="復原 (Ctrl+Z)"]') as HTMLButtonElement).disabled).toBe(true)
    expect(studio.fake.api.projects.flushSync).not.toHaveBeenCalled()
    mouse('mousemove', 160, 60)
    expect(length()).toBe('0:40')
    mouse('mouseup', 170, 60)
    expect(length()).toBe('0:30')
    const stored = storedProject()
    expect(stored.items[0]).toMatchObject({ start: 170, end: 200 })
    press(document.body, 'z', { ctrlKey: true })
    expect(length()).toBe('1:40')
    expect((q('[aria-label="復原 (Ctrl+Z)"]') as HTMLButtonElement).disabled).toBe(true)
    press(document.body, 'y', { ctrlKey: true })
    expect(length()).toBe('0:30')
    studio.m.unmount()
    studio.restore()
    studio = await mountStudio({ doc, clips: [], api: { overrides: { projects: { load: async () => stored } } } })
    expect(length()).toBe('0:30')
  })

  test.each(['Escape', 'blur'])('%s cancels the draft without modifying stored project or history', async (cancel) => {
    studio = await mountStudio({ doc, clips: [], items: [item] })
    focusEl(q('.pclip'))
    mouse('mousedown', 200, 60)
    mouse('mousemove', 250, 60)
    expect(length()).toBe('2:30')
    if (cancel === 'Escape') press(document.body, 'Escape')
    else act(() => { window.dispatchEvent(new Event('blur')) })
    expect(length()).toBe('1:40')
    mouse('mouseup', 300, 60)
    expect(studio.fake.api.projects.flushSync).not.toHaveBeenCalled()
    expect((q('[aria-label="復原 (Ctrl+Z)"]') as HTMLButtonElement).disabled).toBe(true)
  })

  test('trim uses the existing minimum duration and source bounds, and save errors stay visible', async () => {
    studio = await mountStudio({ doc, clips: [], items: [item], api: { settings: { projectAutosave: false } } })
    focusEl(q('.pclip'))
    mouse('mousedown', 200, 60)
    mouse('mousemove', 50, 60)
    mouse('mouseup', 50, 60)
    expect(storedProject().items[0]).toMatchObject({ start: 100, end: 100.1 })
    press(document.body, 'z', { ctrlKey: true })
    mouse('mousedown', 200, 60)
    mouse('mousemove', 700, 60)
    mouse('mouseup', 700, 60)
    ;(studio.fake.api.projects.flushSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(false)
    expect(storedProject().items[0].end).toBe(600)
    expect(q('.sub-save.error').textContent).toContain(i18n.studio.track.saveError)
  })
})
