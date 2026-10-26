// @vitest-environment jsdom
import React, { act, createRef } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanupMounted, click, focusEl, installDomShims, mount, press } from '../../../test/dom'
import { mountStudio, type StudioMount } from '../../../test/studioHarness'
import { i18n } from '../i18n'
import { TimelineCanvas, TimelineHandle } from './TimelineCanvas'
import { resetThemeCache } from './draw'

type Props = React.ComponentProps<typeof TimelineCanvas>
const props: Props = {
  duration: 600, currentTime: 300, events: [], spectating: [], clips: [], filter: new Set(), onSeek: () => undefined
}
const q = <T extends HTMLElement = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!
const scrollbar = (): HTMLElement => q('[role="scrollbar"]')
const start = (): number => Number(scrollbar().getAttribute('aria-valuenow'))
const slider = (): HTMLInputElement => q('.tl-custom-zoom')
const modeButton = (mode: 'full' | 'detail' | 'custom'): HTMLButtonElement =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('.tl-mode')).find((b) => b.textContent === i18n.timeline.zoomModes[mode])!
const expectMode = (mode: 'full' | 'detail' | 'custom'): void => {
  expect(modeButton(mode).getAttribute('aria-pressed')).toBe('true')
  expect(document.querySelectorAll('.tl-mode[aria-pressed="true"]')).toHaveLength(1)
}
function setRange(value: number): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider(), String(value))
    slider().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function wheel(deltaY: number, ctrlKey = false, shiftKey = false): WheelEvent {
  const event = new WheelEvent('wheel', { clientX: 400, deltaY, ctrlKey, shiftKey, bubbles: true, cancelable: true })
  act(() => { q('.tl-wrap').dispatchEvent(event) })
  return event
}
function pointer(type: string, clientX: number): void {
  const event = new MouseEvent(type, { clientX, button: 0, bubbles: true, cancelable: true })
  Object.defineProperty(event, 'pointerId', { value: 7 })
  act(() => { scrollbar().dispatchEvent(event) })
}

let frames: Map<number, FrameRequestCallback>
let frameTime = 0
let studio: StudioMount | null = null
beforeEach(() => {
  installDomShims({ width: 1000, height: 700 })
  frames = new Map()
  frameTime = 0
  let id = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (frame: number) => { frames.delete(frame) })
})
afterEach(() => {
  cleanupMounted()
  studio?.restore()
  studio = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
function nextFrame(): void {
  frameTime += 16
  act(() => {
    for (const [id, callback] of Array.from(frames)) {
      frames.delete(id)
      callback(frameTime)
    }
  })
}

/** One playback poll (16 ms is the floor of playbackPollMs; detail mode here is 15 ms per half pixel). */
function pollTick(): void {
  act(() => { vi.advanceTimersByTime(16) })
}

function mouse(type: string, x: number, init: MouseEventInit = {}): void {
  const target = type !== 'mouseup' ? q('.tl-wrap') : window
  act(() => { target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: 110, button: 0, buttons: 1, bubbles: true, ...init })) })
}

