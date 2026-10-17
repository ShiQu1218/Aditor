// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest'
import { buttonByText, cleanupMounted, click, flush, press } from '../../../test/dom'
import { mountStudio, type StudioMount } from '../../../test/studioHarness'
import { i18n } from '../i18n/zh-TW'

let s: StudioMount | null = null
afterEach(() => {
  cleanupMounted()
  s?.restore()
  s = null
})
const T = i18n.studio

describe('工作室版面與操作', () => {
  test('只顯示精華；保留播放列事件統計與篩選，移除 Ctrl+M／Ctrl+S', async () => {
    s = await mountStudio()
    expect(document.querySelector('.studio-aside')?.getAttribute('aria-label')).toBe('精華')
    expect(document.querySelector('.hl-tab')?.getAttribute('aria-labelledby')).toBe('aside-tab-hl')
    expect(document.querySelectorAll('[role="tab"], .ev-tab, .ev-row, .tri')).toHaveLength(0)
    const chip = document.querySelector<HTMLButtonElement>('.transport .chip')!
    const before = chip.getAttribute('aria-pressed')
    click(chip)
    expect(chip.getAttribute('aria-pressed')).not.toBe(before)
    press(document.body, 'm', { ctrlKey: true })
    press(document.body, 's', { ctrlKey: true })
    expect(document.querySelectorAll('.pclip')).toHaveLength(0)
    expect(document.querySelector('.toast')).toBeNull()
  })

  test('快速剪輯與 AI 在事件統計左側，匯出在加入外部影片右側且可開啟抽屜', async () => {
    s = await mountStudio()
    const transport = document.querySelector('.transport')!
    const quick = buttonByText(transport, T.quickClip)!
    const ai = buttonByText(transport, T.autoClip)!
    const filter = transport.querySelector('.event-chips') ?? transport.querySelector('[aria-label="事件類型篩選"]')!
    expect(quick.compareDocumentPosition(filter) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(ai.compareDocumentPosition(filter) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(document.querySelector('.studio-head')?.textContent).not.toContain(T.quickClip)
    const buttons = Array.from(document.querySelectorAll('.plane-head button')).slice(-3)
    expect(buttons.map((b) => b.textContent?.trim())).toEqual([T.track.newProject, T.track.addExternalVideo, T.exportCount.replace('{n}', '0')])
    click(quick)
    expect(quick.getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelectorAll('.pclip')).toHaveLength(0)
    const exportButton = document.querySelector('.plane-head > .btn-accent')!
    click(exportButton)
    await flush(20)
    expect(exportButton.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('.xd')).not.toBeNull()
  })

  test('AI 按鈕維持浮層開關與錨點', async () => {
    s = await mountStudio()
    const ai = document.querySelector<HTMLButtonElement>('.transport [data-autoclip="toggle"]')!
    ai.getBoundingClientRect = () => ({ top: 450, left: 500, bottom: 480, right: 620, width: 120, height: 30, x: 500, y: 450, toJSON: () => ({}) })
    click(ai)
    const pop = document.querySelector<HTMLElement>('.autoclip-pop')!
    expect(ai.getAttribute('aria-expanded')).toBe('true')
    expect(pop.style.left).toBe('500px')
    click(ai)
    expect(document.querySelector('.autoclip-pop')).toBeNull()
    expect(ai.getAttribute('aria-expanded')).toBe('false')
  })

  test('加入外部影片依序選檔、加入影片庫及排入分析', async () => {
    const paths = ['D:/a.mp4', 'D:/b.mp4']
    const select = vi.fn(async () => paths)
    const add = vi.fn(async () => undefined)
    const enqueue = vi.fn(async () => undefined)
    s = await mountStudio({ api: { overrides: { library: { selectFiles: select, add }, queue: { enqueue } } } })
    click(buttonByText(document, T.track.addExternalVideo)!)
    await flush()
    expect(select).toHaveBeenCalledTimes(1)
    expect(add).toHaveBeenCalledWith(paths)
    expect(enqueue.mock.calls).toEqual([['D:/a.mp4'], ['D:/b.mp4']])
    expect(add.mock.invocationCallOrder[0]).toBeLessThan(enqueue.mock.invocationCallOrder[0])
    expect(document.querySelectorAll('.pclip')).toHaveLength(0)
  })

  test('取消選檔不匯入也不分析', async () => {
    s = await mountStudio()
    click(buttonByText(document, T.track.addExternalVideo)!)
    await flush()
    expect(s.fake.api.library.add).not.toHaveBeenCalled()
    expect(s.fake.api.queue.enqueue).not.toHaveBeenCalled()
  })

  test('匯入失敗顯示通知且不排入分析', async () => {
    s = await mountStudio({ api: { overrides: { library: { selectFiles: async () => ['D:/a.mp4'], add: async () => { throw new Error('失敗') } } } } })
    click(buttonByText(document, T.track.addExternalVideo)!)
    await flush()
    expect(document.querySelector('.toast')?.textContent).toContain(T.toast.addExternalFailed)
    expect(s.fake.api.queue.enqueue).not.toHaveBeenCalled()
  })
})
