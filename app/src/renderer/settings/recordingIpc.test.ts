import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { IDLE_RECORDING_STATUS, RECORDING_CHANNELS as channels, type LiveUpdate, type RecordingService, type RecordingStatus } from '../../shared/recording'
import { registerRecordingIpc } from '../../main/recording-ipc'

const electron = vi.hoisted(() => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  webUtils: {}
}))
vi.mock('electron', () => electron)
beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

function setup(windows: unknown[] = []) {
  const off = vi.fn()
  let emit!: (s: RecordingStatus) => void
  const service: RecordingService = {
    start: vi.fn(), stop: vi.fn(async () => undefined),
    status: vi.fn(() => IDLE_RECORDING_STATUS), capabilities: vi.fn(async () => null),
    startManual: vi.fn(async () => true), stopManual: vi.fn(async () => undefined), setPaused: vi.fn(),
    onStatus: vi.fn((cb) => { emit = cb; return off }), onFinalized: vi.fn(() => () => undefined)
  }
  const dispose = registerRecordingIpc(service, () => windows as BrowserWindow[])
  const handlers = new Map<string, (...args: any[]) => any>(electron.ipcMain.handle.mock.calls as any)
  return { service, emit, off, dispose, call: (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args) }
}

describe('Recording IPC', () => {
  test('Each invoke delegates to the service and returns snapshots, capabilities, or start results', async () => {
    const { call, service } = setup()
    expect(call(channels.getStatus)).toEqual(IDLE_RECORDING_STATUS)
    expect(await call(channels.getCapabilities)).toBeNull()
    expect(await call(channels.startManual)).toBe(true)
    await call(channels.stopManual)
    expect(service.stopManual).toHaveBeenCalledOnce()
    call(channels.setPaused, true)
    call(channels.setPaused, false)
    expect(service.setPaused).toHaveBeenNthCalledWith(1, true)
    expect(service.setPaused).toHaveBeenNthCalledWith(2, false)
  })
  test.each([undefined, null, 0, 1, 'true', [], {}, { paused: true }])('rejects non-boolean pause values %j', (raw) => {
    const { call, service } = setup()
    expect(() => call(channels.setPaused, raw)).toThrow('布林')
    expect(service.setPaused).not.toHaveBeenCalled()
  })
  test('Broadcast skips destroyed windows and webContents; an individual failure does not affect other windows; removes all registrations', () => {
    const send = vi.fn()
    const skipped = vi.fn()
    const dead = (window: boolean, contents: boolean) => ({ isDestroyed: () => window, webContents: { isDestroyed: () => contents, send: skipped } })
    const { emit, dispose, off } = setup([
      dead(true, false), dead(false, true),
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: () => { throw new Error('closed') } } },
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }
    ])
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    emit(IDLE_RECORDING_STATUS)
    expect(send).toHaveBeenCalledWith(channels.status, IDLE_RECORDING_STATUS)
    expect(skipped).not.toHaveBeenCalled()
    dispose()
    expect(off).toHaveBeenCalledOnce()
    expect(electron.ipcMain.removeHandler.mock.calls.flat()).toEqual(Object.values(channels).filter((ch) => ch !== channels.status && ch !== channels.live))
  })
})

