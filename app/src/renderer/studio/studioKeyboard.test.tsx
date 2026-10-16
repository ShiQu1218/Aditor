// @vitest-environment jsdom
// 工作室鍵盤路徑的整合測試：真的掛載 StudioScreen（假 api），以真實 keydown 事件驅動。
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
const tab = (name: string): HTMLElement =>
  qa('[role="tab"]').find((t) => (t.textContent ?? '').includes(name)) as HTMLElement
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

  test('〔加入〕 adds the clip to the project track and shows a Toast whose 〔復原〕 reverts both', async () => {
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
    expect(qa('.hl-card')[0].querySelector('.hl-accept')).not.toBeNull() // 回到建議
    expect(q('.toast')).toBeNull()
  })
})

describe('aside tablist (roving tabindex)', () => {
  test('only the selected tab is a tab stop; arrows/Home/End switch tabs and move focus', async () => {
    s = await mountStudio()
    const tabs = () => qa('.aside-tab')
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1])
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true')
    focusEl(tabs()[0])
    press(tabs()[0], 'ArrowRight')
    await flush()
    expect(tabs()[1].getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabs()[1])
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, 0])
    press(tabs()[1], 'Home')
    await flush()
    expect(document.activeElement).toBe(tabs()[0])
    expect(q('.hl-tab')).not.toBeNull()
    press(tabs()[0], 'End')
    await flush()
    expect(q('.ev-tab')).not.toBeNull()
  })

  test('tabs control their panels (aria-controls ↔ labelledby)', async () => {
    s = await mountStudio()
    const selected = qa('.aside-tab').find((t) => t.getAttribute('aria-selected') === 'true')!
    const panel = document.getElementById(selected.getAttribute('aria-controls')!)!
    expect(panel.getAttribute('role')).toBe('tabpanel')
    expect(panel.getAttribute('aria-labelledby')).toBe(selected.id)
  })
})

describe('events list (roving tabindex + virtualization)', () => {
  test('one tab stop; End/Home scroll the virtualized list and keep the focus on a rendered row', async () => {
    s = await mountStudio()
    click(tab('事件'))
    await flush()
    const rows = () => qa('.ev-row')
    expect(rows().length).toBeGreaterThan(5)
    expect(rows().length).toBeLessThan(80) // 虛擬化
    const owners = new Set(tabbable(q('.ev-scroll')!).map((e) => e.closest('.ev-row')))
    expect(owners.size).toBe(1)
    const first = rows()[0]
    focusEl(first)
    press(first, 'End')
    await flush()
    const focused = document.activeElement as HTMLElement
    expect(focused.classList.contains('ev-row')).toBe(true)
    expect(focused.tabIndex).toBe(0)
    expect((q('.ev-scroll') as HTMLElement).scrollTop).toBeGreaterThan(0)
    const lastId = s.doc.events.filter((e) => ['knock', 'assist_knock', 'assist_elim', 'elim', 'squad_wipe'].includes(e.type)).slice(-1)[0].id
    expect(focused.getAttribute('aria-label')).toBe(eventAriaLabel(s.doc.events.find((e) => e.id === lastId)!))
    press(focused, 'Home')
    await flush()
    expect(document.activeElement).toBe(rows()[0])
    expect((q('.ev-scroll') as HTMLElement).scrollTop).toBe(0)
  })

  test('controls inside a non-active row are not tab stops', async () => {
    s = await mountStudio()
    click(tab('事件'))
    await flush()
    const rows = qa('.ev-row')
    for (const r of rows.slice(1, 4)) {
      for (const c of Array.from(r.querySelectorAll<HTMLElement>('input, button'))) expect(c.tabIndex).toBe(-1)
    }
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
    press(chips()[0], 'ArrowRight') // 選 i2
    press(document.activeElement as Element, 'ArrowRight', { altKey: true })
    expect(chips().map((c) => c.getAttribute('data-item-id'))).toEqual(['i1', 'i3', 'i2'])
    expect((document.activeElement as HTMLElement).getAttribute('data-item-id')).toBe('i2')
    press(document.activeElement as Element, 'ArrowLeft', { altKey: true })
    expect(chips().map((c) => c.getAttribute('data-item-id'))).toEqual(['i1', 'i2', 'i3'])
  })

  test('Delete removes the selected chip with a Toast; 〔復原〕 puts it back', async () => {
    s = await mountStudio({ items })
    focusEl(chips()[1])
    press(chips()[1], 'Delete')
    expect(chips().map((c) => c.getAttribute('data-item-id'))).toEqual(['i1', 'i3'])
    const undo = q('.toast button')!
    expect(undo.textContent).toBe('復原')
    click(undo)
    expect(chips().map((c) => c.getAttribute('data-item-id'))).toEqual(['i1', 'i2', 'i3'])
  })

  test('Delete in the highlights list skips the suggestion and offers 〔復原〕 (zone keys do not leak across lists)', async () => {
    s = await mountStudio({ items })
    focusEl(q('.hl-card.active')!)
    press(document.activeElement as Element, 'Delete')
    expect(chips().length).toBe(3) // 專案軌不受影響
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
    // 限速：第二則在間隔後補送，且包含「不計入」與原因
    press(document.body, 'ArrowRight', { ctrlKey: true })
    await flush(900)
    expect(live()).toBe(eventAriaLabel(events[1]))
    expect(live()).toContain('不計入')
    expect(live()).toContain('：')
  })

  test('changing the selection announces the new count', async () => {
    s = await mountStudio()
    click(tab('事件'))
    await flush()
    const cb = q<HTMLInputElement>('.ev-row input[type="checkbox"]')!
    click(cb)
    await flush()
    expect(live()).toContain('已選取 1 個事件')
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
    // 開啟期間底下的工作室快捷鍵暫停（Space 不播放、Delete 不略過）
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
