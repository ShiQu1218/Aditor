// @vitest-environment jsdom
// I13：來源影片無法播放時顯示 notice（重新連結／返回影片庫），按鈕要真的有作用；無法判斷語言的 notice 的「返回」也一樣。
import { afterEach, describe, expect, test, vi } from 'vitest'
import { buttonByText, cleanupMounted, click, flush } from '../../../test/dom'
import { mountStudio, type StudioMount } from '../../../test/studioHarness'
import { i18n } from '../i18n/zh-TW'

let s: StudioMount | null = null
afterEach(() => {
  cleanupMounted()
  s?.restore()
  s = null
})
const N = i18n.studio.notices

describe('video missing notice (I13)', () => {
  test('a source-mode <video> error shows the notice; 〔返回影片庫〕 calls onBack', async () => {
    const onBack = vi.fn()
    s = await mountStudio({ onBack })
    expect(document.querySelector('.notice')?.textContent ?? '').not.toContain(N.videoMissingTitle)
    document.querySelector('video')!.dispatchEvent(new Event('error'))
    await flush(10)
    const bar = document.querySelector('.notice')!
    expect(bar.textContent).toContain(N.videoMissingTitle)
    click(buttonByText(bar, N.back)!)
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  test('〔重新連結檔案〕 goes back to the library with an explanatory toast', async () => {
    const onBack = vi.fn()
    s = await mountStudio({ onBack })
    document.querySelector('video')!.dispatchEvent(new Event('error'))
    await flush(10)
    click(buttonByText(document.querySelector('.notice')!, N.relink)!)
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.toast')?.textContent).toContain(i18n.studio.toast.relinkHint)
  })
})
