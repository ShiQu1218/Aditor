import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ProjectStore, StoredProject } from './projects'
import { SettingsStore } from './settings'
import { createCloseGate, registerProjectHandlers, type IpcLike } from './project-ipc'

type Fn = (...a: any[]) => any

function fakeIpc(): IpcLike & { handlers: Map<string, Fn>; listeners: Map<string, Fn> } {
  const handlers = new Map<string, Fn>()
  const listeners = new Map<string, Fn>()
  return {
    handlers,
    listeners,
    handle: (ch, fn) => void handlers.set(ch, fn),
    on: (ch, fn) => void listeners.set(ch, fn)
  }
}

const proj = (id: string, name = 'n'): StoredProject => ({
  id,
  version: 1,
  name,
  items: [{ id: 'i', source: 'C:/v/a.mp4', start: 0, end: 1 }]
})

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-pipc-'))
  const store = new ProjectStore(path.join(dir, 'projects'))
  const settings = new SettingsStore(path.join(dir, 'settings.json'))
  const ipc = fakeIpc()
  registerProjectHandlers(ipc, store, settings)
  return { dir, store, settings, ipc }
}

describe('registerProjectHandlers', () => {
  test('projects:load does not change lastProjectId; projects:markOpened does, and rejects invalid ids', async () => {
    const { store, settings, ipc } = setup()
    await store.save(proj('p_a'))
    await store.save(proj('p_b'))
    await ipc.handlers.get('projects:load')!({}, 'p_a')
    expect(settings.get().lastProjectId).toBeFalsy()
    expect(await ipc.handlers.get('projects:markOpened')!({}, 'p_b')).toBe(true)
    expect(settings.get().lastProjectId).toBe('p_b')
    expect(await ipc.handlers.get('projects:markOpened')!({}, '../evil')).toBe(false)
    expect(settings.get().lastProjectId).toBe('p_b')
  })

  test('projects:rename renames a stored project and reports failure for blank names', async () => {
    const { store, ipc } = setup()
    await store.save(proj('p_r', 'old'))
    expect(await ipc.handlers.get('projects:rename')!({}, 'p_r', 'fresh')).toBe(true)
    expect((await store.load('p_r'))?.name).toBe('fresh')
    expect(await ipc.handlers.get('projects:rename')!({}, 'p_r', '  ')).toBe(false)
  })

  test('projects:save writes the file and lastProjectId in the same call', async () => {
    const { store, settings, ipc } = setup()
    expect(await ipc.handlers.get('projects:save')!({}, proj('p_one'))).toBe(true)
    expect((await store.load('p_one'))?.name).toBe('n')
    expect(settings.get().lastProjectId).toBe('p_one')
  })

  test('projects:save with invalid payload rejects and does not touch lastProjectId', async () => {
    const { settings, ipc } = setup()
    await expect(ipc.handlers.get('projects:save')!({}, { ...proj('undefined') })).rejects.toThrow()
    expect(settings.get().lastProjectId).toBeNull()
  })

  test('projects:flushSync writes synchronously, sets lastProjectId and returns true via returnValue', async () => {
    const { store, settings, ipc } = setup()
    const event: { returnValue?: unknown } = {}
    ipc.listeners.get('projects:flushSync')!(event, proj('p_flush', 'flushed'))
    expect(event.returnValue).toBe(true)
    expect(settings.get().lastProjectId).toBe('p_flush')
    expect((await store.load('p_flush'))?.name).toBe('flushed')
  })

  test('projects:flushSync failure returns false and never throws', () => {
    const { ipc } = setup()
    const event: { returnValue?: unknown } = {}
    expect(() => ipc.listeners.get('projects:flushSync')!(event, { nope: 1 })).not.toThrow()
    expect(event.returnValue).toBe(false)
  })

  test('settings is only rewritten when lastProjectId actually changes', async () => {
    const { settings, ipc } = setup()
    const spy = vi.spyOn(settings, 'set')
    await ipc.handlers.get('projects:save')!({}, proj('p_a'))
    await ipc.handlers.get('projects:save')!({}, proj('p_a', 'edited'))
    expect(spy).toHaveBeenCalledTimes(1)
    await ipc.handlers.get('projects:save')!({}, proj('p_b'))
    expect(spy).toHaveBeenCalledTimes(2)
  })

  test('projects:flushDone forwards to the close gate', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-pipc-'))
    const ipc = fakeIpc()
    const onFlushDone = vi.fn()
    registerProjectHandlers(ipc, new ProjectStore(dir), undefined, onFlushDone)
    ipc.listeners.get('projects:flushDone')!({})
    expect(onFlushDone).toHaveBeenCalledTimes(1)
  })
})

