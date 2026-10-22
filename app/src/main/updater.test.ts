import { describe, expect, test, vi } from 'vitest'
import { canAutoUpdate, createAppUpdater, type UpdaterLike } from './updater'
import { createAppQuitGuard } from './quit-guard'
import type { UpdateStatus } from '../shared/update'

type Listener = (arg?: unknown) => void

function fakeUpdater(check: () => Promise<unknown> = async () => undefined, download: () => Promise<unknown> = async () => []) {
  const listeners = new Map<string, Listener>()
  const updater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    on: (event: string, fn: Listener) => { listeners.set(event, fn) },
    checkForUpdates: vi.fn(check),
    downloadUpdate: vi.fn(download),
    quitAndInstall: vi.fn()
  }
  const emit = (event: string, arg?: unknown): void => listeners.get(event)?.(arg)
  return { updater: updater as unknown as UpdaterLike & typeof updater, emit }
}

function rig(opts: {
  enabled?: boolean
  check?: () => Promise<unknown>
  download?: () => Promise<unknown>
  supported?: boolean
  requestQuit?: () => void
} = {}) {
  const f = fakeUpdater(opts.check, opts.download)
  const broadcasts: UpdateStatus[] = []
  const notifyAvailable = vi.fn()
  const requestQuit = opts.requestQuit ?? vi.fn()
  const timers: Array<() => void> = []
  const repeats: Array<() => void> = []
  const svc = createAppUpdater({
    updater: opts.supported === false ? null : f.updater,
    isEnabled: () => opts.enabled ?? true,
    notifyAvailable,
    broadcast: (s) => broadcasts.push(s),
    requestQuit,
    setTimer: (fn) => timers.push(fn),
    setRepeat: (fn) => repeats.push(fn),
    clearTimers: () => undefined
  })
  return { ...f, svc, broadcasts, notifyAvailable, requestQuit, timers, repeats }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const deferred = () => {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const beforeQuit = () => ({ preventDefault: () => undefined })

describe('createAppUpdater', () => {
  test('unsupported builds never check, download, or install', async () => {
    const r = rig({ supported: false })
    expect(r.svc.status()).toEqual({ state: 'unsupported' })
    r.svc.start()
    expect(r.timers).toHaveLength(0)
    expect(await r.svc.check()).toEqual({ state: 'unsupported' })
    expect(r.svc.download()).toBe(false)
    expect(r.svc.install()).toBe(false)
  })

  test('disables automatic download and automatic install-on-quit', () => {
    const r = rig()
    expect(r.updater.autoDownload).toBe(false)
    // electron-updater's own quit handler must not turn an ordinary quit into an install.
    expect(r.updater.autoInstallOnAppQuit).toBe(false)
  })

  test('check discovers an available version without starting a download', async () => {
    const r = rig()
    r.updater.checkForUpdates.mockImplementation(async () => r.emit('update-available', { version: '0.2.0' }))
    expect(await r.svc.check()).toEqual({ state: 'available', version: '0.2.0' })
    expect(r.updater.downloadUpdate).not.toHaveBeenCalled()
    expect(r.notifyAvailable).toHaveBeenCalledTimes(1)
    expect(r.notifyAvailable).toHaveBeenCalledWith('0.2.0')
    expect(r.broadcasts.map((s) => s.state)).toEqual(['checking', 'available'])
  })

  test('available → explicit download → progress → downloaded, notifying once per version', async () => {
    const r = rig()
    r.emit('update-available', { version: '0.2.0' })
    expect(r.svc.status()).toEqual({ state: 'available', version: '0.2.0' })
    expect(r.notifyAvailable).toHaveBeenCalledTimes(1)

    expect(r.svc.download()).toBe(true)
    expect(r.updater.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(r.svc.status()).toEqual({ state: 'downloading', version: '0.2.0', percent: 0 })

    r.emit('download-progress', { percent: 42.4 })
    expect(r.svc.status()).toEqual({ state: 'downloading', version: '0.2.0', percent: 42 })
    r.emit('update-downloaded', { version: '0.2.0' })
    r.emit('update-downloaded', { version: '0.2.0' })
    expect(r.svc.status()).toEqual({ state: 'downloaded', version: '0.2.0' })
    expect(r.notifyAvailable).toHaveBeenCalledTimes(1)
    expect(r.broadcasts.map((s) => s.state)).toEqual(['available', 'downloading', 'downloading', 'downloaded', 'downloaded'])
  })

  test('download does nothing before a version is available and ignores duplicate requests', () => {
    const r = rig()
    expect(r.svc.download()).toBe(false)
    expect(r.updater.downloadUpdate).not.toHaveBeenCalled()

    r.emit('update-available', { version: '0.2.0' })
    expect(r.svc.download()).toBe(true)
    expect(r.svc.download()).toBe(false)
    expect(r.updater.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  test('no update → latest', async () => {
    const r = rig()
    r.updater.checkForUpdates.mockImplementation(async () => r.emit('update-not-available'))
    expect((await r.svc.check()).state).toBe('latest')
  })

  test('a rejected check becomes an error status with the message', async () => {
    const r = rig({ check: async () => { throw new Error('offline') } })
    expect(await r.svc.check()).toEqual({ state: 'error', error: 'offline' })
    expect(r.updater.downloadUpdate).not.toHaveBeenCalled()
  })

  test('a rejected download becomes an error status and can be retried after checking again', async () => {
    const r = rig({ download: async () => { throw new Error('download offline') } })
    r.emit('update-available', { version: '0.2.0' })
    expect(r.svc.download()).toBe(true)
    await tick()
    expect(r.svc.status()).toEqual({ state: 'error', error: 'download offline' })

    r.updater.checkForUpdates.mockImplementation(async () => r.emit('update-available', { version: '0.2.0' }))
    r.updater.downloadUpdate.mockImplementation(async () => [])
    expect(await r.svc.check()).toEqual({ state: 'available', version: '0.2.0' })
    expect(r.svc.download()).toBe(true)
    expect(r.updater.downloadUpdate).toHaveBeenCalledTimes(2)
  })

  test('an updater error during download is shown instead of leaving the download stuck', () => {
    const r = rig()
    r.emit('update-available', { version: '0.2.0' })
    expect(r.svc.download()).toBe(true)
    r.emit('error', new Error('network reset'))
    expect(r.svc.status()).toEqual({ state: 'error', error: 'network reset' })
  })

  test('a late download rejection does not hide a completed download', async () => {
    const pending = deferred()
    const r = rig({ download: () => pending.promise })
    r.emit('update-available', { version: '0.2.0' })
    expect(r.svc.download()).toBe(true)
    r.emit('update-downloaded', { version: '0.2.0' })
    pending.reject(new Error('late failure'))
    await tick()
    expect(r.svc.status()).toEqual({ state: 'downloaded', version: '0.2.0' })
  })

  test('errors after a download do not hide the downloaded update', async () => {
    const r = rig()
    r.emit('update-downloaded', { version: '0.2.0' })
    r.emit('error', new Error('later check failed'))
    expect(r.svc.status().state).toBe('downloaded')
  })

  test('does not re-check while available, downloading, or after download', async () => {
    const r = rig()
    r.emit('update-available', { version: '0.2.0' })
    await r.svc.check()
    expect(r.updater.checkForUpdates).not.toHaveBeenCalled()
    r.svc.download()
    await r.svc.check()
    expect(r.updater.checkForUpdates).not.toHaveBeenCalled()
    r.emit('update-downloaded', { version: '0.2.0' })
    await r.svc.check()
    expect(r.updater.checkForUpdates).not.toHaveBeenCalled()
  })

  test('scheduled and manual checks never download; scheduled checks obey the setting', async () => {
    const off = rig({ enabled: false })
    off.updater.checkForUpdates.mockImplementation(async () => off.emit('update-available', { version: '0.2.0' }))
    off.svc.start()
    off.timers[0]()
    off.repeats[0]()
    expect(off.updater.checkForUpdates).not.toHaveBeenCalled()
    await off.svc.check()
    expect(off.updater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(off.svc.status()).toEqual({ state: 'available', version: '0.2.0' })
    expect(off.updater.downloadUpdate).not.toHaveBeenCalled()

    const on = rig({ enabled: true })
    on.updater.checkForUpdates.mockImplementation(async () => on.emit('update-available', { version: '0.2.0' }))
    on.svc.start()
    on.svc.start() // Repeated calls do not schedule another check.
    expect(on.timers).toHaveLength(1)
    on.timers[0]()
    await tick()
    expect(on.updater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(on.svc.status()).toEqual({ state: 'available', version: '0.2.0' })
    expect(on.updater.downloadUpdate).not.toHaveBeenCalled()
  })
})

describe('manual update install sequencing', () => {
  test('install only after download, requesting a graceful quit before the installer starts', () => {
    const r = rig()
    expect(r.svc.install()).toBe(false)
    // An available version is not downloaded yet, so it cannot be installed.
    r.emit('update-available', { version: '0.2.0' })
    expect(r.svc.install()).toBe(false)
    expect(r.svc.download()).toBe(true)
    r.emit('update-downloaded', { version: '0.2.0' })
    expect(r.svc.install()).toBe(true)
    expect(r.requestQuit).toHaveBeenCalledTimes(1)
    // The installer must not spawn until the quit guard has finalized recording work and flushed the library.
    expect(r.updater.quitAndInstall).not.toHaveBeenCalled()
    expect(r.svc.installIfRequested()).toBe(true)
    expect(r.updater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

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

  test('ordinary quit after a download quits normally without starting the installer', async () => {
    const quit = vi.fn()
    const r = rig()
    r.emit('update-downloaded', { version: '0.2.0' })
    const guard = createAppQuitGuard({
      stopRecording: async () => undefined,
      flushLibrary: () => undefined,
      stopEngine: async () => undefined,
      cancelExport: async () => undefined,
      cancelProxies: async () => undefined,
      stopWatcher: async () => undefined,
      installUpdate: () => r.svc.installIfRequested(),
      quit,
      timeoutMs: 5000
    })

    guard.onBeforeQuit(beforeQuit())
    await tick()
    expect(quit).toHaveBeenCalledTimes(1)
    expect(r.updater.quitAndInstall).not.toHaveBeenCalled()
    // electron-updater's autoInstallOnAppQuit hook must stay off so releasing app.quit() does not install the download.
    expect(r.updater.autoInstallOnAppQuit).toBe(false)
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
      stopWatcher: async () => undefined,
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
