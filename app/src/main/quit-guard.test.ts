import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppQuitGuard, createQuitGuard } from './quit-guard'

const ev = () => {
  let prevented = false
  return {
    get prevented() {
      return prevented
    },
    preventDefault: () => {
      prevented = true
    }
  }
}

const deferred = () => {
  let resolve!: (value: void | PromiseLike<void>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('quit guard (I7)', () => {
  it('holds the quit until every task (export cancel, proxy cancel, engine stop) has finished', async () => {
    let finishExport!: () => void
    const tasks = [
      () => new Promise<void>((r) => (finishExport = r)),
      vi.fn(async () => undefined)
    ]
    const quit = vi.fn()
    const g = createQuitGuard({ tasks, quit, timeoutMs: 5000 })
    const x = ev()
    g.onBeforeQuit(x)
    expect(x.prevented).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(quit).not.toHaveBeenCalled()
    finishExport()
    await new Promise((r) => setTimeout(r, 20))
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('quits anyway after the timeout when a task hangs', async () => {
    const quit = vi.fn()
    const g = createQuitGuard({ tasks: [() => new Promise(() => undefined)], quit, timeoutMs: 50 })
    g.onBeforeQuit(ev())
    await new Promise((r) => setTimeout(r, 150))
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('a failing task does not block the quit; the second before-quit (from quit()) passes through', async () => {
    const quit = vi.fn()
    const g = createQuitGuard({ tasks: [async () => { throw new Error('x') }], quit, timeoutMs: 1000 })
    g.onBeforeQuit(ev())
    await new Promise((r) => setTimeout(r, 20))
    expect(quit).toHaveBeenCalledTimes(1)
    const again = ev()
    g.onBeforeQuit(again)
    expect(again.prevented).toBe(false)
  })

  it('repeated before-quit while running does not start the tasks twice', async () => {
    const task = vi.fn(() => new Promise<void>((r) => setTimeout(r, 30)))
    const g = createQuitGuard({ tasks: [task], quit: () => undefined, timeoutMs: 1000 })
    g.onBeforeQuit(ev())
    g.onBeforeQuit(ev())
    expect(task).toHaveBeenCalledTimes(1)
  })
})

describe('quit guard critical finalization (D5)', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('never cuts off a critical task at the general timeout', async () => {
    vi.useFakeTimers()
    const finalize = deferred()
    const cleanup = vi.fn(async () => undefined)
    const quit = vi.fn()
    const g = createQuitGuard({
      criticalTasks: [() => finalize.promise],
      tasks: [cleanup],
      quit,
      timeoutMs: 5000
    })
    const x = ev()
    g.onBeforeQuit(x)
    expect(x.prevented).toBe(true)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(quit).not.toHaveBeenCalled()
    // Ordinary cleanup only starts after critical work has settled.
    expect(cleanup).not.toHaveBeenCalled()

    finalize.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('lets the quit continue when a critical task rejects', async () => {
    vi.useFakeTimers()
    const finalize = deferred()
    const quit = vi.fn()
    // `tasks` is required; pass an empty list when only critical work is under test.
    const g = createQuitGuard({ criticalTasks: [() => finalize.promise], tasks: [], quit, timeoutMs: 5000 })
    g.onBeforeQuit(ev())
    finalize.reject(new Error('remux failed'))
    await vi.advanceTimersByTimeAsync(0)
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('lets the quit continue when a critical task throws synchronously', async () => {
    vi.useFakeTimers()
    const quit = vi.fn()
    const g = createQuitGuard({
      criticalTasks: [() => { throw new Error('stop failed') }],
      tasks: [],
      quit,
      timeoutMs: 5000
    })
    g.onBeforeQuit(ev())
    await vi.advanceTimersByTimeAsync(0)
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('still times out ordinary cleanup after critical work completes', async () => {
    vi.useFakeTimers()
    const finalize = deferred()
    const cleanup = vi.fn(() => new Promise<void>(() => undefined))
    const quit = vi.fn()
    const g = createQuitGuard({ criticalTasks: [() => finalize.promise], tasks: [cleanup], quit, timeoutMs: 5000 })
    g.onBeforeQuit(ev())
    // The cleanup timeout has not started yet, so a long remux does not consume the bound.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(quit).not.toHaveBeenCalled()
    finalize.resolve()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(4999)
    expect(quit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('starts early cleanup while critical finalization is still in progress', async () => {
    vi.useFakeTimers()
    const finalize = deferred()
    const early = vi.fn(async () => undefined)
    const quit = vi.fn()
    const g = createQuitGuard({
      earlyTasks: [early],
      criticalTasks: [() => finalize.promise],
      tasks: [],
      quit,
      timeoutMs: 5000
    })
    g.onBeforeQuit(ev())
    expect(early).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(quit).not.toHaveBeenCalled()

    finalize.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('runs once while quitting is in progress and lets the quit triggered by quit() through', async () => {
    vi.useFakeTimers()
    const finalize = deferred()
    const critical = vi.fn(() => finalize.promise)
    const cleanup = vi.fn(async () => undefined)
    const quit = vi.fn()
    const g = createQuitGuard({ criticalTasks: [critical], tasks: [cleanup], quit, timeoutMs: 5000 })
    const first = ev()
    const second = ev()
    g.onBeforeQuit(first)
    g.onBeforeQuit(second)
    expect(first.prevented).toBe(true)
    expect(second.prevented).toBe(true)
    expect(critical).toHaveBeenCalledTimes(1)

    finalize.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(quit).toHaveBeenCalledTimes(1)

    const after = ev()
    g.onBeforeQuit(after)
    expect(after.prevented).toBe(false)
  })
})

describe('main quit wiring (D5)', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('finalizes the recording before flushing the library and running bounded cleanup', async () => {
    vi.useFakeTimers()
    const order: string[] = []
    const finalized = deferred()
    const quit = vi.fn(() => order.push('quit'))
    const guard = createAppQuitGuard({
      stopRecording: async () => {
        order.push('recording:start')
        await finalized.promise
        order.push('recording:done')
      },
      flushLibrary: () => order.push('library:flush'),
      stopEngine: async () => { order.push('engine:stop') },
      cancelExport: async () => { order.push('export:cancel') },
      cancelProxies: async () => { order.push('proxy:cancel') },
      stopWatcher: () => order.push('watch:stop'),
      quit,
      timeoutMs: 5000
    })

    guard.onBeforeQuit(ev())
    // Cancellation starts immediately and pending library changes flush before the long recording finalization begins.
    expect(order).toEqual(['export:cancel', 'proxy:cancel', 'watch:stop', 'library:flush', 'recording:start'])
    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual(['export:cancel', 'proxy:cancel', 'watch:stop', 'library:flush', 'recording:start'])

    finalized.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual([
      'export:cancel',
      'proxy:cancel',
      'watch:stop',
      'library:flush',
      'recording:start',
      'recording:done',
      'library:flush',
      'engine:stop',
      'quit'
    ])
  })

  it('flushes the library after a failed recording stop and still bounds the engine stop', async () => {
    vi.useFakeTimers()
    const order: string[] = []
    const quit = vi.fn()
    const guard = createAppQuitGuard({
      stopRecording: () => { throw new Error('recorder failed') },
      flushLibrary: () => order.push('library:flush'),
      stopEngine: () => new Promise<void>(() => undefined),
      cancelExport: async () => undefined,
      cancelProxies: async () => undefined,
      stopWatcher: () => undefined,
      quit,
      timeoutMs: 5000
    })

    guard.onBeforeQuit(ev())
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(4999)
    // Once early at quit start, once after the failed recording stop.
    expect(order).toEqual(['library:flush', 'library:flush'])
    expect(quit).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(quit).toHaveBeenCalledTimes(1)
  })
})
