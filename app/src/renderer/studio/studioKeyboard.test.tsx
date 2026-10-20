// @vitest-environment jsdom
// Integration tests for studio keyboard paths: mount StudioScreen with a fake API and dispatch real keydown events.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act } from 'react'
import { cleanupMounted, click, flush, focusEl, installDomShims, press } from '../../../test/dom'
import { mountStudio, STUDIO_VIDEO, type StudioMount } from '../../../test/studioHarness'
import { eventAriaLabel } from './reasons'
import type { EngineEvent } from '../../shared/types'

let s: StudioMount | null = null
afterEach(() => {
  cleanupMounted()
  s?.restore()
  s = null
  vi.useRealTimers()
})
beforeEach(() => installDomShims({ width: 1366, height: 768 }))

const q = <T extends Element = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel)
const qa = <T extends Element = HTMLElement>(sel: string): T[] => Array.from(document.querySelectorAll<T>(sel))
const tabbable = (root: ParentNode): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>('button, input, select, [tabindex]')).filter(
    (e) => e.tabIndex >= 0 && !(e as HTMLButtonElement).disabled
  )
const live = (): string => q('.studio .sr-only[aria-live="polite"]')?.textContent ?? ''

describe('highlights list (roving tabindex)', () => {
  test('one tab stop in the whole list: the active card only (its buttons included)', async () => {
    s = await mountStudio()
    const cards = qa('.hl-card')
    expect(cards.length).toBe(6)
    const stops = tabbable(q('.hl-list')!)
    expect(stops.length).toBeGreaterThan(0)
    const owners = new Set(stops.map((e) => e.closest('.hl-card')))
    expect(owners.size).toBe(1)
    expect(owners.has(q('.hl-card.active'))).toBe(true)
  })

  test('ArrowDown moves the active card and the focus; Home/End jump to the ends', async () => {
    s = await mountStudio()
    const cards = () => qa('.hl-card')
    focusEl(q('.hl-card.active')!)
    press(document.activeElement as Element, 'ArrowDown')
    expect(document.activeElement).toBe(cards()[1])
    expect(cards()[1].tabIndex).toBe(0)
    expect(cards()[0].tabIndex).toBe(-1)
    press(document.activeElement as Element, 'End')
    expect(document.activeElement).toBe(cards()[5])
    press(document.activeElement as Element, 'Home')
    expect(document.activeElement).toBe(cards()[0])
  })

  test('focusing a button inside a non-active card activates that card without stealing the focus', async () => {
    s = await mountStudio()
    const third = qa('.hl-card')[2]
    const skip = third.querySelector('.hl-skip') as HTMLElement
    focusEl(skip)
    expect(document.activeElement).toBe(skip)
    expect(qa('.hl-card')[2].classList.contains('active')).toBe(true)
  })

  test('Add puts the clip on the project track and shows a Toast whose Undo action reverts both', async () => {
    s = await mountStudio()
    expect(qa('.pclip').length).toBe(0)
    const first = qa('.hl-card')[0]
    click(first.querySelector('.hl-accept')!)
    expect(qa('.pclip').length).toBe(1)
    expect(qa('.hl-card')[0].querySelector('.hl-accepted')).not.toBeNull()
    const undo = q('.toast button')!
    expect(undo.textContent).toBe('復原')
    click(undo)
    expect(qa('.pclip').length).toBe(0)
    expect(qa('.hl-card')[0].querySelector('.hl-accept')).not.toBeNull() // Return to suggestions.
    expect(q('.toast')).toBeNull()
  })
})

describe('project track (roving tabindex + keyboard editing)', () => {
  const items = [
    { id: 'i1', source: STUDIO_VIDEO, start: 10, end: 20 },
    { id: 'i2', source: STUDIO_VIDEO, start: 100, end: 112 },
    { id: 'i3', source: STUDIO_VIDEO, start: 300, end: 315 }
  ]
  const chips = () => qa('.pclip')

  test('chips are one tab stop (the selected chip); the list container is not a second one', async () => {
    s = await mountStudio({ items })
    expect(chips().length).toBe(3)
    expect(chips().filter((c) => c.tabIndex === 0).length).toBe(1)
    expect(q('.track')!.getAttribute('tabindex')).toBeNull()
    expect(chips()[0].classList.contains('sel')).toBe(true)
    expect(chips()[0].tabIndex).toBe(0)
  })

  test('ArrowRight/Left move the selection and the focus; Home/End jump', async () => {
    s = await mountStudio({ items })
    focusEl(chips()[0])
    press(chips()[0], 'ArrowRight')
    expect(document.activeElement).toBe(chips()[1])
    expect(chips()[1].classList.contains('sel')).toBe(true)
    expect(chips()[1].tabIndex).toBe(0)
    expect(chips()[0].tabIndex).toBe(-1)
    press(document.activeElement as Element, 'End')
    expect(document.activeElement).toBe(chips()[2])
    press(document.activeElement as Element, 'Home')
    expect(document.activeElement).toBe(chips()[0])
  })

  test('Alt+ArrowRight moves the chip one step later (order changes, focus stays on the moved chip)', async () => {
    s = await mountStudio({ items })
    focusEl(chips()[0])
    press(chips()[0], 'ArrowRight') // Select i2.
    press(document.activeElement as Element, 'ArrowRight', { altKey: true })
    expect(chips().map((c) => c.getAttribute('data-item-id'))).toEqual(['i1', 'i3', 'i2'])
    expect((document.activeElement as HTMLElement).getAttribute('data-item-id')).toBe('i2')
    press(document.activeElement as Element, 'ArrowLeft', { altKey: true })
    expect(chips().map((c) => c.getAttribute('data-item-id'))).toEqual(['i1', 'i2', 'i3'])
  })

  test('Delete removes the selected chip with a Toast; Undo puts it back', async () => {
    s = await mountStudio({ items })
    focusEl(chips()[1])
    press(chips()[1], 'Delete')
    expect(chips().map((c) => c.getAttribute('data-item-id'))).toEqual(['i1', 'i3'])
    const undo = q('.toast button')!
    expect(undo.textContent).toBe('復原')
    click(undo)
    expect(chips().map((c) => c.getAttribute('data-item-id'))).toEqual(['i1', 'i2', 'i3'])
  })

  test('Delete in the highlights list skips the suggestion and offers Undo (zone keys do not leak across lists)', async () => {
    s = await mountStudio({ items })
    focusEl(q('.hl-card.active')!)
    press(document.activeElement as Element, 'Delete')
    expect(chips().length).toBe(3) // The project timeline is unaffected.
    expect(q('.toast button')?.textContent).toBe('復原')
  })
})

