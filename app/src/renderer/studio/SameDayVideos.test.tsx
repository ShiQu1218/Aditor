// @vitest-environment jsdom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { LibraryEntry } from '../../main/library'
import { SameDayVideos } from './SameDayVideos'
import { Providers } from '../../../test/harness'
import { createFakeApi, installFakeApi, type FakeApi } from '../../../test/fakeApi'
import { cleanupMounted, click, flush, focusEl, installDomShims, mount } from '../../../test/dom'
import { runAxe } from '../../../test/axe'
import { i18n } from '../i18n'

const A = 'D:/Apex_2026-10-18_00-01.mp4'
const B = 'D:/Apex_2026-10-18_23-59_2.mp4'
const entry = (path: string, over: Partial<LibraryEntry> = {}): LibraryEntry => ({ path, addedAt: new Date(2026, 9, 19).getTime(), status: 'done', favorite: false, progress: 1, ...over })
let fake: FakeApi
let restore: () => void
beforeEach(() => { installDomShims(); fake = createFakeApi(); restore = installFakeApi(fake) })
afterEach(() => { cleanupMounted(); restore(); vi.restoreAllMocks() })
const cards = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.same-day-card'))
function show(path = A, onOpenVideo = vi.fn()) {
  return mount(<Providers active="studio"><SameDayVideos videoPath={path} onOpenVideo={onOpenVideo} /></Providers>)
}

describe('Same-day video list', () => {
  test('Groups by local calendar date, sorts by recording time descending, and shows title, stats, duration, status, and current item', async () => {
    fake.setEntries([entry(A, { thumb: 'D:/縮圖/a #1.jpg', counts: { knock: 3, assist: 2 }, durationSec: 65 }),
      entry(B, { status: 'analyzing' }), entry('D:/午夜前.mp4', { addedAt: new Date(2026, 9, 17, 23, 59).getTime() }),
      entry('D:/一般影片.mkv', { addedAt: new Date(2026, 9, 18, 12).getTime(), status: 'error' })])
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
    show()
    await flush()
    expect(document.querySelector('.same-day-head')?.textContent).toContain('2026年10月18日')
    expect(document.querySelector('.same-day-head')?.textContent).toContain('3 部影片')
    expect(cards().map((c) => c.querySelector('.same-day-title')?.textContent)).toEqual(['23:59', '一般影片', '00:01'])
    expect(cards()[0].textContent).toContain(i18n.library.card.analyzing)
    expect(cards()[1].textContent).toContain(i18n.library.card.error)
    expect(cards()[2].textContent).toContain('擊倒 3')
    expect(cards()[2].textContent).toContain('助攻 2')
    expect(cards()[2].textContent).toContain('1:05')
    expect(cards()[2].getAttribute('aria-current')).toBe('true')
    expect(cards()[2].querySelector('img')?.getAttribute('src')).toContain('a%20%231.jpg')
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
    expect(cards().every((c) => c.tabIndex === 0)).toBe(true)
    focusEl(cards()[0])
    expect(document.activeElement).toBe(cards()[0])
    expect(await runAxe(document.querySelector('.same-day-videos')!)).toEqual([])
  })

  test('Keeps the current video visible, adds new videos from updates, opens selections through onOpenVideo, and unsubscribes on unmount', async () => {
    fake.setEntries([entry(A)])
    const onOpenVideo = vi.fn()
    show(A, onOpenVideo)
    await flush()
    expect(cards()).toHaveLength(1)
    click(cards()[0])
    expect(onOpenVideo).not.toHaveBeenCalled()
    fake.setEntries([entry(A), entry(B)])
    act(() => fake.emit('library:updated'))
    await flush()
    click(cards()[0])
    expect(onOpenVideo).toHaveBeenCalledWith(B)
    cleanupMounted()
    fake.api.library.getEntries.mockClear()
    act(() => fake.emit('library:updated'))
    await flush()
    expect(fake.api.library.getEntries).not.toHaveBeenCalled()
  })

  test('Keeps the strip scroll offset when the studio remounts for the selected video', async () => {
    fake.setEntries([entry(A), entry(B)])
    show(A)
    await flush()
    const list = document.querySelector<HTMLDivElement>('.same-day-list')!
    list.scrollLeft = 240
    act(() => { list.dispatchEvent(new Event('scroll')) })
    cleanupMounted()
    show(B)
    await flush()
    expect(document.querySelector<HTMLDivElement>('.same-day-list')!.scrollLeft).toBe(240)
  })

  test('Collapsed preference is saved through settings, persists on remount, and does not write back the default', async () => {
    fake.setEntries([entry(A)])
    show()
    await flush()
    click(document.querySelector('.same-day-head button')!)
    await flush()
    expect(fake.api.settings.set).toHaveBeenCalledWith({ sameDayVideosCollapsed: true })
    expect(cards()).toHaveLength(0)
    cleanupMounted()
    fake.api.settings.set.mockClear()
    show()
    await flush()
    expect(document.querySelector('.same-day-head button')?.getAttribute('aria-expanded')).toBe('false')
    expect(fake.api.settings.set).not.toHaveBeenCalled()
    click(document.querySelector('.same-day-head button')!)
    await flush()
    expect(cards()).toHaveLength(1)
  })

  test.each(['未寫入', '拒絕'] as const)('reports failure to save the collapse preference: %s', async (failure) => {
    fake = createFakeApi({ entries: [entry(A)], overrides: { settings: { set: async () => {
      if (failure === '拒絕') throw new Error('寫入失敗')
      return { settings: { sameDayVideosCollapsed: true }, persisted: false }
    } } } })
    restore(); restore = installFakeApi(fake)
    show(); await flush()
    click(document.querySelector('.same-day-head button')!)
    await flush()
    expect(document.querySelector('.toast')?.textContent).toContain('儲存失敗')
  })

  test('A slow settings read does not write back the default or overwrite a newer settings update', async () => {
    fake.setEntries([entry(A)])
    const resolves: Array<(settings: ReturnType<typeof fake.getSettings>) => void> = []
    fake.api.settings.get.mockImplementation(() => new Promise((done) => { resolves.push(done) }))
    show(); await flush()
    expect(document.querySelector<HTMLButtonElement>('.same-day-head button')?.disabled).toBe(true)
    expect(fake.api.settings.set).not.toHaveBeenCalled()
    act(() => fake.emit('settings:changed', { sameDayVideosCollapsed: true }))
    expect(cards()).toHaveLength(0)
    await act(async () => { resolves.forEach((resolve) => resolve({ ...fake.getSettings(), sameDayVideosCollapsed: false })) })
    expect(cards()).toHaveLength(0)
    expect(fake.api.settings.set).not.toHaveBeenCalled()
  })

  test('A slower old library response does not overwrite a live update', async () => {
    let resolve!: (entries: LibraryEntry[]) => void
    fake.api.library.getEntries.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    fake.setEntries([entry(A), entry(B)])
    show()
    act(() => fake.emit('library:updated'))
    await flush()
    await act(async () => resolve([entry(A)]))
    expect(cards()).toHaveLength(2)
  })
})