describe('source timeline gestures', () => {
  test('dragging blank track seeks once per frame; release seeks the exact final position', () => {
    const onSeek = vi.fn()
    const onScrubStart = vi.fn()
    const onScrubEnd = vi.fn()
    mount(<TimelineCanvas {...props} onSeek={onSeek} onScrubStart={onScrubStart} onScrubEnd={onScrubEnd} />)
    mouse('mousedown', 100)
    mouse('mousemove', 200)
    mouse('mousemove', 350)
    expect(onScrubStart).toHaveBeenCalledTimes(1)
    expect(onSeek).not.toHaveBeenCalled()
    nextFrame()
    expect(onSeek).toHaveBeenCalledTimes(1)
    expect(onSeek).toHaveBeenLastCalledWith(210)
    mouse('mousemove', 450)
    mouse('mouseup', 700)
    expect(onSeek).toHaveBeenLastCalledWith(420)
    expect(onScrubEnd).toHaveBeenCalledWith(false)
    nextFrame()
    expect(onSeek).toHaveBeenCalledTimes(2)
    expect(q('.tl-wrap').querySelector('.tl-boxsel')).toBeNull()
  })

  test('playhead starts scrubbing immediately, even before crossing the drag threshold', () => {
    const onSeek = vi.fn()
    const onScrubStart = vi.fn()
    mount(<TimelineCanvas {...props} onSeek={onSeek} onScrubStart={onScrubStart} />)
    mouse('mousedown', 500, { clientY: 5 })
    expect(onScrubStart).toHaveBeenCalledTimes(1)
    mouse('mousemove', 502)
    nextFrame()
    expect(onSeek).toHaveBeenLastCalledWith(301.2)
    mouse('mouseup', 502)
  })

  test.each(['Escape', 'blur', 'lost buttons'])('%s cancels pending seeks and restores the live original time', (cancel) => {
    const onSeek = vi.fn()
    const onScrubEnd = vi.fn()
    mount(<TimelineCanvas {...props} playing getPlayTime={() => 42} onSeek={onSeek} onScrubEnd={onScrubEnd} />)
    mouse('mousedown', 100)
    mouse('mousemove', 300)
    nextFrame()
    mouse('mousemove', 400)
    if (cancel === 'Escape') expect(press(window, 'Escape').defaultPrevented).toBe(true)
    else if (cancel === 'blur') act(() => { window.dispatchEvent(new Event('blur')) })
    else mouse('mousemove', 400, { buttons: 0 })
    expect(onSeek).toHaveBeenLastCalledWith(42)
    expect(onScrubEnd).toHaveBeenCalledWith(true)
    const n = onSeek.mock.calls.length
    mouse('mouseup', 900)
    nextFrame()
    expect(onSeek).toHaveBeenCalledTimes(n)
  })

  test('edge scrubbing scrolls detail mode while the pointer is stationary and clamps at the end', () => {
    const onSeek = vi.fn()
    mount(<TimelineCanvas {...props} onSeek={onSeek} />)
    click(modeButton('detail'))
    mouse('mousedown', 500)
    mouse('mousemove', 1000)
    nextFrame()
    expect(start()).toBeGreaterThan(285)
    const first = start()
    nextFrame()
    expect(start()).toBeGreaterThan(first)
    expectMode('detail')
    for (let i = 0; i < 400; i++) nextFrame()
    expect(start()).toBe(570)
    expect(onSeek).toHaveBeenLastCalledWith(600)
    mouse('mouseup', 1100)
  })

  test.each([true, false])('handle drag previews and auto-scrolls at an edge; Escape restores time and viewport (project=%s)', (project) => {
    const onSeek = vi.fn(), onProjectTrim = vi.fn(), onUpdateClip = vi.fn(), onScrubEnd = vi.fn()
    mount(<TimelineCanvas {...props} onSeek={onSeek} onProjectTrim={onProjectTrim} onUpdateClip={onUpdateClip} onScrubEnd={onScrubEnd}
      projectItem={project ? { id: 'p', source: 'v', start: 290, end: 310 } : null}
      clips={project ? [] : [{ id: 'c', start: 290, end: 310, origin: 'ai', event_ids: [], status: 'suggested' }]} />)
    click(modeButton('detail'))
    mouse('mousedown', 1000 * 25 / 30, { clientY: 60 })
    mouse('mousemove', 1000, { clientY: 60 })
    nextFrame()
    const first = start()
    expect(first).toBeGreaterThan(285)
    expect(onSeek.mock.calls.at(-1)![0]).toBeGreaterThan(315)
    nextFrame()
    expect(start()).toBeGreaterThan(first)
    press(window, 'Escape')
    expect(start()).toBe(285)
    expect(onSeek).toHaveBeenLastCalledWith(300)
    expect(onScrubEnd).toHaveBeenCalledWith(true)
    if (project) expect(onProjectTrim).toHaveBeenLastCalledWith('p', 'end', 0, 'cancel')
    else expect(onUpdateClip.mock.calls.at(-1)![0]).toMatchObject({ start: 290, end: 310 })
  })

  test('project handles win over suggested clip handles and commit only on release', () => {
    const onProjectTrim = vi.fn()
    const onUpdateClip = vi.fn()
    const onSeek = vi.fn()
    mount(<TimelineCanvas {...props} currentTime={60} onSeek={onSeek} onProjectTrim={onProjectTrim} onUpdateClip={onUpdateClip}
      projectItem={{ id: 'p', source: 'v', start: 60, end: 180 }}
      clips={[{ id: 'c', start: 60, end: 180, origin: 'ai', event_ids: [], status: 'suggested' }]} />)
    mouse('mousedown', 100, { clientY: 60 })
    mouse('mousemove', 150, { clientY: 60 })
    nextFrame()
    expect(onSeek).toHaveBeenLastCalledWith(90)
    expect(onProjectTrim).toHaveBeenLastCalledWith('p', 'start', 90, 'preview')
    expect(onProjectTrim.mock.calls.some((call) => call[3] === 'commit')).toBe(false)
    mouse('mouseup', 200, { clientY: 60 })
    expect(onProjectTrim).toHaveBeenLastCalledWith('p', 'start', 120, 'commit')
    expect(onUpdateClip).not.toHaveBeenCalled()
    expect(onSeek).toHaveBeenLastCalledWith(120)
  })

  test('clip handle drags report the original and final range once, on release', () => {
    const onUpdateClip = vi.fn()
    const onClipTrimCommit = vi.fn()
    const clip = { id: 'c', start: 60, end: 180, origin: 'ai' as const, event_ids: [], status: 'accepted' as const }
    mount(<TimelineCanvas {...props} currentTime={60} onUpdateClip={onUpdateClip} onClipTrimCommit={onClipTrimCommit} clips={[clip]} />)
    mouse('mousedown', 100, { clientY: 60 })
    mouse('mousemove', 150, { clientY: 60 })
    nextFrame()
    expect(onUpdateClip).toHaveBeenLastCalledWith({ ...clip, start: 90 })
    expect(onClipTrimCommit).not.toHaveBeenCalled()
    mouse('mouseup', 200, { clientY: 60 })
    expect(onClipTrimCommit).toHaveBeenCalledTimes(1)
    expect(onClipTrimCommit).toHaveBeenCalledWith(clip, { ...clip, start: 120 })
  })

  test('blade clicks never seek or trim; hover preview coalesces and leaving cancels pending preview', () => {
    const onSeek = vi.fn()
    const onHoverSeek = vi.fn()
    const onBladeRange = vi.fn()
    mount(<TimelineCanvas {...props} bladeMode onSeek={onSeek} onHoverSeek={onHoverSeek} onBladeRange={onBladeRange} />)
    mouse('mousemove', 100)
    mouse('mousemove', 200)
    nextFrame()
    expect(onHoverSeek).toHaveBeenLastCalledWith(120)
    expect(q('.tl-wrap').style.cursor).toBe('crosshair')
    expect(q('.tl-tip').textContent).toBe('2:00')
    mouse('mousedown', 300)
    mouse('mouseup', 300)
    mouse('mousedown', 100)
    mouse('mouseup', 100)
    expect(onBladeRange).toHaveBeenCalledWith(60, 180)
    expect(onSeek).not.toHaveBeenCalled()
    mouse('mousemove', 400)
    mouse('mouseout', 400, { relatedTarget: document.body })
    expect(onHoverSeek).toHaveBeenLastCalledWith(null)
    const n = onHoverSeek.mock.calls.length
    nextFrame()
    expect(onHoverSeek).toHaveBeenCalledTimes(n)
  })

  test('opening an overlay cancels a scrub; blade markers survive the overlay and toggling off resets the cursor', () => {
    const onSeek = vi.fn()
    const onScrubEnd = vi.fn()
    const onBladeRange = vi.fn()
    const p = { ...props, onSeek, onScrubEnd, onBladeRange }
    const m = mount(<TimelineCanvas {...p} />)
    mouse('mousedown', 100)
    mouse('mousemove', 200)
    act(() => m.root.render(<TimelineCanvas {...p} disabled />))
    expect(onSeek).toHaveBeenLastCalledWith(300)
    expect(onScrubEnd).toHaveBeenCalledWith(true)
    act(() => m.root.render(<TimelineCanvas {...p} bladeMode />))
    mouse('mousedown', 100)
    act(() => m.root.render(<TimelineCanvas {...p} bladeMode disabled />))
    expect(press(window, 'Escape').defaultPrevented).toBe(false)
    act(() => m.root.render(<TimelineCanvas {...p} bladeMode />))
    mouse('mousedown', 200)
    expect(onBladeRange).toHaveBeenCalledWith(60, 120)
    act(() => m.root.render(<TimelineCanvas {...p} />))
    expect(q('.tl-wrap').style.cursor).toBe('pointer')
  })

  test('switching theme invalidates the canvas color cache', async () => {
    resetThemeCache()
    const read = vi.spyOn(window, 'getComputedStyle')
    const m = mount(<TimelineCanvas {...props} projectItem={{ id: 'p', source: 'v', start: 60, end: 180 }} />)
    nextFrame()
    read.mockClear()
    await act(async () => { document.documentElement.dataset.theme = 'light' })
    nextFrame()
    expect(read).toHaveBeenCalledWith(document.documentElement)
    m.unmount()
    delete document.documentElement.dataset.theme
    read.mockRestore()
    resetThemeCache()
  })
})

