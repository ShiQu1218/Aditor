// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { LibraryScreen } from './LibraryScreen'
import type { LibraryEntry } from '../../main/library'
import { createFakeApi, installFakeApi, type FakeApi } from '../../../test/fakeApi'
import { Providers } from '../../../test/harness'
import { cleanupMounted, click, flush, focusEl, installDomShims, mount, press } from '../../../test/dom'

const NOW = Date.now()
const base = (name: string, over: Partial<LibraryEntry> = {}): LibraryEntry => ({
  path: `D:/v/${name}.mp4`,
  addedAt: NOW,
  favorite: false,
  status: 'done',
  progress: 1,
  durationSec: 600,
  counts: { knock: 2, assist: 1 },
  hl: 3,
  codec: 'h264',
  ...over
})

describe('VideoCard keyboard/pointer activation', () => {
  let fake: FakeApi
  let restore: () => void
  const onSelect = vi.fn()

  beforeEach(async () => {
    installDomShims()
    onSelect.mockClear()
    fake = createFakeApi({
      entries: [
        base('done-card', { addedAt: NOW }),
        base('busy-card', { addedAt: NOW - 1000, status: 'analyzing', progress: 0.4, analyzingSince: NOW - 5000, counts: undefined, hl: 0 }),
        base('err-card', { addedAt: NOW - 2000, status: 'error', error: 'moov atom not found', counts: undefined, hl: 0 })
      ]
    })
    restore = installFakeApi(fake)
    mount(
      <Providers>
        <LibraryScreen onSelectVideo={onSelect} onOpenSettings={() => undefined} />
      </Providers>
    )
    await flush()
  })
  afterEach(() => {
    cleanupMounted()
    restore()
    vi.restoreAllMocks()
  })

  const card = (name: string): HTMLElement =>
    Array.from(document.querySelectorAll<HTMLElement>('.vcard')).find((c) => c.dataset.vcardPath?.includes(name))!

  test('the only "open" control is .vcard-open; secondary buttons are siblings, never nested inside it', () => {
    for (const c of Array.from(document.querySelectorAll('.vcard'))) {
      const open = c.querySelector('.vcard-open')!
      expect(open.querySelector('button, a, input')).toBeNull() // No nested interactive elements.
      for (const b of Array.from(c.querySelectorAll('button')).filter((x) => x !== open)) expect(open.contains(b)).toBe(false)
    }
  })

  test('activating a secondary button (favorite / ⋯ / retry / remove) never opens the video', () => {
    const done = card('done-card')
    focusEl(done.querySelector('.vcard-fav') as HTMLElement)
    press(document.activeElement as Element, 'Enter') // keydown alone does not open it.
    press(document.activeElement as Element, ' ')
    click(done.querySelector('.vcard-fav')!)
    expect(fake.api.library.toggleFavorite).toHaveBeenCalledWith(done.dataset.vcardPath)
    click(done.querySelector('.vcard-more')!)
    expect(onSelect).not.toHaveBeenCalled()
    press(document.activeElement as Element, 'Escape') // Close the menu.
    const err = card('err-card')
    click(Array.from(err.querySelectorAll('button')).find((b) => b.textContent === '重試')!)
    expect(fake.api.queue.enqueue).toHaveBeenCalledWith(err.dataset.vcardPath)
    expect(onSelect).not.toHaveBeenCalled()
  })

  test('the main button opens a finished video; an analyzing card gives a Toast instead of opening', () => {
    click(card('done-card').querySelector('.vcard-open')!)
    expect(onSelect).toHaveBeenCalledWith(card('done-card').dataset.vcardPath)
    onSelect.mockClear()
    click(card('busy-card').querySelector('.vcard-open')!)
    expect(onSelect).not.toHaveBeenCalled()
    expect(document.querySelector('.toast')).not.toBeNull()
  })

  test('the main button announces its state in its accessible name (not colour alone)', () => {
    expect(card('err-card').querySelector('.vcard-open')!.getAttribute('aria-label')).toContain('分析失敗')
    expect(card('busy-card').querySelector('.vcard-open')!.getAttribute('aria-label')).toContain('分析中')
    expect(card('done-card').querySelector('.vcard-open')!.getAttribute('aria-label')).toBe('done-card')
  })
})
