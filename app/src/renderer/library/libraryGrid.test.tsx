// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { LibraryScreen } from './LibraryScreen'
import type { LibraryEntry } from '../../main/library'
import { makeLibraryFixture } from '../dev/libraryFixture'
import { createFakeApi, installFakeApi, type FakeApi } from '../../../test/fakeApi'
import { Providers } from '../../../test/harness'
import { cleanupMounted, flush, focusEl, installDomShims, mount, press } from '../../../test/dom'

const NOW = Date.now()
const DAY = 24 * 60 * 60 * 1000

/** 60 張卡分成兩個日期分組（今天 30、前天 30），順序＝索引 */
function testEntries(): LibraryEntry[] {
  return makeLibraryFixture(60, NOW).map((e, i) => ({
    ...e,
    status: 'done' as const,
    error: undefined,
    addedAt: (i < 30 ? NOW - 60_000 : NOW - 2 * DAY - 60_000) - i * 1000
  }))
}

function cards(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.vcard'))
}
function openBtn(card: Element): HTMLButtonElement {
  return card.querySelector('.vcard-open') as HTMLButtonElement
}
function tabStops(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.vcard button')).filter((b) => b.tabIndex === 0)
}

describe('library grid: roving tabindex + arrow navigation (jsdom, real keyboard events)', () => {
  let fake: FakeApi
  let restore: () => void
  let container: HTMLElement

  beforeEach(async () => {
    installDomShims({ width: 1200, height: 700 }) // 4 columns
    // 60 張卡：遠多於一個視窗，才能驗證虛擬化後游標卡片仍會被渲染並取得焦點
    fake = createFakeApi({ entries: testEntries() })
    restore = installFakeApi(fake)
    const m = mount(
      <Providers>
        <LibraryScreen onSelectVideo={() => undefined} onOpenSettings={() => undefined} />
      </Providers>
    )
    container = m.container
    await flush()
  })
  afterEach(() => {
    cleanupMounted()
    restore()
    vi.restoreAllMocks()
  })

  test('the grid is a single tab stop: only the first card (and its own controls) is tabbable', () => {
    const all = cards(container)
    expect(all.length).toBeGreaterThan(4)
    expect(all.length).toBeLessThan(60) // 虛擬化：沒有渲染全部
    expect(openBtn(all[0]).tabIndex).toBe(0)
    // 其餘卡片的所有控制項都不在 Tab 順序內
    for (const c of all.slice(1)) {
      for (const b of Array.from(c.querySelectorAll('button'))) expect(b.tabIndex, b.getAttribute('aria-label') ?? b.textContent ?? '').toBe(-1)
    }
    expect(tabStops(container).every((b) => all[0].contains(b))).toBe(true)
  })

  test('ArrowRight/Left move the cursor and focus; the tab stop follows', () => {
    const first = openBtn(cards(container)[0])
    focusEl(first)
    press(first, 'ArrowRight')
    const second = openBtn(cards(container)[1])
    expect(document.activeElement).toBe(second)
    expect(second.tabIndex).toBe(0)
    expect(first.tabIndex).toBe(-1)
    press(second, 'ArrowLeft')
    expect(document.activeElement).toBe(first)
  })

  test('ArrowDown moves one row (4 columns) and ArrowUp comes back', () => {
    const list = cards(container)
    focusEl(openBtn(list[1]))
    press(document.activeElement as Element, 'ArrowDown')
    expect(document.activeElement).toBe(openBtn(cards(container)[5]))
    press(document.activeElement as Element, 'ArrowUp')
    expect(document.activeElement).toBe(openBtn(cards(container)[1]))
  })

  test('End jumps to the last card even though it is virtualized away: it is scrolled in, rendered and focused', () => {
    const scroller = container.querySelector('.lib-scroll') as HTMLElement
    const lastPath = testEntries()[59].path
    expect(cards(container).some((c) => c.getAttribute('data-vcard-path') === lastPath)).toBe(false)
    const first = openBtn(cards(container)[0])
    focusEl(first)
    press(first, 'End')
    const focused = document.activeElement as HTMLElement
    expect(focused.closest('.vcard')?.getAttribute('data-vcard-path')).toBe(lastPath)
    expect(scroller.scrollTop).toBeGreaterThan(0)
    // Home 回到第一張並捲回頂端
    press(focused, 'Home')
    expect((document.activeElement as HTMLElement).closest('.vcard')?.getAttribute('data-vcard-path')).toBe(testEntries()[0].path)
    expect(scroller.scrollTop).toBe(0)
  })

  test('arrow keys on the secondary buttons of a card keep their native meaning (no cursor move)', () => {
    const c0 = cards(container)[0]
    const fav = c0.querySelector('.vcard-fav') as HTMLElement
    focusEl(fav)
    const e = press(fav, 'ArrowRight')
    expect(e.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(fav)
  })

  test('focusing a card with the mouse makes it the single tab stop', () => {
    const c3 = cards(container)[3]
    const open3 = openBtn(c3)
    focusEl(open3)
    expect(open3.tabIndex).toBe(0)
    expect(openBtn(cards(container)[0]).tabIndex).toBe(-1)
  })
})
