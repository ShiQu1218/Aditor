// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import App from '../App'
import type { LibraryEntry } from '../../main/library'
import { buildLongDoc } from '../dev/longFixture'
import { createFakeApi, installFakeApi, type FakeApi } from '../../../test/fakeApi'
import { cleanupMounted, click, flush, installDomShims, mount, buttonByText } from '../../../test/dom'
import { mountStudio, STUDIO_VIDEO, type StudioMount } from '../../../test/studioHarness'
import { shellI18n, i18n } from '../i18n'

const A = 'D:/Apex_2026-10-18_01-00.mp4'
const B = 'D:/Apex_2026-10-18_23-00_2.mp4'
const entry = (path: string, addedAt = 1): LibraryEntry => ({ path, addedAt, status: 'done', favorite: false, progress: 1 })
let fake: FakeApi
let restore: (() => void) | undefined
let studio: StudioMount | undefined
beforeEach(() => { installDomShims() })
afterEach(() => { cleanupMounted(); restore?.(); restore = undefined; studio?.restore(); studio = undefined; vi.restoreAllMocks() })
async function start(entries: LibraryEntry[], autoSuggestOnOpen = false) {
  fake = createFakeApi({ entries, settings: { autoSuggestOnOpen }, overrides: {
    cache: { loadByVideo: vi.fn(async (path: string) => ({ ...buildLongDoc(path), clips: [] })) },
    engine: { autoclip: async () => ({ clips: [{ id: 'ai-test', start: 1, end: 3, origin: 'ai', event_ids: [] }] }) }
  } })
  restore = installFakeApi(fake)
  mount(<App />)
  await flush()
}
const navigate = (view: 'studio' | 'library' | 'settings') => click(document.querySelector(`[aria-label="${view === 'studio' ? shellI18n.rail.studioLabel : shellI18n.rail[view]}"]`)!)
const requestRemoval = async () => {
  click(document.querySelector('.studio-file-row .studio-video-remove')!)
  await flush()
  await act(async () => {
    click(buttonByText(document.querySelector('[role="dialog"]')!, i18n.library.card.removeFromLibrary)!)
  })
}