describe('keyboard announcements (aria-live)', () => {
  test('Ctrl+→ announces type, time, counted state and reason of the event it jumps to', async () => {
    const events: EngineEvent[] = [
      { id: 'e1', t: 60, type: 'knock', score: 0.9, damage_line: false, name_sig: null, counted: true, counted_reason: 'first', counted_override: null, source: 'auto' },
      { id: 'e2', t: 120, type: 'elim', score: 0.9, damage_line: false, name_sig: null, counted: false, counted_reason: 'spectating', counted_override: null, source: 'auto' }
    ]
    s = await mountStudio({ doc: (d) => ({ ...d, events }), clips: [] })
    const { act: _ } = { act }
    void _
    press(document.body, 'ArrowRight', { ctrlKey: true })
    await flush()
    expect(live()).toBe(`${eventAriaLabel(events[0])}`)
    expect(live()).toContain('計入')
  // Throttle: send the second announcement after the interval, including the excluded state and reason.
    press(document.body, 'ArrowRight', { ctrlKey: true })
    await flush(900)
    expect(live()).toBe(eventAriaLabel(events[1]))
    expect(live()).toContain('不計入')
    expect(live()).toContain('：')
  })


})

describe('shortcuts help + dialogs inside the studio', () => {
  test('"?" opens the help, Esc closes it, focus returns to where it was', async () => {
    s = await mountStudio()
    const card = q('.hl-card.active')!
    focusEl(card)
    press(card, '?', { shiftKey: true })
    const d = q('[role="dialog"][aria-labelledby="sc-title"]')
    expect(d).not.toBeNull()
  // While open, studio shortcuts underneath are paused (Space does not play; Delete does not skip).
    press(document.activeElement as Element, 'Delete')
    expect(q('.toast')).toBeNull()
    press(document.body, 'Escape')
    expect(q('[role="dialog"][aria-labelledby="sc-title"]')).toBeNull()
    expect(document.activeElement).toBe(card)
  })

  test('M opens the add-event dialog; Esc closes it and returns focus', async () => {
    s = await mountStudio()
    const card = q('.hl-card.active')!
    focusEl(card)
    press(card, 'm')
    const d = q('.add-event[role="dialog"]')!
    expect(d.getAttribute('aria-labelledby')).toBeTruthy()
    press(document.activeElement as Element, 'Escape')
    expect(q('.add-event')).toBeNull()
    expect(document.activeElement).toBe(card)
  })
})


describe('Studio Space-key arbitration', () => {
  const release = (target: Element): KeyboardEvent => {
    const event = new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true, cancelable: true })
    act(() => { target.dispatchEvent(event) })
    return event
  }

  test('After split or duplicate, Space only toggles playback and does not operate on the clip again', async () => {
    s = await mountStudio({ items: [{ id: 'i1', source: STUDIO_VIDEO, start: 10, end: 20 }] })
    click(q('.pclip')!)
    act(() => { q<HTMLVideoElement>('video')!.currentTime = 15 })
    const split = q('[aria-label="分割"]')!
    focusEl(split)
    click(split)
    expect(qa('.pclip')).toHaveLength(2)
    expect(press(split, ' ').defaultPrevented).toBe(true)
    expect(release(split).defaultPrevented).toBe(true)
    expect(qa('.pclip')).toHaveLength(2)
    const duplicate = q('[aria-label="複製片段 (Ctrl+D)"]')!
    focusEl(duplicate)
    click(duplicate)
    expect(qa('.pclip')).toHaveLength(3)
    expect(press(duplicate, ' ').defaultPrevented).toBe(true)
    expect(release(duplicate).defaultPrevented).toBe(true)
    expect(qa('.pclip')).toHaveLength(3)
  })

  test('All studio buttons prevent Space’s native click; holding Space does not toggle playback repeatedly', async () => {
    s = await mountStudio()
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play')
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause')
    for (const button of qa<HTMLButtonElement>('.studio button').filter((b) => !b.disabled)) {
      focusEl(button)
      play.mockClear()
      pause.mockClear()
      expect(press(button, ' ').defaultPrevented).toBe(true)
      expect(press(button, ' ', { repeat: true }).defaultPrevented).toBe(true)
      expect(release(button).defaultPrevented).toBe(true)
      expect(play.mock.calls.length + pause.mock.calls.length).toBe(1)
    }
    play.mockRestore()
    pause.mockRestore()
  })

  test('Rename fields and IME composition preserve space input', async () => {
    s = await mountStudio()
    const input = q<HTMLInputElement>('.pname')!
    focusEl(input)
    expect(press(input, ' ').defaultPrevented).toBe(false)
    expect(release(input).defaultPrevented).toBe(false)
    expect(press(input, ' ', { isComposing: true }).defaultPrevented).toBe(false)
  })
})