describe('source timeline zoom controls', () => {
  test('project playback keeps custom zoom and scrolls an offscreen playhead into view', () => {
    let time = 300
    const render = (currentTime: number, playing = false): React.ReactElement => <TimelineCanvas {...props} currentTime={currentTime} followProject playing={playing} getPlayTime={() => time} />
    const m = mount(render(300))
    setRange(3)
    const zoom = slider().value
    act(() => m.root.render(render(510)))
    expectMode('custom')
    expect(slider().value).toBe(zoom)
    expect(start()).toBe(472.5)
    time = 599
    act(() => m.root.render(render(510, true)))
    nextFrame()
    expect(start()).toBe(525)
    expect(q('.tl-playhead').style.opacity).toBe('1')
  })

  test('toolbar precedes the track, scrollbar follows it, and full extent fills the thumb', () => {
    mount(<TimelineCanvas {...props} />)
    expectMode('full')
    const children = Array.from(q('.tl-source').children)
    expect(children.map((el) => el.className)).toEqual(['tl-toolbar', 'tl-wrap', 'tl-scrollbar'])
    expect(q('[role="toolbar"]').getAttribute('aria-label')).toBe(i18n.timeline.zoomToolbar)
    for (const button of document.querySelectorAll('.tl-mode')) expect(button.getAttribute('title')).toBeTruthy()
    expect(scrollbar().getAttribute('aria-controls')).toBe(q('.tl-wrap').id)
    expect(scrollbar().getAttribute('aria-disabled')).toBe('true')
    expect(q('.tl-scrollbar-thumb').style.width).toBe('1000px')
    // Shift+wheel has no panning range in overview, so do not intercept it.
    expect(wheel(100, false, true).defaultPrevented).toBe(false)
    press(scrollbar(), 'End')
    expectMode('full')
    expect(start()).toBe(0)
  })

  test('detail follows seeks with a fixed span and clamps at the source end', () => {
    const m = mount(<TimelineCanvas {...props} />)
    click(modeButton('detail'))
    expectMode('detail')
    expect(start()).toBe(285)
    expect(q('.tl-scrollbar-thumb').style.width).toBe('50px')
    act(() => m.root.render(<TimelineCanvas {...props} currentTime={410} />))
    expect(start()).toBe(395)
    act(() => m.root.render(<TimelineCanvas {...props} currentTime={599} />))
    expect(start()).toBe(570)
  })

  test('detail follows live playback between timeupdate events without a frame loop and stops on unmount', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let time = 100
    const m = mount(<TimelineCanvas {...props} playing getPlayTime={() => time} />)
    click(modeButton('detail'))
    expect(start()).toBe(85)
    time = 160
    nextFrame()
    pollTick()
    expect(start()).toBe(145)
    nextFrame()
    pollTick()
    expect(q('.tl-playhead').style.transform).toBe('translateX(500px)')
    nextFrame()
    // An idle rAF loop would commit a main frame every vsync during playback.
    expect(frames.size).toBe(0)
    m.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('playback skips sub-pixel playhead and detail-view updates', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let time = 100
    mount(<TimelineCanvas {...props} playing getPlayTime={() => time} />)
    click(modeButton('detail'))
    pollTick()
    const head = q('.tl-playhead')
    const transform = head.style.transform
    const writes = vi.spyOn(head.style, 'transform', 'set')
    time = 100.01 // 1000 px for a 30 s window: 0.01 s is a third of a pixel.
    pollTick()
    expect(start()).toBe(85)
    expect(writes).not.toHaveBeenCalled()
    time = 100.06
    pollTick()
    expect(start()).toBeCloseTo(85.06)
    expect(head.style.transform).toBe(transform)
  })

  test('the slider enters custom mode and retains its multiplier across mode changes and rerenders', () => {
    const m = mount(<TimelineCanvas {...props} />)
    setRange(3)
    expectMode('custom')
    expect(q('.tl-scrollbar-thumb').style.width).toBe('125px')
    click(modeButton('full'))
    click(modeButton('detail'))
    act(() => m.root.render(<TimelineCanvas {...props} currentTime={400} />))
    click(modeButton('custom'))
    expectMode('custom')
    expect(slider().value).toBe('3')
    expect(start()).toBe(362.5)
    expect(q('.tl-scrollbar-thumb').style.width).toBe('125px')
  })

  test('imperative zoom commands enter custom mode and reset returns to full extent', () => {
    const ref = createRef<TimelineHandle>()
    mount(<TimelineCanvas {...props} ref={ref} />)
    click(modeButton('detail'))
    act(() => ref.current!.zoomIn())
    expectMode('custom')
    expect(Number(slider().value)).toBeCloseTo(Math.log2(600 / 21))
    act(() => ref.current!.zoomOut())
    expect(Number(slider().value)).toBeCloseTo(Math.log2(600 / 29.4))
    act(() => ref.current!.zoomReset())
    expectMode('full')
    expect(start()).toBe(0)
    click(modeButton('custom'))
    expect(Number(slider().value)).toBeCloseTo(Math.log2(600 / 29.4))
  })

  test('plain wheel zooms centred on the playhead (not the pointer); Shift+wheel pans', () => {
    mount(<TimelineCanvas {...props} />)
    // Cursor at x=400 (t=240), playhead at 300: center the playhead after zooming.
    expect(wheel(-100).defaultPrevented).toBe(true)
    expectMode('custom')
    expect(start()).toBeCloseTo(90) // Span 420, centered on 300.
    expect(q('.tl-scrollbar-thumb').style.width).toBe('700px')
    expect(wheel(-100, true).defaultPrevented).toBe(true) // Ctrl+wheel also zooms.
    expect(start()).toBeCloseTo(153)
    const before = start()
    expect(wheel(100, false, true).defaultPrevented).toBe(true)
    expect(start()).toBeGreaterThan(before)
  })

  test('zoom buttons and the custom slider centre on the playhead', () => {
    const ref = createRef<TimelineHandle>()
    mount(<TimelineCanvas {...props} ref={ref} currentTime={250} />)
    act(() => ref.current!.zoomIn()) // Span 420, centered on 250.
    expect(start()).toBeCloseTo(40)
    setRange(3) // 8×：span 75
    expect(start()).toBeCloseTo(212.5)
  })

  test('centred zoom near the end clamps instead of running past the source', () => {
    const ref = createRef<TimelineHandle>()
    mount(<TimelineCanvas {...props} ref={ref} currentTime={580} />)
    act(() => ref.current!.zoomIn())
    expect(start()).toBeCloseTo(180) // [180, 600]
  })

  test('scrollbar dragging preserves the grab offset, clamps at the ends and never seeks', () => {
    const onSeek = vi.fn()
    mount(<TimelineCanvas {...props} onSeek={onSeek} />)
    setRange(3)
    scrollbar().setPointerCapture = vi.fn()
    scrollbar().releasePointerCapture = vi.fn()
    pointer('pointerdown', 450)
    pointer('pointermove', 600)
    expect(start()).toBe(352.5)
    pointer('pointermove', 2000)
    expect(start()).toBe(525)
    pointer('pointermove', -100)
    expect(start()).toBe(0)
    pointer('pointerup', -100)
    pointer('pointermove', 600)
    expect(start()).toBe(0)
    expect(scrollbar().setPointerCapture).toHaveBeenCalledWith(7)
    expect(scrollbar().releasePointerCapture).toHaveBeenCalledWith(7)
    pointer('pointerdown', 500)
    expect(start()).toBe(262.5)
    pointer('pointercancel', 500)
    pointer('pointermove', 600)
    expect(start()).toBe(262.5)
    expect(onSeek).not.toHaveBeenCalled()
  })

  test('scrollbar keyboard navigation enters custom mode and stops the detail follow', () => {
    const m = mount(<TimelineCanvas {...props} />)
    click(modeButton('detail'))
    expect(press(scrollbar(), 'ArrowRight').defaultPrevented).toBe(true)
    expectMode('custom')
    expect(start()).toBe(288)
    act(() => m.root.render(<TimelineCanvas {...props} currentTime={500} />))
    expect(start()).toBe(288)
    press(scrollbar(), 'End')
    expect(start()).toBe(570)
    press(scrollbar(), 'Home')
    expect(start()).toBe(0)
    press(scrollbar(), 'PageDown')
    expect(start()).toBe(30)
  })

  test('changing duration preserves the custom multiplier and keeps the viewport in range', () => {
    const m = mount(<TimelineCanvas {...props} />)
    setRange(3)
    act(() => m.root.render(<TimelineCanvas {...props} duration={1200} />))
    expectMode('custom')
    expect(slider().value).toBe('3')
    expect(q('.tl-scrollbar-thumb').style.width).toBe('125px')
    act(() => m.root.render(<TimelineCanvas {...props} duration={5} currentTime={2} />))
    expect(start()).toBe(0)
    expect(scrollbar().getAttribute('aria-valuemax')).toBe('0')
    expect(q('.tl-scrollbar-thumb').style.width).toBe('1000px')
  })

  test('Studio keymap Ctrl+= / Ctrl+- / Ctrl+0 reaches the new model and removes the old overlay', async () => {
    studio = await mountStudio()
    expect(document.querySelector('.tl-zoom')).toBeNull()
    focusEl(q('.tl-wrap'))
    press(q('.tl-wrap'), '=', { ctrlKey: true })
    expectMode('custom')
    const zoomed = Number(slider().value)
    press(q('.tl-wrap'), '-', { ctrlKey: true })
    expect(Number(slider().value)).toBeLessThan(zoomed)
    press(q('.tl-wrap'), '0', { ctrlKey: true })
    expectMode('full')
    expect(start()).toBe(0)
  })
})
