import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { IDLE_RECORDING_STATUS, RECORDING_CHANNELS as channels, type RecordingService, type RecordingStatus } from '../../shared/recording'
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

describe('錄影 IPC', () => {
  test('每個 invoke 轉交服務、回傳快照／能力／開始結果', async () => {
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
  test.each([undefined, null, 0, 1, 'true', [], {}, { paused: true }])('拒絕非布林暫停值 %j', (raw) => {
    const { call, service } = setup()
    expect(() => call(channels.setPaused, raw)).toThrow('布林')
    expect(service.setPaused).not.toHaveBeenCalled()
  })
  test('廣播跳過銷毀的視窗與 webContents，個別失敗不影響其他視窗；解除所有註冊', () => {
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
    expect(electron.ipcMain.removeHandler.mock.calls.flat()).toEqual(Object.values(channels).filter((ch) => ch !== channels.status))
  })
})

test('preload 合約：invoke 頻道、參數、事件與解除 listener', async () => {
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
  } finally {
    Object.defineProperty(process, 'contextIsolated', { value: oldIsolated, configurable: true })
  }
})
