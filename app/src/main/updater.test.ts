import { describe, expect, test, vi } from 'vitest'
import { canAutoUpdate, createAppUpdater, type UpdaterLike } from './updater'
import { createAppQuitGuard } from './quit-guard'
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

function rig(opts: { enabled?: boolean; check?: () => Promise<unknown>; supported?: boolean; requestQuit?: () => void } = {}) {
  const f = fakeUpdater(opts.check)
  const broadcasts: UpdateStatus[] = []
  const notifyDownloaded = vi.fn()
  const requestQuit = opts.requestQuit ?? vi.fn()
  const timers: Array<() => void> = []
  const repeats: Array<() => void> = []
  const svc = createAppUpdater({
    updater: opts.supported === false ? null : f.updater,
    isEnabled: () => opts.enabled ?? true,
    notifyDownloaded,
    broadcast: (s) => broadcasts.push(s),
    requestQuit,
    setTimer: (fn) => timers.push(fn),
    setRepeat: (fn) => repeats.push(fn),
    clearTimers: () => undefined
  })
  return { ...f, svc, broadcasts, notifyDownloaded, requestQuit, timers, repeats }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((res) => { resolve = res })
  return { promise, resolve }
}

const beforeQuit = () => ({ preventDefault: () => undefined })

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

  test('install only after download, requesting a graceful quit before the installer starts', () => {
    const r = rig()
    expect(r.svc.install()).toBe(false)
    r.emit('update-downloaded', { version: '0.2.0' })
    expect(r.svc.install()).toBe(true)
    expect(r.requestQuit).toHaveBeenCalledTimes(1)
    // The installer must not spawn until the quit guard has finalized recording work and flushed the library.
    expect(r.updater.quitAndInstall).not.toHaveBeenCalled()
    expect(r.svc.installIfRequested()).toBe(true)
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

describe('manual update install sequencing', () => {
  test('slow recording finalization and cleanup block installer spawn until they finish', async () => {
    const finalize = deferred()
    const order: string[] = []
    let guard!: ReturnType<typeof createAppQuitGuard>
    const r = rig({ requestQuit: () => guard.onBeforeQuit(beforeQuit()) })
    guard = createAppQuitGuard({
      stopRecording: async () => {
        order.push('recording:start')
        await finalize.promise
        order.push('recording:done')
      },
      flushLibrary: () => order.push('library:flush'),
      stopEngine: async () => { order.push('engine:stop') },
      cancelExport: async () => { order.push('export:cancel') },
      cancelProxies: async () => { order.push('proxy:cancel') },
      stopWatcher: () => { order.push('watch:stop') },
      installUpdate: () => {
        if (!r.svc.installIfRequested()) return false
        order.push('installer:start')
        return true
      },
      quit: () => order.push('app:quit'),
      timeoutMs: 5000
    })

    r.emit('update-downloaded', { version: '0.2.0' })
    expect(r.svc.install()).toBe(true)
    // Cancellation and the first library flush start immediately; recording finalization/remux is the critical task.
    expect(order).toEqual(['export:cancel', 'proxy:cancel', 'watch:stop', 'library:flush', 'recording:start'])
    await tick()
    expect(order).toEqual(['export:cancel', 'proxy:cancel', 'watch:stop', 'library:flush', 'recording:start'])
    expect(r.updater.quitAndInstall).not.toHaveBeenCalled()

    finalize.resolve()
    await tick()
    expect(order).toEqual([
      'export:cancel',
      'proxy:cancel',
      'watch:stop',
      'library:flush',
      'recording:start',
      'recording:done',
      'library:flush',
      'engine:stop',
      'installer:start'
    ])
    expect(r.updater.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(r.updater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  test('ordinary quit still quits normally and leaves auto-install-on-quit enabled', async () => {
    const quit = vi.fn()
    const r = rig()
    r.emit('update-downloaded', { version: '0.2.0' })
    const guard = createAppQuitGuard({
      stopRecording: async () => undefined,
      flushLibrary: () => undefined,
      stopEngine: async () => undefined,
      cancelExport: async () => undefined,
      cancelProxies: async () => undefined,
      stopWatcher: () => undefined,
      installUpdate: () => r.svc.installIfRequested(),
      quit,
      timeoutMs: 5000
    })

    guard.onBeforeQuit(beforeQuit())
    await tick()
    expect(quit).toHaveBeenCalledTimes(1)
    expect(r.updater.quitAndInstall).not.toHaveBeenCalled()
    // A normal quit is still handled by electron-updater's autoInstallOnAppQuit path after the guard releases app.quit().
    expect(r.updater.autoInstallOnAppQuit).toBe(true)
  })

  test('repeated install requests spawn the installer exactly once', () => {
    const r = rig()
    r.emit('update-downloaded', { version: '0.2.0' })
    expect(r.svc.install()).toBe(true)
    expect(r.svc.install()).toBe(false)
    expect(r.requestQuit).toHaveBeenCalledTimes(1)
    expect(r.svc.installIfRequested()).toBe(true)
    expect(r.svc.installIfRequested()).toBe(false)
    expect(r.updater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  test('an installer-start failure becomes a visible error status', () => {
    const r = rig()
    r.emit('update-downloaded', { version: '0.2.0' })
    r.updater.quitAndInstall.mockImplementation(() => { throw new Error('installer failed to start') })
    expect(r.svc.install()).toBe(true)
    expect(r.svc.installIfRequested()).toBe(false)
    expect(r.svc.status()).toEqual({ state: 'error', error: 'installer failed to start' })
    expect(r.broadcasts.at(-1)).toEqual({ state: 'error', error: 'installer failed to start' })
  })

  test('installer errors after an install request replace the downloaded status', () => {
    const r = rig()
    r.emit('update-downloaded', { version: '0.2.0' })
    expect(r.svc.install()).toBe(true)
    r.emit('error', new Error('installer failed to start'))
    expect(r.svc.status()).toEqual({ state: 'error', error: 'installer failed to start' })
  })

  test('a synchronous installer failure falls back to a normal quit instead of leaving the app half-quitting', async () => {
    let guard!: ReturnType<typeof createAppQuitGuard>
    const r = rig({ requestQuit: () => guard.onBeforeQuit(beforeQuit()) })
    r.emit('update-downloaded', { version: '0.2.0' })
    r.updater.quitAndInstall.mockImplementation(() => {
      // electron-updater's "No valid update available" path dispatches 'error' and never schedules app.quit().
      r.emit('error', new Error('No valid update available, can not quit and install'))
    })
    const quit = vi.fn()
    guard = createAppQuitGuard({
      stopRecording: async () => undefined,
      flushLibrary: () => undefined,
      stopEngine: async () => undefined,
      cancelExport: async () => undefined,
      cancelProxies: async () => undefined,
      stopWatcher: () => undefined,
      installUpdate: () => r.svc.installIfRequested(),
      quit,
      timeoutMs: 5000
    })

    expect(r.svc.install()).toBe(true)
    await tick()
    expect(r.updater.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(r.svc.status()).toEqual({ state: 'error', error: 'No valid update available, can not quit and install' })
    // installIfRequested() returns false, so the guard still calls quit() and the app can exit normally.
    expect(quit).toHaveBeenCalledTimes(1)
  })
})

describe('canAutoUpdate', () => {
  test('only the packaged installer build', () => {
    expect(canAutoUpdate(false, {})).toBe(false)
    expect(canAutoUpdate(true, {})).toBe(true)
    expect(canAutoUpdate(true, { PORTABLE_EXECUTABLE_DIR: 'D:\\Apps' })).toBe(false)
  })
})
