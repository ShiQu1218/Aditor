import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGameProcessFinder, findGameProcess, GAME_PROCESS_RECHECK_POLLS, GameWatcher, parseGameProcess, sameProcess } from './game-watcher'

const tasklist = vi.hoisted(() => vi.fn<(file: string, args: string[], options: unknown, callback: (error: Error | null, stdout: string) => void) => void>())
vi.mock('child_process', () => ({ execFile: tasklist }))

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Filtered game process queries', () => {
  beforeEach(() => { tasklist.mockReset() })

  it('queries games one at a time with their image filters and preserves execution limits', async () => {
    tasklist.mockImplementation((_file, _args, _options, callback) => callback(null, ''))
    await expect(findGameProcess()).resolves.toBeNull()
    const options = { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 }
    expect(tasklist.mock.calls).toEqual([
      ['tasklist', ['/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq r5apex*'], options, expect.any(Function)],
      ['tasklist', ['/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq VALORANT-Win64-Shipping.exe'], options, expect.any(Function)]
    ])
  })

  it('never runs two tasklist processes at once', async () => {
    const pending = findGameProcess()
    expect(tasklist).toHaveBeenCalledTimes(1)
    tasklist.mock.calls[0][3](null, '')
    await vi.waitFor(() => expect(tasklist).toHaveBeenCalledTimes(2))
    tasklist.mock.calls[1][3](null, '"VALORANT-Win64-Shipping.exe","456"')
    await expect(pending).resolves.toEqual({ game: 'valorant', pid: 456 })
  })

  it('stops after the first matching game', async () => {
    tasklist.mockImplementation((_file, _args, _options, callback) => callback(null, '"r5apex_dx12.exe","123"'))
    await expect(findGameProcess()).resolves.toEqual({ game: 'apex', pid: 123 })
    expect(tasklist).toHaveBeenCalledTimes(1)
  })

  it('ignores localized no-match output and validates wildcard results with the process regex', async () => {
    tasklist
      .mockImplementationOnce((_file, _args, _options, callback) => callback(null, 'INFO: 沒有符合指定準則的工作。\r\n"r5apex_launcher.exe","55"'))
      .mockImplementationOnce((_file, _args, _options, callback) => callback(null, '"VALORANT-Win64-Shipping.exe","456"'))
    await expect(findGameProcess()).resolves.toEqual({ game: 'valorant', pid: 456 })
  })

  it('rejects when a query fails, so a failed query is never read as "no game"', async () => {
    const error = new Error('tasklist failed')
    tasklist
      .mockImplementationOnce((_file, _args, _options, callback) => callback(null, ''))
      .mockImplementationOnce((_file, _args, _options, callback) => callback(error, ''))
    await expect(findGameProcess()).rejects.toBe(error)
  })

  it.each([0xC0000142, 0x40010004])('retries a query once when tasklist exits with transient code %i, and rejects if it fails again', async (code) => {
    vi.useFakeTimers()
    const dllInit = Object.assign(new Error('Command failed: tasklist'), { code })
    tasklist
      .mockImplementationOnce((_file, _args, _options, callback) => callback(dllInit, ''))
      .mockImplementationOnce((_file, _args, _options, callback) => callback(null, '"r5apex.exe","77"'))
    const found = findGameProcess()
    await vi.runAllTimersAsync()
    await expect(found).resolves.toEqual({ game: 'apex', pid: 77 })
    expect(tasklist).toHaveBeenCalledTimes(2)

    tasklist.mockReset()
    tasklist.mockImplementation((_file, _args, _options, callback) => callback(dllInit, ''))
    const failed = findGameProcess()
    const assertion = expect(failed).rejects.toBe(dllInit)
    await vi.runAllTimersAsync()
    await assertion
    expect(tasklist).toHaveBeenCalledTimes(2)
  })
})

