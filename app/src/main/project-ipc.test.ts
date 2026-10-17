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
    // close() 觸發的第二次 close 事件放行
    const e2 = ev()
    gate.onClose(e2)
    expect(e2.preventDefault).not.toHaveBeenCalled()
  })

  test('儲存失敗不關窗且可重試', () => {
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
})