describe('createCloseGate', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const ev = () => ({ preventDefault: vi.fn() })

  test('first close is deferred, renderer asked to flush, ack then closes', () => {
    const request = vi.fn()
    const close = vi.fn()
    const gate = createCloseGate({ request, close, timeoutMs: 1500 })
    const e = ev()
    gate.onClose(e)
    expect(e.preventDefault).toHaveBeenCalled()
    expect(request).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
    gate.ack()
    expect(close).toHaveBeenCalledTimes(1)
    // Allow the second close event triggered by close().
    const e2 = ev()
    gate.onClose(e2)
    expect(e2.preventDefault).not.toHaveBeenCalled()
  })

  test('a save failure keeps the window open and can be retried', () => {
    const request = vi.fn()
    const close = vi.fn()
    const gate = createCloseGate({ request, close, timeoutMs: 1500 })
    gate.onClose(ev())
    gate.ack(false)
    vi.advanceTimersByTime(2000)
    expect(close).not.toHaveBeenCalled()
    gate.onClose(ev())
    expect(request).toHaveBeenCalledTimes(2)
    gate.ack(true)
    expect(close).toHaveBeenCalledTimes(1)
  })

  test('timeout closes even when renderer never answers', () => {
    const close = vi.fn()
    const gate = createCloseGate({ request: vi.fn(), close, timeoutMs: 1500 })
    gate.onClose(ev())
    vi.advanceTimersByTime(1499)
    expect(close).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  test('repeated close events while waiting request only once; ack after timeout is a no-op', () => {
    const request = vi.fn()
    const close = vi.fn()
    const gate = createCloseGate({ request, close, timeoutMs: 100 })
    gate.onClose(ev())
    gate.onClose(ev())
    expect(request).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(100)
    gate.ack()
    expect(close).toHaveBeenCalledTimes(1)
  })

  test('skips the handshake when the renderer is gone', () => {
    const request = vi.fn()
    const gate = createCloseGate({ request, close: vi.fn(), timeoutMs: 100, rendererAlive: () => false })
    const e = ev()
    gate.onClose(e)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  test('a deferred close while quitting cancels Electron quit and must retrigger it after saving (or timeout); regular close/minimize-to-tray does not trigger quit', () => {
    let quitting = false
    let closeToTray = true
    let hidden = false
    let closed = false
    let appExited = false
    const request = vi.fn()
    let gate: ReturnType<typeof createCloseGate>
    const shouldHide = () => !quitting && closeToTray
    const makeGate = (): ReturnType<typeof createCloseGate> => createCloseGate({
      request,
      close: () => {
        if (shouldHide()) {
          hidden = true
          gate = makeGate()
        } else {
          const e = ev()
          gate.onClose(e)
          if (!e.preventDefault.mock.calls.length) closed = true
        }
      },
      timeoutMs: 1500,
      isQuitting: () => quitting,
      quit: () => {
        const e = ev()
        gate.onClose(e)
        if (!e.preventDefault.mock.calls.length) appExited = true
      }
    })
    gate = makeGate()

    // 1. Regular close (closeToTray=true, quitting=false): save, then minimize to tray without calling quit.
    const hideClose = ev()
    gate.onClose(hideClose)
    expect(hideClose.preventDefault).toHaveBeenCalled()
    gate.ack(true)
    expect(hidden).toBe(true)
    expect(closed).toBe(false)
    expect(appExited).toBe(false)
    expect(request).toHaveBeenCalledTimes(1)

    // 2. When the window is in the tray and the user selects Quit (quitting=true): prevent the first close to save, then close and continue quitting after ack.
    quitting = true
    const quitClose = ev()
    gate.onClose(quitClose)
    expect(quitClose.preventDefault).toHaveBeenCalled()
    expect(request).toHaveBeenCalledTimes(2)
    expect(appExited).toBe(false)
    gate.ack(true)
    expect(closed).toBe(true)
    expect(appExited).toBe(true)

    // 3. With closeToTray=false, if the renderer times out during quit, close anyway and continue quitting.
    closed = false
    appExited = false
    closeToTray = false
    gate = makeGate()
    gate.onClose(ev())
    vi.advanceTimersByTime(1500)
    expect(closed).toBe(true)
    expect(appExited).toBe(true)
  })
})