describe('Live recording IPC', () => {
  function liveSetup(windows: unknown[] = []) {
    const base = setup(windows)
    let emitLive!: (u: LiveUpdate) => void
    const offLive = vi.fn()
    Object.assign(base.service, {
      live: vi.fn(async () => null),
      readInit: vi.fn(async () => new Uint8Array([1])),
      readSegment: vi.fn(async () => new Uint8Array([2])),
      onLive: vi.fn((cb) => { emitLive = cb; return offLive })
    })
    electron.ipcMain.handle.mockClear()
    const dispose = registerRecordingIpc(base.service, () => windows as BrowserWindow[])
    const handlers = new Map<string, (...args: any[]) => any>(electron.ipcMain.handle.mock.calls as any)
    return { ...base, dispose, offLive, emitLive: (u: LiveUpdate) => emitLive(u), call: (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args) }
  }
  const ID = '20261018-123456-abcd'

  test('Delegates to the service; an unimplemented service returns null', async () => {
    const { call, service } = liveSetup()
    expect(await call(channels.getLive)).toBeNull()
    expect(await call(channels.readInit, ID)).toEqual(new Uint8Array([1]))
    expect(await call(channels.readSegment, ID, 3)).toEqual(new Uint8Array([2]))
    expect(service.readSegment).toHaveBeenCalledWith(ID, 3)
    const plain = setup()
    expect(await plain.call(channels.getLive)).toBeNull()
  })

  test.each([undefined, null, 1, '', '../x', '20261018-123456-ABCD', '20261018-123456-abcd/..', 'C:\\x', ['x']])('rejects invalid recording session IDs %j', (raw) => {
    const { call, service } = liveSetup()
    expect(() => call(channels.readInit, raw)).toThrow('ID')
    expect(() => call(channels.readSegment, raw, 1)).toThrow('ID')
    expect(service.readInit).not.toHaveBeenCalled()
  })

  test.each([undefined, null, 0, -1, 1.5, '1', Number.NaN, 2 ** 60, [1]])('rejects invalid segment sequence numbers %j', (raw) => {
    const { call, service } = liveSetup()
    expect(() => call(channels.readSegment, ID, raw)).toThrow('序號')
    expect(service.readSegment).not.toHaveBeenCalled()
  })

  test('Broadcasts recording:live and unsubscribes on cleanup', () => {
    const send = vi.fn()
    const { emitLive, dispose, offLive } = liveSetup([{ isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }])
    const update: LiveUpdate = { sessionId: ID, segment: { seq: 1, pts: 0, dur: 2 } }
    emitLive(update)
    expect(send).toHaveBeenCalledWith(channels.live, update)
    dispose()
    expect(offLive).toHaveBeenCalledOnce()
  })
})

test('Preload contract: invoke channels, arguments, events, and listener cleanup', async () => {
  vi.resetModules()
  const oldIsolated = process.contextIsolated
  Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true })
  try {
    await import('../../preload/index')
    const [name, exposed] = electron.contextBridge.exposeInMainWorld.mock.calls[0]
    expect(name).toBe('api')
    const api = exposed.recording
    const status = { ...IDLE_RECORDING_STATUS, paused: true }
    electron.ipcRenderer.invoke.mockResolvedValue(status)
    expect(await api.getStatus()).toBe(status)
    await api.getCapabilities()
    await api.startManual()
    await api.stopManual()
    await api.setPaused(true)
    expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
      [channels.getStatus], [channels.getCapabilities], [channels.startManual], [channels.stopManual], [channels.setPaused, true]
    ])
    const cb = vi.fn()
    const off = api.onStatus(cb)
    const [channel, handler] = electron.ipcRenderer.on.mock.calls[0]
    handler({}, status)
    expect(cb).toHaveBeenCalledWith(status)
    off()
    expect(channel).toBe(channels.status)
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(channel, handler)
    electron.ipcRenderer.invoke.mockClear()
    await api.getLive()
    await api.readInit('20261018-123456-abcd')
    await api.readSegment('20261018-123456-abcd', 7)
    expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
      [channels.getLive], [channels.readInit, '20261018-123456-abcd'], [channels.readSegment, '20261018-123456-abcd', 7]
    ])
    const liveCb = vi.fn()
    const offLive = api.onLive(liveCb)
    const [liveChannel, liveHandler] = electron.ipcRenderer.on.mock.calls[1]
    expect(liveChannel).toBe(channels.live)
    liveHandler({}, { sessionId: 'x' })
    expect(liveCb).toHaveBeenCalledWith({ sessionId: 'x' })
    offLive()
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(channels.live, liveHandler)
  } finally {
    Object.defineProperty(process, 'contextIsolated', { value: oldIsolated, configurable: true })
  }
})
