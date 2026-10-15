import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { AutosaveController } from './useAutosave'
import { createProject } from './project'

const p1 = createProject('P1')
const p2 = createProject('P2', [{ id: 'a', source: 'C:/v/a.mp4', start: 0, end: 1 }])

describe('AutosaveController', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('autosave debounces 500ms and writes only the last state', () => {
    const save = vi.fn()
    const c = new AutosaveController({ delayMs: 500, save })

    c.update(p1)
    vi.advanceTimersByTime(300)
    c.update(p2)
    vi.advanceTimersByTime(300) // 距離最後一次更新僅 300ms → 尚未寫入
    expect(save).not.toHaveBeenCalled()

    vi.advanceTimersByTime(200) // 滿 500ms
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(p2)
  })

  test('autosave flush on unload writes pending state immediately', () => {
    const save = vi.fn()
    const c = new AutosaveController({ delayMs: 500, save })

    c.update(p1)
    c.flush() // 未滿 500ms 立即寫入
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(p1)

    vi.advanceTimersByTime(1000)
    expect(save).toHaveBeenCalledTimes(1) // 計時器已取消，不重複寫

    c.flush() // 沒有 pending 時不寫
    expect(save).toHaveBeenCalledTimes(1)
  })

  test('autosave disabled when setting is off', () => {
    const save = vi.fn()
    const disabled = new AutosaveController({ delayMs: 500, save, enabled: false })
    disabled.update(p1)
    vi.advanceTimersByTime(1000)
    expect(save).not.toHaveBeenCalled()

    // 執行中關閉：取消既有 pending
    const c = new AutosaveController({ delayMs: 500, save })
    c.update(p1)
    c.setEnabled(false)
    vi.advanceTimersByTime(1000)
    expect(save).not.toHaveBeenCalled()

    // 重新開啟後可再運作
    c.setEnabled(true)
    c.update(p2)
    vi.advanceTimersByTime(500)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(p2)
  })

  test('dispose clears the pending write', () => {
    const save = vi.fn()
    const c = new AutosaveController({ delayMs: 500, save })
    c.update(p1)
    c.dispose()
    vi.advanceTimersByTime(1000)
    expect(save).not.toHaveBeenCalled()
  })
})
