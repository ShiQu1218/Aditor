import { describe, expect, test, vi } from 'vitest'
import { canAutoUpdate, createAppUpdater, type UpdaterLike } from './updater'
import type { UpdateStatus } from '../shared/update'

type Listener = (arg?: unknown) => void

function fakeUpdater(check: () => Promise<unknown> = async () => undefined) {
  const listeners = new Map<string, Listener>()
  const updater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    on: (event: string, fn: Listener) => { listeners.set(event, fn) },
    checkForUpdates: vi.fn(check),
    quitAndInstall: vi.fn()
  }
  const emit = (event: string, arg?: unknown): void => listeners.get(event)?.(arg)
  return { updater: updater as unknown as UpdaterLike & typeof updater, emit }
}

function rig(opts: { enabled?: boolean; check?: () => Promise<unknown>; supported?: boolean } = {}) {
  const f = fakeUpdater(opts.check)
  const broadcasts: UpdateStatus[] = []
  const notifyDownloaded = vi.fn()
  const timers: Array<() => void> = []
  const repeats: Array<() => void> = []
  const svc = createAppUpdater({
    updater: opts.supported === false ? null : f.updater,
    isEnabled: () => opts.enabled ?? true,
    notifyDownloaded,
    broadcast: (s) => broadcasts.push(s),
    setTimer: (fn) => timers.push(fn),
    setRepeat: (fn) => repeats.push(fn),
    clearTimers: () => undefined
  })
  return { ...f, svc, broadcasts, notifyDownloaded, timers, repeats }
}

describe('createAppUpdater', () => {
  test('unsupported builds never check and never install', async () => {
    const r = rig({ supported: false })
    expect(r.svc.status()).toEqual({ state: 'unsupported' })
    r.svc.start()
    expect(r.timers).toHaveLength(0)
    expect(await r.svc.check()).toEqual({ state: 'unsupported' })
    expect(r.svc.install()).toBe(false)
  })

  test('enables background download and install-on-quit', () => {
    const r = rig()
    expect(r.updater.autoDownload).toBe(true)
    expect(r.updater.autoInstallOnAppQuit).toBe(true)
  })

  test('available → progress → downloaded, notifying once per version', async () => {
    const r = rig()
    await r.svc.check()
    r.emit('update-available', { version: '0.2.0' })
    r.emit('download-progress', { percent: 42.4 })
    expect(r.svc.status()).toEqual({ state: 'downloading', version: '0.2.0', percent: 42 })
    r.emit('update-downloaded', { version: '0.2.0' })
    r.emit('update-downloaded', { version: '0.2.0' })
    expect(r.svc.status()).toEqual({ state: 'downloaded', version: '0.2.0' })
    expect(r.notifyDownloaded).toHaveBeenCalledTimes(1)
    expect(r.broadcasts.map((s) => s.state)).toEqual(['checking', 'downloading', 'downloading', 'downloaded', 'downloaded'])
  })

  test('no update → latest', async () => {
    const r = rig()
    r.updater.checkForUpdates.mockImplementation(async () => r.emit('update-not-available'))
    expect((await r.svc.check()).state).toBe('latest')
  })

  test('a rejected check becomes an error status with the message', async () => {
    const r = rig({ check: async () => { throw new Error('offline') } })
    expect(await r.svc.check()).toEqual({ state: 'error', error: 'offline' })
  })

  test('errors after a download do not hide the downloaded update', async () => {
    const r = rig()
    r.emit('update-downloaded', { version: '0.2.0' })
    r.emit('error', new Error('later check failed'))
    expect(r.svc.status().state).toBe('downloaded')
  })

  test('does not re-check while downloading or after download', async () => {
    const r = rig()
    r.emit('update-available', { version: '0.2.0' })
    await r.svc.check()
    r.emit('update-downloaded', { version: '0.2.0' })
    await r.svc.check()
    expect(r.updater.checkForUpdates).not.toHaveBeenCalled()
  })

  test('install only after download, quitting and relaunching', () => {
    const r = rig()
    expect(r.svc.install()).toBe(false)
    r.emit('update-downloaded', { version: '0.2.0' })
    expect(r.svc.install()).toBe(true)
    expect(r.updater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  test('scheduled checks run only while the setting is on; manual checks always run', async () => {
    const off = rig({ enabled: false })
    off.svc.start()
    off.timers[0]()
    off.repeats[0]()
    expect(off.updater.checkForUpdates).not.toHaveBeenCalled()
    await off.svc.check()
    expect(off.updater.checkForUpdates).toHaveBeenCalledTimes(1)

    const on = rig({ enabled: true })
    on.svc.start()
    on.svc.start() // Repeated calls do not schedule another check.
    expect(on.timers).toHaveLength(1)
    on.timers[0]()
    expect(on.updater.checkForUpdates).toHaveBeenCalledTimes(1)
  })
})

describe('canAutoUpdate', () => {
  test('only the packaged installer build', () => {
    expect(canAutoUpdate(false, {})).toBe(false)
    expect(canAutoUpdate(true, {})).toBe(true)
    expect(canAutoUpdate(true, { PORTABLE_EXECUTABLE_DIR: 'D:\\Apps' })).toBe(false)
  })
})
