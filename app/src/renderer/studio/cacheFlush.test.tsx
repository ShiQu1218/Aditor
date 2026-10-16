// @vitest-environment jsdom
// I4：工作室快取的 1 秒去抖寫入，在離開（卸載）、關閉視窗（beforeunload／main 的 flushRequest）時必須同步寫入，不能丟掉。
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanupMounted, click, flush } from '../../../test/dom'
import { mountStudio, type StudioMount } from '../../../test/studioHarness'

let s: StudioMount | null = null
afterEach(() => {
  cleanupMounted()
  s?.restore()
  s = null
})

const q = <T extends Element = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel)

async function editOnce(): Promise<void> {
  click(document.querySelectorAll('.hl-card')[0].querySelector('.hl-accept')!)
  await flush(5)
}

describe('studio cache flush (I4)', () => {
  test('unmounting right after an edit synchronously saves the cache (no 1 s loss)', async () => {
    s = await mountStudio({ doc: (d) => ({ ...d, cache_path: 'C:/cache/x.json' }) })
    const saveSync = s.fake.api.cache.saveSync as ReturnType<typeof vi.fn>
    saveSync.mockClear()
    await editOnce()
    expect(saveSync).not.toHaveBeenCalled()
    cleanupMounted()
    expect(saveSync).toHaveBeenCalledTimes(1)
    const doc = saveSync.mock.calls[0][0] as { clips: Array<{ status?: string }> }
    expect(doc.clips.some((c) => c.status === 'accepted')).toBe(true)
  })

  test('beforeunload flushes a pending edit synchronously', async () => {
    s = await mountStudio({ doc: (d) => ({ ...d, cache_path: 'C:/cache/x.json' }) })
    const saveSync = s.fake.api.cache.saveSync as ReturnType<typeof vi.fn>
    saveSync.mockClear()
    await editOnce()
    window.dispatchEvent(new Event('beforeunload'))
    expect(saveSync).toHaveBeenCalledTimes(1)
  })

  test('main flushRequest flushes a pending edit; nothing pending -> nothing written', async () => {
    s = await mountStudio({ doc: (d) => ({ ...d, cache_path: 'C:/cache/x.json' }) })
    const saveSync = s.fake.api.cache.saveSync as ReturnType<typeof vi.fn>
    // 載入時自動放置建議本身就是待寫入的編輯：先 flush 掉，之後沒有新編輯就不該再寫
    window.dispatchEvent(new Event('beforeunload'))
    saveSync.mockClear()
    window.dispatchEvent(new Event('beforeunload'))
    expect(saveSync).not.toHaveBeenCalled()
    await editOnce()
    s.fake.emit?.('projects:flushRequest')
    expect(saveSync).toHaveBeenCalledTimes(1)
    expect(q('.studio')).not.toBeNull()
  })
})