describe('Cached game process detection', () => {
  const game = { game: 'apex' as const, pid: 123 }
  const interval = 3000

  function watch(initial: typeof game | null = game) {
    vi.useFakeTimers()
    const find = vi.fn().mockResolvedValue(initial)
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const changed = vi.fn()
    const failed = vi.fn()
    const watcher = new GameWatcher(createGameProcessFinder(find), interval, changed, failed, sameProcess)
    watcher.start()
    return { find, kill, changed, failed, watcher }
  }

  it('reports startup immediately, uses liveness while known, and periodically rechecks the image', async () => {
    const { find, kill, changed, watcher } = watch()
    await vi.advanceTimersByTimeAsync(0)
    expect(changed.mock.calls).toEqual([[game]])
    await vi.advanceTimersByTimeAsync(interval * (GAME_PROCESS_RECHECK_POLLS - 1))
    expect(find).toHaveBeenCalledOnce()
    expect(kill).toHaveBeenCalledTimes(GAME_PROCESS_RECHECK_POLLS - 1)
    expect(kill).toHaveBeenCalledWith(game.pid, 0)
    expect(changed).toHaveBeenLastCalledWith(game)
    await vi.advanceTimersByTimeAsync(interval)
    expect(find).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(interval)
    expect(find).toHaveBeenCalledTimes(2)
    expect(kill).toHaveBeenCalledTimes(GAME_PROCESS_RECHECK_POLLS)
    watcher.stop()
  })

  it('resumes enumeration after exit and debounces absence across two polls', async () => {
    const { find, kill, changed, watcher } = watch()
    await vi.advanceTimersByTimeAsync(0)
    changed.mockClear()
    kill.mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
    find.mockResolvedValue(null)
    await vi.advanceTimersByTimeAsync(interval)
    expect(find).toHaveBeenCalledTimes(2)
    expect(changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(interval * 2)
    expect(find).toHaveBeenCalledTimes(4)
    expect(kill).toHaveBeenCalledOnce()
    expect(changed.mock.calls).toEqual([[null], [null]])
    watcher.stop()
  })

  it('uses liveness for a newly found replacement while retaining transition debounce', async () => {
    const { find, kill, changed, watcher } = watch()
    await vi.advanceTimersByTimeAsync(0)
    changed.mockClear()
    kill.mockImplementationOnce(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
    const next = { game: 'valorant' as const, pid: 456 }
    find.mockResolvedValue(next)
    await vi.advanceTimersByTimeAsync(interval)
    expect(changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(interval)
    expect(find).toHaveBeenCalledTimes(2)
    expect(kill).toHaveBeenLastCalledWith(next.pid, 0)
    expect(changed.mock.calls).toEqual([[next]])
    watcher.stop()
  })

  it.each([null, { game: 'valorant' as const, pid: 123 }])('detects a live reused PID when enumeration returns %s', async (next) => {
    const { find, kill, changed, watcher } = watch()
    await vi.advanceTimersByTimeAsync(0)
    find.mockResolvedValue(next)
    await vi.advanceTimersByTimeAsync(interval * (GAME_PROCESS_RECHECK_POLLS - 1))
    changed.mockClear()
    await vi.advanceTimersByTimeAsync(interval)
    expect(changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(interval)
    expect(changed.mock.calls).toEqual([[next]])
    expect(find).toHaveBeenCalledTimes(next ? 2 : 3)
    expect(kill).toHaveBeenCalledTimes(next ? GAME_PROCESS_RECHECK_POLLS : GAME_PROCESS_RECHECK_POLLS - 1)
    watcher.stop()
  })

  it('treats EPERM as alive', async () => {
    const { find, kill, changed, failed, watcher } = watch()
    await vi.advanceTimersByTimeAsync(0)
    kill.mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) })
    await vi.advanceTimersByTimeAsync(interval)
    expect(find).toHaveBeenCalledOnce()
    expect(changed).toHaveBeenLastCalledWith(game)
    expect(failed).not.toHaveBeenCalled()
    watcher.stop()
  })

  it('reports unexpected liveness errors without reporting an exit', async () => {
    const { find, kill, changed, failed, watcher } = watch()
    await vi.advanceTimersByTimeAsync(0)
    changed.mockClear()
    const error = Object.assign(new Error('unknown failure'), { code: 'EIO' })
    kill.mockImplementationOnce(() => { throw error })
    await vi.advanceTimersByTimeAsync(interval)
    expect(find).toHaveBeenCalledOnce()
    expect(failed.mock.calls).toEqual([[error]])
    expect(changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(interval)
    expect(changed.mock.calls).toEqual([[game]])
    watcher.stop()
  })

  it('retries a failed periodic enumeration instead of trusting the old live PID', async () => {
    const { find, kill, changed, failed, watcher } = watch()
    await vi.advanceTimersByTimeAsync(interval * (GAME_PROCESS_RECHECK_POLLS - 1))
    changed.mockClear()
    const error = new Error('enumeration failed')
    find.mockRejectedValueOnce(error).mockResolvedValue(null)
    await vi.advanceTimersByTimeAsync(interval)
    expect(failed.mock.calls).toEqual([[error]])
    expect(changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(interval * 2)
    expect(find).toHaveBeenCalledTimes(4)
    expect(kill).toHaveBeenCalledTimes(GAME_PROCESS_RECHECK_POLLS - 1)
    expect(changed.mock.calls).toEqual([[null]])
    watcher.stop()
  })

  it('keeps enumerating when no game is found and reports a new game after two polls', async () => {
    const { find, kill, changed, watcher } = watch(null)
    await vi.advanceTimersByTimeAsync(interval * 2)
    expect(changed).toHaveBeenLastCalledWith(null)
    expect(find).toHaveBeenCalledTimes(3)
    expect(kill).not.toHaveBeenCalled()
    find.mockResolvedValue(game)
    changed.mockClear()
    await vi.advanceTimersByTimeAsync(interval)
    expect(changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(interval)
    expect(changed.mock.calls).toEqual([[game]])
    watcher.stop()
  })

  it('retries enumeration after an exit query fails, even if the PID becomes alive again', async () => {
    const { find, kill, changed, failed, watcher } = watch()
    await vi.advanceTimersByTimeAsync(0)
    changed.mockClear()
    kill.mockImplementationOnce(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
    const error = new Error('enumeration failed')
    find.mockRejectedValueOnce(error).mockResolvedValue(null)
    await vi.advanceTimersByTimeAsync(interval)
    expect(failed.mock.calls).toEqual([[error]])
    expect(changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(interval * 2)
    expect(find).toHaveBeenCalledTimes(4)
    expect(kill).toHaveBeenCalledOnce()
    expect(changed.mock.calls).toEqual([[null]])
    watcher.stop()
  })
})

describe('Game process detection', () => {
  it('accepts only exact game filenames and valid PIDs, returning the first matching process', () => {
    expect(parseGameProcess('INFO: 沒有符合的工作')).toBeNull()
    expect(parseGameProcess('"r5apex_launcher.exe","55","Console"\n"r5apex.exe","0","Console"')).toBeNull()
    expect(parseGameProcess('"R5APEX_DX12.EXE","123","Console","1","10,000 K"\r\n"r5apex.exe","456"')).toEqual({ game: 'apex', pid: 123 })
    expect(parseGameProcess('"VALORANT.exe","70","Console"\n"VALORANT-Win64-Shipping.exe","71","Console"'))
      .toEqual({ game: 'valorant', pid: 71 })
    expect(parseGameProcess('"svchost.exe","4","Services"\n"VALORANT-Win64-Shipping.exe","8","Console"\n"r5apex.exe","9","Console"'))
      .toEqual({ game: 'valorant', pid: 8 })
  })

  it('treats the same PID under another game as a different process', () => {
    expect(sameProcess({ game: 'apex', pid: 1 }, { game: 'apex', pid: 1 })).toBe(true)
    expect(sameProcess({ game: 'apex', pid: 1 }, { game: 'valorant', pid: 1 })).toBe(false)
    expect(sameProcess(null, null)).toBe(true)
    expect(sameProcess(null, { game: 'apex', pid: 1 })).toBe(false)
  })

  it.each([null, 123])('reports the first successful poll immediately for %s', async (pid) => {
    vi.useFakeTimers()
    const find = vi.fn().mockResolvedValue(pid)
    const changed = vi.fn()
    const watcher = new GameWatcher(find, 3000, changed, vi.fn())
    watcher.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(find).toHaveBeenCalledOnce()
    expect(changed.mock.calls).toEqual([[pid]])
    watcher.stop()
  })

  it.each([null, 456])('ignores a transient %s while the same PID remains running', async (transient) => {
    vi.useFakeTimers()
    const find = vi.fn().mockResolvedValue(123)
    const changed = vi.fn()
    const watcher = new GameWatcher(find, 3000, changed, vi.fn())
    watcher.start()
    await vi.advanceTimersByTimeAsync(0)
    changed.mockClear()
    find.mockResolvedValueOnce(transient)
    await vi.advanceTimersByTimeAsync(3000)
    expect(changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(6000)
    expect(changed.mock.calls).toEqual([[123]])
    watcher.stop()
  })

  it.each([[123, null], [null, 123], [123, 456]])('confirms %s -> %s only after two equal successful polls', async (initial, next) => {
    vi.useFakeTimers()
    const find = vi.fn().mockResolvedValue(initial)
    const changed = vi.fn()
    const watcher = new GameWatcher(find, 3000, changed, vi.fn())
    watcher.start()
    await vi.advanceTimersByTimeAsync(0)
    changed.mockClear()
    find.mockResolvedValue(next)
    await vi.advanceTimersByTimeAsync(3000)
    expect(changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3000)
    expect(changed.mock.calls).toEqual([[next]])
    // Stable polls still drive the session's launch-delay checks.
    await vi.advanceTimersByTimeAsync(3000)
    expect(changed.mock.calls).toEqual([[next], [next]])
    watcher.stop()
  })

  it.each([[123, null], [null, 123], [123, 456]])('preserves the pending %s -> %s confirmation across query failures', async (initial, next) => {
    vi.useFakeTimers()
    const find = vi.fn().mockResolvedValue(initial)
    const changed = vi.fn()
    const failed = vi.fn()
    const watcher = new GameWatcher(find, 3000, changed, failed)
    watcher.start()
    await vi.advanceTimersByTimeAsync(0)
    changed.mockClear()
    find.mockResolvedValue(next)
    await vi.advanceTimersByTimeAsync(3000)
    expect(changed).not.toHaveBeenCalled()
    const error = new Error('tasklist failed')
    find.mockRejectedValueOnce(error)
    await vi.advanceTimersByTimeAsync(3000)
    expect(failed).toHaveBeenCalledOnce()
    expect(failed).toHaveBeenCalledWith(error)
    expect(changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3000)
    expect(changed.mock.calls).toEqual([[next]])
    watcher.stop()
    await vi.advanceTimersByTimeAsync(30000)
    expect(find).toHaveBeenCalledTimes(4)
  })

  it('reports the first successful result immediately even after a failed query', async () => {
    vi.useFakeTimers()
    const find = vi.fn().mockRejectedValueOnce(new Error('tasklist failed')).mockResolvedValue(123)
    const changed = vi.fn()
    const failed = vi.fn()
    const watcher = new GameWatcher(find, 3000, changed, failed)
    watcher.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(failed).toHaveBeenCalledOnce()
    expect(changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3000)
    expect(changed.mock.calls).toEqual([[123]])
    watcher.stop()
  })

  it('reports the first result immediately after restarting with a pending candidate', async () => {
    vi.useFakeTimers()
    const find = vi.fn().mockResolvedValue(123)
    const changed = vi.fn()
    const watcher = new GameWatcher(find, 3000, changed, vi.fn())
    watcher.start()
    await vi.advanceTimersByTimeAsync(0)
    find.mockResolvedValue(null)
    await vi.advanceTimersByTimeAsync(3000)
    watcher.stop()
    changed.mockClear()
    find.mockResolvedValue(456)
    watcher.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(changed.mock.calls).toEqual([[456]])
    watcher.stop()
  })

  it('ignores pending queries after stop and prevents overlapping polls', async () => {
    vi.useFakeTimers()
    let resolve!: (pid: number | null) => void
    const find = vi.fn(() => new Promise<number | null>((r) => { resolve = r }))
    const changed = vi.fn()
    const watcher = new GameWatcher(find, 3000, changed, vi.fn())
    watcher.start()
    await vi.advanceTimersByTimeAsync(15000)
    expect(find).toHaveBeenCalledOnce()
    watcher.stop()
    resolve(123)
    await vi.advanceTimersByTimeAsync(15000)
    expect(changed).not.toHaveBeenCalled()
    expect(find).toHaveBeenCalledOnce()
  })
})
