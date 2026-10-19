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
    vi.advanceTimersByTime(300) // Only 300ms since the last update → not written yet.
    expect(save).not.toHaveBeenCalled()

    vi.advanceTimersByTime(200) // 500ms elapsed.
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(p2)
  })

  test('autosave flush on unload writes pending state immediately', () => {
    const save = vi.fn()
    const c = new AutosaveController({ delayMs: 500, save })

    c.update(p1)
    c.flush() // Write immediately before 500ms.
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(p1)

    vi.advanceTimersByTime(1000)
    expect(save).toHaveBeenCalledTimes(1) // Timer was canceled; do not write twice.

    c.flush() // No pending content, so do not write.
    expect(save).toHaveBeenCalledTimes(1)
  })

  test('autosave disabled when setting is off', () => {
    const save = vi.fn()
    const disabled = new AutosaveController({ delayMs: 500, save, enabled: false })
    disabled.update(p1)
    vi.advanceTimersByTime(1000)
    expect(save).not.toHaveBeenCalled()

    // Closing while enabled cancels existing pending content.
    const c = new AutosaveController({ delayMs: 500, save })
    c.update(p1)
    c.setEnabled(false)
    vi.advanceTimersByTime(1000)
    expect(save).not.toHaveBeenCalled()

    // It works again after being re-enabled.
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

describe('AutosaveController flush and hold', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('flush writes pending immediately through the async save; nothing pending is a no-op', () => {
    const save = vi.fn()
    const c = new AutosaveController({ delayMs: 500, save })
    c.flush()
    expect(save).not.toHaveBeenCalled()
    c.update(p2)
    c.flush()
    expect(save).toHaveBeenCalledWith(p2)
    vi.advanceTimersByTime(1000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  test('flushSync uses saveSync (blocking close-time path) and cancels the timer', () => {
    const save = vi.fn()
    const saveSync = vi.fn()
    const c = new AutosaveController({ delayMs: 500, save, saveSync })
    c.update(p2)
    vi.advanceTimersByTime(100) // Close occurs within the debounce window.
    c.flushSync()
    expect(saveSync).toHaveBeenCalledWith(p2)
    expect(save).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(save).not.toHaveBeenCalled()
  })

  test('flushSync swallows saveSync errors and falls back to save when no saveSync given', () => {
    const c = new AutosaveController({
      delayMs: 500,
      save: vi.fn(),
      saveSync: () => {
        throw new Error('ipc down')
      }
    })
    c.update(p1)
    expect(() => c.flushSync()).not.toThrow()
    const save = vi.fn()
    const d = new AutosaveController({ delayMs: 500, save })
    d.update(p1)
    d.flushSync()
    expect(save).toHaveBeenCalledWith(p1)
  })

  test('while held, updates are kept but never written; release writes the latest once', () => {
    const save = vi.fn()
    const c = new AutosaveController({ delayMs: 500, save, held: true })
    c.update(p1)
    c.update(p2)
    vi.advanceTimersByTime(5000)
    expect(save).not.toHaveBeenCalled()
    c.setHeld(false)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(p2)
    c.setHeld(false)
    expect(save).toHaveBeenCalledTimes(1)
  })

  test('release with autosave disabled drops the pending edit', () => {
    const save = vi.fn()
    const c = new AutosaveController({ delayMs: 500, save, held: true })
    c.update(p1)
    c.setEnabled(false)
    c.setHeld(false)
    vi.advanceTimersByTime(5000)
    expect(save).not.toHaveBeenCalled()
  })

  test('flushSync ignores hold so a close never loses an edit', () => {
    const saveSync = vi.fn()
    const c = new AutosaveController({ delayMs: 500, save: vi.fn(), saveSync, held: true })
    c.update(p1)
    c.flushSync()
    expect(saveSync).toHaveBeenCalledWith(p1)
  })
})