describe('Studio navigation', () => {
  test.each([true, false])('removing the current video stays in the studio and clears its selection; another video exists: %s', async (hasOtherVideo) => {
    await start([entry(A), ...(hasOtherVideo ? [entry(B)] : [])])
    navigate('studio'); await flush()
    const remaining = hasOtherVideo ? [entry(A)] : []
    fake.api.library.remove.mockImplementation(async () => { fake.setEntries(remaining); return undefined })
    await requestRemoval(); await flush()
    expect(document.querySelector('.lib-screen')).toBeNull()
    expect(document.querySelector('[aria-current="page"]')?.getAttribute('aria-label')).toBe(shellI18n.rail.studioLabel)
    if (hasOtherVideo) expect(document.querySelector('.studio-file')?.textContent).toBe(remaining[0].path.split('/').pop())
    else expect(document.querySelector('.studio-blocked')?.textContent).toContain('尚未有影片')
  })

  test('a delayed removal preserves the settings page and clears the removed selection', async () => {
    await start([entry(A)])
    navigate('studio'); await flush()
    let complete!: () => void
    fake.api.library.remove.mockImplementation(() => new Promise<undefined>((resolve) => {
      complete = () => { fake.setEntries([]); resolve(undefined) }
    }))
    await requestRemoval()
    navigate('settings'); await flush()
    await act(async () => complete()); await flush()
    expect(document.querySelector('[aria-current="page"]')?.getAttribute('aria-label')).toBe(shellI18n.rail.settings)
    expect(document.querySelector('.lib-screen')).toBeNull()
    navigate('studio'); await flush()
    expect(document.querySelector('.studio-blocked')?.textContent).toContain('尚未有影片')
  })

  test('When no video is open, opens the most recently recorded item; returning to the studio keeps the current video', async () => {
    await start([entry(A, Date.now()), entry(B), entry('D:/舊影片.mp4', new Date(2026, 9, 17).getTime())])
    navigate('studio'); await flush()
    expect(document.querySelector('.studio-file')?.textContent).toBe('Apex_2026-10-18_23-00_2.mp4')
    navigate('library'); await flush()
    fake.setEntries([entry(A), entry(B), entry('D:/更新的影片.mp4', new Date(2026, 9, 19).getTime())])
    navigate('studio'); await flush()
    expect(document.querySelector('.studio-file')?.textContent).toBe('Apex_2026-10-18_23-00_2.mp4')
  })
  test('Uses addedAt to determine the newest non-recording video', async () => {
    await start([entry(A), entry('D:/最新匯入.mp4', new Date(2026, 9, 19).getTime())])
    navigate('studio'); await flush()
    expect(document.querySelector('.studio-file')?.textContent).toBe('最新匯入.mp4')
  })
  test('Opens the studio while the newest video is still analyzing; the same-day list can switch to a completed video', async () => {
    await start([entry(A), { ...entry(B), status: 'analyzing' }])
    navigate('studio'); await flush()
    expect(document.querySelector('.studio-blocked')?.textContent).toContain(i18n.studio.openBlocked)
    expect(document.querySelector('.same-day-card[aria-current]')?.textContent).toContain('23:00')
    click(document.querySelector('.same-day-card:not([aria-current])')!)
    await flush()
    expect(document.querySelector('.studio-file')?.textContent).toBe('Apex_2026-10-18_01-00.mp4')
  })
  test('queued analysis reloads only when the selected video has a usable completed cache', async () => {
    await start([entry(A)])
    const loadCache = vi.spyOn(window.api.cache, 'loadByVideo').mockResolvedValue(null)
    fake.api.engine.analyze.mockImplementation(async () => {
      fake.setEntries([{ ...entry(A), status: 'pending' }])
      return null
    })
    navigate('studio'); await flush()
    await act(async () => fake.emit('library:updated', { queue: { analyzing: null, queued: [A], waitingForGame: true }, current: null }))
    await flush()
    expect(document.querySelector('.studio-blocked')?.textContent).toContain(i18n.queue.waitingForGame)
    expect(document.querySelector('.studio-blocked')?.textContent).not.toContain(i18n.studio.openBlocked)
    fake.setEntries([{ ...entry(A), status: 'pending' }, entry(B)])
    await act(async () => fake.emit('library:updated')); await flush()
    expect(document.querySelector('.studio-file')).toBeNull()
    fake.setEntries([entry(A)])
    await act(async () => fake.emit('library:updated')); await flush()
    expect(document.querySelector('.studio-file')).toBeNull()
    loadCache.mockResolvedValue({ ...buildLongDoc(A), analysis: { ...buildLongDoc(A).analysis, status: 'partial' } })
    await act(async () => fake.emit('library:updated')); await flush()
    expect(document.querySelector('.studio-file')).toBeNull()
    loadCache.mockResolvedValue({ ...buildLongDoc(A), clips: [] })
    await act(async () => fake.emit('library:updated')); await flush()
    expect(document.querySelector('.studio-file')?.textContent).toBe(A.split('/').pop())
    expect(fake.api.engine.analyze).toHaveBeenCalledTimes(1)
  })

  test('queued completion during an in-flight cache read is not lost', async () => {
    await start([entry(A)])
    const loadCache = vi.spyOn(window.api.cache, 'loadByVideo').mockResolvedValue(null)
    navigate('studio'); await flush()
    let resolve!: (doc: null) => void
    loadCache.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    await act(async () => fake.emit('library:updated')); await flush()
    loadCache.mockResolvedValue({ ...buildLongDoc(A), clips: [] })
    await act(async () => fake.emit('library:updated'))
    await act(async () => resolve(null)); await flush()
    expect(document.querySelector('.studio-file')?.textContent).toBe(A.split('/').pop())
    expect(fake.api.engine.analyze).toHaveBeenCalledTimes(1)
  })

  test('queued analysis failure surfaces the existing load error state', async () => {
    await start([entry(A)])
    vi.spyOn(window.api.cache, 'loadByVideo').mockResolvedValue(null)
    navigate('studio'); await flush()
    fake.setEntries([{ ...entry(A), status: 'error', error: 'Analysis failed', errorCode: 'unknown_game' }])
    await act(async () => fake.emit('library:updated')); await flush()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(i18n.studio.loadFailed.title)
    expect(document.querySelector('.studio-error-detail')?.textContent).toBe('Analysis failed')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('unknown_game')
    expect(document.querySelector('.studio-file')).toBeNull()
  })

  test('ordinary blocked analysis does not reload on library completion', async () => {
    await start([{ ...entry(A), status: 'pending' }])
    navigate('studio'); await flush()
    expect(document.querySelector('.studio-blocked')?.textContent).toContain(i18n.studio.openBlocked)
    fake.setEntries([entry(A)])
    await act(async () => fake.emit('library:updated')); await flush()
    expect(document.querySelector('.studio-blocked')?.textContent).toContain(i18n.studio.openBlocked)
    expect(fake.api.engine.analyze).not.toHaveBeenCalled()
    expect(fake.api.cache.loadByVideo).not.toHaveBeenCalled()
  })

  test('Empty library stays in the studio empty state with a button back to the library', async () => {
    await start([])
    navigate('studio'); await flush()
    expect(document.querySelector('.studio-blocked')?.textContent).toContain('尚未有影片')
    expect(document.querySelector('[aria-current="page"]')?.getAttribute('aria-label')).toBe(shellI18n.rail.studioLabel)
    click(buttonByText(document, i18n.studio.back)!)
    await flush()
    expect(document.querySelector('.lib-screen')).not.toBeNull()
  })
  test('Library load failure shows a retryable error; a late response after leaving does not reopen the studio', async () => {
    await start([])
    fake.api.library.getEntries.mockRejectedValueOnce(new Error('讀取失敗'))
    navigate('studio'); await flush()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('讀取')
    let resolve!: (entries: LibraryEntry[]) => void
    fake.api.library.getEntries.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    click(buttonByText(document, '重試')!)
    navigate('library'); await flush()
    resolve([entry(B)]); await flush()
    expect(document.querySelector('.lib-screen')).not.toBeNull()
  })
  test('Same-day navigation synchronously saves source edits; on failure, keeps the current video and shows a notice until retry succeeds', async () => {
    const onOpenVideo = vi.fn()
    studio = await mountStudio({ onOpenVideo, api: { entries: [entry(STUDIO_VIDEO), entry('D:/另一場.mp4')] } })
    click(document.querySelector('.hl-accept')!)
    await flush()
    const save = studio.fake.api.cache.saveSync.mockReturnValueOnce(false)
    const target = document.querySelector<HTMLButtonElement>('.same-day-card:not([aria-current])')!
    click(target)
    expect(onOpenVideo).not.toHaveBeenCalled()
    expect(document.querySelector('.toast-host')?.textContent ?? document.body.textContent).toContain(i18n.studio.toast.sourceSaveFailed)
    click(target)
    expect(onOpenVideo).toHaveBeenCalledWith('D:/另一場.mp4', undefined)
    expect(save.mock.invocationCallOrder.at(-1)).toBeLessThan(onOpenVideo.mock.invocationCallOrder[0])
  })

  test('sidebar navigation keeps Studio open when saving source edits fails', async () => {
    await start([entry(A)], true)
    navigate('studio'); await flush(20)
    click(document.querySelector('.hl-card .hl-accept')!)
    await flush()
    fake.api.cache.saveSync.mockReturnValueOnce(false)
    navigate('settings'); await flush()
    expect(document.querySelector('[aria-current="page"]')?.getAttribute('aria-label')).toBe(shellI18n.rail.studioLabel)
    navigate('settings'); await flush()
    expect(document.querySelector('[aria-current="page"]')?.getAttribute('aria-label')).toBe(shellI18n.rail.settings)
  })
})
