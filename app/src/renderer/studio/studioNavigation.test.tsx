// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import App from '../App'
import type { LibraryEntry } from '../../main/library'
import { buildLongDoc } from '../dev/longFixture'
import { createFakeApi, installFakeApi, type FakeApi } from '../../../test/fakeApi'
import { cleanupMounted, click, flush, installDomShims, mount, buttonByText } from '../../../test/dom'
import { mountStudio, STUDIO_VIDEO, type StudioMount } from '../../../test/studioHarness'
import { shellI18n, i18n } from '../i18n/zh-TW'

const A = 'D:/Apex_2026-10-18_01-00.mp4'
const B = 'D:/Apex_2026-10-18_23-00_2.mp4'
const entry = (path: string, addedAt = 1): LibraryEntry => ({ path, addedAt, status: 'done', favorite: false, progress: 1 })
let fake: FakeApi
let restore: (() => void) | undefined
let studio: StudioMount | undefined
beforeEach(() => { installDomShims() })
afterEach(() => { cleanupMounted(); restore?.(); restore = undefined; studio?.restore(); studio = undefined; vi.restoreAllMocks() })
async function start(entries: LibraryEntry[]) {
  fake = createFakeApi({ entries, settings: { autoSuggestOnOpen: false }, overrides: { cache: {
    loadByVideo: async (path: string) => ({ ...buildLongDoc(path), clips: [] })
  } } })
  restore = installFakeApi(fake)
  mount(<App />)
  await flush()
}
const navigate = (view: 'studio' | 'library' | 'settings') => click(document.querySelector(`[aria-label="${view === 'studio' ? shellI18n.rail.studioLabel : shellI18n.rail[view]}"]`)!)

describe('工作室導覽', () => {
  test('未開影片時開啟錄影時間最新的項目，回到工作室保留原影片', async () => {
    await start([entry(A, Date.now()), entry(B), entry('D:/舊影片.mp4', new Date(2026, 9, 17).getTime())])
    navigate('studio'); await flush()
    expect(document.querySelector('.studio-file')?.textContent).toBe('Apex_2026-10-18_23-00_2.mp4')
    navigate('library'); await flush()
    fake.setEntries([entry(A), entry(B), entry('D:/更新的影片.mp4', new Date(2026, 9, 19).getTime())])
    navigate('studio'); await flush()
    expect(document.querySelector('.studio-file')?.textContent).toBe('Apex_2026-10-18_23-00_2.mp4')
  })
  test('非錄影檔以 addedAt 決定最新影片', async () => {
    await start([entry(A), entry('D:/最新匯入.mp4', new Date(2026, 9, 19).getTime())])
    navigate('studio'); await flush()
    expect(document.querySelector('.studio-file')?.textContent).toBe('最新匯入.mp4')
  })
  test('最新影片尚在分析仍進入工作室，可由同日影片列切到已完成的影片', async () => {
    await start([entry(A), { ...entry(B), status: 'analyzing' }])
    navigate('studio'); await flush()
    expect(document.querySelector('.studio-blocked')?.textContent).toContain(i18n.studio.openBlocked)
    expect(document.querySelector('.same-day-card[aria-current]')?.textContent).toContain('23:00')
    click(document.querySelector('.same-day-card:not([aria-current])')!)
    await flush()
    expect(document.querySelector('.studio-file')?.textContent).toBe('Apex_2026-10-18_01-00.mp4')
  })
  test('空影片庫停在工作室空狀態，按鈕返回影片庫', async () => {
    await start([])
    navigate('studio'); await flush()
    expect(document.querySelector('.studio-blocked')?.textContent).toContain('尚未有影片')
    expect(document.querySelector('[aria-current="page"]')?.getAttribute('aria-label')).toBe(shellI18n.rail.studioLabel)
    click(buttonByText(document, i18n.studio.back)!)
    await flush()
    expect(document.querySelector('.lib-screen')).not.toBeNull()
  })
  test('影片庫讀取失敗顯示可重試錯誤；離開後延遲回應不會切回工作室', async () => {
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
  test('同日切片同步儲存來源編輯，失敗時保留原影片並提示，重試後才開啟', async () => {
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
})
