// @vitest-environment jsdom
// I9：匯出抽屜要用 api.engine.probe 收集其他來源的規格（舊程式呼叫不存在的 api.probe，永遠是 null）。
import { afterEach, expect, test, vi } from 'vitest'
import { cleanupMounted, flush, focusEl, installDomShims, press } from '../../../test/dom'
import { mountStudio, STUDIO_VIDEO, type StudioMount } from '../../../test/studioHarness'

let s: StudioMount | null = null
afterEach(() => {
  cleanupMounted()
  s?.restore()
  s = null
})

test('opening the export drawer probes sources other than the open video via api.engine.probe', async () => {
  installDomShims({ width: 1366, height: 768 })
  const probe = vi.fn(async () => ({ codec: 'h264', width: 1280, height: 720 }))
  s = await mountStudio({
    items: [
      { id: 'i1', source: STUDIO_VIDEO, start: 10, end: 20 },
      { id: 'i2', source: 'D:/other/b.mp4', start: 5, end: 9 }
    ],
    api: { overrides: { engine: { probe } } }
  })
  focusEl(document.querySelectorAll<HTMLElement>('.pclip')[0])
  press(document.activeElement as Element, 'E', { ctrlKey: true, shiftKey: true })
  await flush(40)
  expect(probe).toHaveBeenCalledWith('D:/other/b.mp4')
  expect(probe).not.toHaveBeenCalledWith(STUDIO_VIDEO)
})
