// @vitest-environment jsdom
// I4: the studio cache uses a 1-second debounced write; flush synchronously on navigation/unmount or window close (beforeunload/main flushRequest) so edits are not lost.
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanupMounted, click, flush } from '../../../test/dom'
import { mountStudio, type StudioMount } from '../../../test/studioHarness'
import { i18n } from '../i18n'

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
  // Automatically placing suggestions on load is itself an edit to persist: flush it first, then do not write again without further edits.
    window.dispatchEvent(new Event('beforeunload'))
    saveSync.mockClear()
    window.dispatchEvent(new Event('beforeunload'))
    expect(saveSync).not.toHaveBeenCalled()
    await editOnce()
    s.fake.emit?.('projects:flushRequest')
    expect(saveSync).toHaveBeenCalledTimes(1)
    expect(s.fake.api.projects.flushDone).toHaveBeenLastCalledWith(true)
    expect(q('.studio')).not.toBeNull()
  })

  test('main flushRequest blocks close when the source cache save fails, then allows retry', async () => {
    s = await mountStudio({ doc: (d) => ({ ...d, cache_path: 'C:/cache/x.json' }) })
    const saveSync = s.fake.api.cache.saveSync as ReturnType<typeof vi.fn>
    window.dispatchEvent(new Event('beforeunload'))
    saveSync.mockClear()
    await editOnce()
    saveSync.mockReturnValueOnce(false)
    s.fake.emit?.('projects:flushRequest')
    expect(s.fake.api.projects.flushDone).toHaveBeenLastCalledWith(false)
    s.fake.emit?.('projects:flushRequest')
    expect(s.fake.api.projects.flushDone).toHaveBeenLastCalledWith(true)
    expect(saveSync).toHaveBeenCalledTimes(2)
  })

  test('back navigation stays in Studio when the source cache save fails', async () => {
    const onBack = vi.fn()
    s = await mountStudio({ onBack, doc: (d) => ({ ...d, cache_path: 'C:/cache/x.json' }) })
    const saveSync = s.fake.api.cache.saveSync as ReturnType<typeof vi.fn>
    window.dispatchEvent(new Event('beforeunload'))
    saveSync.mockClear()
    await editOnce()
    saveSync.mockReturnValueOnce(false)
    click(document.querySelector('.studio-head .icon-btn')!)
    expect(onBack).not.toHaveBeenCalled()
    click(document.querySelector('.studio-head .icon-btn')!)
    expect(onBack).toHaveBeenCalledOnce()
  })

  test('a failed close-time cache save is reported and retried with the same edit', async () => {
    s = await mountStudio({ doc: (d) => ({ ...d, cache_path: 'C:/cache/x.json' }) })
    const saveSync = s.fake.api.cache.saveSync as ReturnType<typeof vi.fn>
    saveSync.mockReturnValueOnce(false)
    await editOnce()
    const first = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(first)
    await flush()
    expect(first.defaultPrevented).toBe(true)
    expect(document.querySelector('.toast-host')?.textContent).toContain(i18n.studio.toast.sourceSaveFailed)
    const second = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(second)
    expect(second.defaultPrevented).toBe(false)
    expect(saveSync).toHaveBeenCalledTimes(2)
  })
})
