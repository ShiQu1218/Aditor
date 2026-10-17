// @vitest-environment jsdom
import React, { act, createRef } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanupMounted, click, focusEl, installDomShims, mount, press } from '../../../test/dom'
import { mountStudio, type StudioMount } from '../../../test/studioHarness'
import { i18n } from '../i18n/zh-TW'
import { TimelineCanvas, TimelineHandle } from './TimelineCanvas'

type Props = React.ComponentProps<typeof TimelineCanvas>
const props: Props = {
  duration: 600, currentTime: 300, events: [], spectating: [], clips: [], filter: new Set(), onSeek: () => undefined
}
const q = <T extends HTMLElement = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!
const scrollbar = (): HTMLElement => q('[role="scrollbar"]')
const start = (): number => Number(scrollbar().getAttribute('aria-valuenow'))
const slider = (): HTMLInputElement => q('input[type="range"]')
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
function wheel(deltaY: number, ctrlKey = false): WheelEvent {
  const event = new WheelEvent('wheel', { clientX: 400, deltaY, ctrlKey, bubbles: true, cancelable: true })
  act(() => { q('.tl-wrap').dispatchEvent(event) })
  return event
}
function pointer(type: string, clientX: number): void {
  const event = new MouseEvent(type, { clientX, button: 0, bubbles: true, cancelable: true })
  Object.defineProperty(event, 'pointerId', { value: 7 })
  act(() => { scrollbar().dispatchEvent(event) })
}

let frames: Map<number, FrameRequestCallback>
let studio: StudioMount | null = null
beforeEach(() => {
  installDomShims({ width: 1000, height: 700 })
  frames = new Map()
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
  vi.unstubAllGlobals()
})
function nextFrame(): void {
  act(() => {
    for (const [id, callback] of Array.from(frames)) {
      frames.delete(id)
      callback(0)
    }
  })
}

describe('source timeline zoom controls', () => {
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
    expect(wheel(100).defaultPrevented).toBe(false)
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

  test('detail follows live playback between timeupdate events and cancels its frame loop on unmount', () => {
    let time = 100
    const m = mount(<TimelineCanvas {...props} playing getPlayTime={() => time} />)
    click(modeButton('detail'))
    expect(start()).toBe(85)
    time = 160
    nextFrame()
    expect(start()).toBe(145)
    expect(q('.tl-playhead').style.transform).toBe('translateX(500px)')
    m.unmount()
    expect(frames.size).toBe(0)
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

  test('Ctrl+wheel zooms around the pointer; plain wheel pans and updates the thumb', () => {
    mount(<TimelineCanvas {...props} />)
    expect(wheel(-100, true).defaultPrevented).toBe(true)
    expectMode('custom')
    expect(start()).toBeCloseTo(72)
    expect(q('.tl-scrollbar-thumb').style.width).toBe('700px')
    expect(wheel(100).defaultPrevented).toBe(true)
    expect(start()).toBeCloseTo(135)
    expect(parseFloat(q('.tl-scrollbar-thumb').style.left)).toBeCloseTo(225)
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
