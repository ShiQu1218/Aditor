import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApexWatcher, parseApexPid } from './apex-watcher'

afterEach(() => vi.useRealTimers())

describe('Apex process detection', () => {
  it('accepts only two exact filenames and valid PIDs, returning the first matching process', () => {
    expect(parseApexPid('INFO: 沒有符合的工作')).toBeNull()
    expect(parseApexPid('"r5apex_launcher.exe","55","Console"\n"r5apex.exe","0","Console"')).toBeNull()
    expect(parseApexPid('"R5APEX_DX12.EXE","123","Console","1","10,000 K"\r\n"r5apex.exe","456"')).toBe(123)
  })

  it('confirms starts and exits twice in a row, and does not treat query errors as exits', async () => {
    vi.useFakeTimers()
    const find = vi.fn().mockResolvedValue(null)
    const changed = vi.fn()
    const failed = vi.fn()
    const watcher = new ApexWatcher(find, 3000, changed, failed)
    watcher.start()
    await vi.advanceTimersByTimeAsync(0)
    find.mockResolvedValue(123)
    await vi.advanceTimersByTimeAsync(3000)
    expect(changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3000)
    expect(changed).toHaveBeenLastCalledWith(123)
    find.mockRejectedValueOnce(new Error('tasklist 失敗'))
    await vi.advanceTimersByTimeAsync(3000)
    expect(failed).toHaveBeenCalledOnce()
    changed.mockClear()
    find.mockResolvedValue(null)
    await vi.advanceTimersByTimeAsync(3000)
    expect(changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3000)
    expect(changed).toHaveBeenLastCalledWith(null)
    watcher.stop()
    await vi.advanceTimersByTimeAsync(30000)
    expect(find).toHaveBeenCalledTimes(6)
  })

  it('ignores pending queries after stop and prevents overlapping polls', async () => {
    vi.useFakeTimers()
    let resolve!: (pid: number | null) => void
    const find = vi.fn(() => new Promise<number | null>((r) => { resolve = r }))
    const changed = vi.fn()
    const watcher = new ApexWatcher(find, 3000, changed, vi.fn())
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
