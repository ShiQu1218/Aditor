import { afterEach, describe, expect, test, vi } from 'vitest'
import { EventEmitter, once } from 'events'
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import chokidar, { type FSWatcher } from 'chokidar'
import { watchFolder, WATCH_RELEASE_TIMEOUT_MS, type WatchFolderOptions } from './library'

const watchers: FSWatcher[] = []

function setup(probe?: WatchFolderOptions['isFileReleased']) {
  const emitter = new EventEmitter() as FSWatcher
  emitter.close = vi.fn(async () => {})
  vi.spyOn(chokidar, 'watch').mockReturnValue(emitter)
  const onAdd = vi.fn()
  const watcher = watchFolder('videos', onAdd, { stabilityMs: 100, isFileReleased: probe })
  watchers.push(watcher)
  return { watcher, onAdd }
}

afterEach(async () => {
  for (const watcher of watchers.splice(0)) await watcher.close()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('watched file release', () => {
  test('imports once after release without delaying other paths', async () => {
    vi.useFakeTimers()
    let released = false
    const probe = vi.fn(async (file: string) => file === 'ready.mp4' || released)
    const { watcher, onAdd } = setup(probe)
    watcher.emit('add', 'busy.mp4')
    watcher.emit('add', 'busy.mp4')
    watcher.emit('add', 'ready.mp4')
    await vi.advanceTimersByTimeAsync(200)
    expect(onAdd.mock.calls).toEqual([[['ready.mp4']]])
    released = true
    await vi.advanceTimersByTimeAsync(100)
    expect(onAdd.mock.calls).toEqual([[['ready.mp4']], [['busy.mp4']]])
    await vi.advanceTimersByTimeAsync(1000)
    expect(onAdd).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('stops at the wait bound and warns once', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const probe = vi.fn(async () => false)
    const { watcher, onAdd } = setup(probe)
    watcher.emit('add', 'busy.mp4')
    await vi.advanceTimersByTimeAsync(WATCH_RELEASE_TIMEOUT_MS - 1)
    expect(warn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(warn).toHaveBeenCalledExactlyOnceWith('[Watch] Timed out waiting for file release: busy.mp4')
    const calls = probe.mock.calls.length
    await vi.advanceTimersByTimeAsync(WATCH_RELEASE_TIMEOUT_MS)
    expect(probe).toHaveBeenCalledTimes(calls)
    expect(onAdd).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('silently drops a file removed while busy', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const probe = vi.fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockRejectedValue(Object.assign(new Error('Missing'), { code: 'ENOENT' }))
    const { watcher, onAdd } = setup(probe)
    watcher.emit('add', 'removed.mp4')
    await vi.advanceTimersByTimeAsync(WATCH_RELEASE_TIMEOUT_MS)
    expect(probe).toHaveBeenCalledTimes(2)
    expect(onAdd).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('close cancels busy retries and ignores later events', async () => {
    vi.useFakeTimers()
    const probe = vi.fn(async () => false)
    const { watcher, onAdd } = setup(probe)
    watcher.emit('add', 'busy.mp4')
    await vi.advanceTimersByTimeAsync(100)
    await watcher.close()
    const calls = probe.mock.calls.length
    watcher.emit('add', 'later.mp4')
    await vi.advanceTimersByTimeAsync(WATCH_RELEASE_TIMEOUT_MS)
    expect(probe).toHaveBeenCalledTimes(calls)
    expect(onAdd).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  test.each([false, true])('close ignores an in-flight probe returning %s', async (released) => {
    vi.useFakeTimers()
    let resolve!: (value: boolean) => void
    const probe = vi.fn(() => new Promise<boolean>((done) => { resolve = done }))
    const { watcher, onAdd } = setup(probe)
    watcher.emit('add', 'busy.mp4')
    await watcher.close()
    resolve(released)
    await vi.advanceTimersByTimeAsync(WATCH_RELEASE_TIMEOUT_MS)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(onAdd).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  test.skipIf(process.platform !== 'win32').each(['EBUSY', 'EPERM', 'EACCES'])('retries Windows open errors with code %s', async (code) => {
    vi.useFakeTimers()
    const { watcher, onAdd } = setup()
    const close = vi.fn(async () => {})
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ mode: 0o666 } as fs.Stats)
    const open = vi.spyOn(fs.promises, 'open')
      .mockRejectedValueOnce(Object.assign(new Error('Busy'), { code }))
      .mockResolvedValue({ close } as unknown as fs.promises.FileHandle)
    watcher.emit('add', 'busy.mp4')
    await vi.advanceTimersByTimeAsync(99)
    expect(onAdd).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(open).toHaveBeenCalledWith('busy.mp4', 'r+')
    expect(open).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledTimes(1)
    expect(onAdd).toHaveBeenCalledExactlyOnceWith(['busy.mp4'])
  })

  test.skipIf(process.platform !== 'win32').each(['EBUSY', 'EPERM', 'EACCES'])('retries a read-only file when the read probe fails with %s', async (code) => {
    vi.useFakeTimers()
    const { watcher, onAdd } = setup()
    const close = vi.fn(async () => {})
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ mode: 0o444 } as fs.Stats)
    const open = vi.spyOn(fs.promises, 'open')
      .mockRejectedValueOnce(Object.assign(new Error('Read-only'), { code: 'EACCES' }))
      .mockRejectedValueOnce(Object.assign(new Error('Busy'), { code }))
      .mockRejectedValueOnce(Object.assign(new Error('Read-only'), { code: 'EPERM' }))
      .mockResolvedValue({ close } as unknown as fs.promises.FileHandle)
    watcher.emit('add', 'readonly.mp4')
    await vi.advanceTimersByTimeAsync(99)
    expect(onAdd).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(open.mock.calls).toEqual([
      ['readonly.mp4', 'r+'], ['readonly.mp4', 'r'],
      ['readonly.mp4', 'r+'], ['readonly.mp4', 'r']
    ])
    expect(close).toHaveBeenCalledTimes(1)
    expect(onAdd).toHaveBeenCalledExactlyOnceWith(['readonly.mp4'])
  })

  test.skipIf(process.platform !== 'win32')('imports a real unlocked read-only Windows file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-readonly-'))
    const file = path.join(root, 'readonly.mp4')
    fs.writeFileSync(file, 'video')
    try {
      fs.chmodSync(file, 0o444)
      expect(fs.statSync(file).mode & 0o200).toBe(0)
      const { watcher, onAdd } = setup()
      const open = vi.spyOn(fs.promises, 'open')
      watcher.emit('add', file)
      await vi.waitFor(() => expect(onAdd).toHaveBeenCalledExactlyOnceWith([file]))
      expect(open.mock.calls).toEqual([[file, 'r+'], [file, 'r']])
      await watcher.close()
    } finally {
      fs.chmodSync(file, 0o666)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform !== 'win32')('waits for a real Windows exclusive write handle to close', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-release-'))
    const file = path.join(root, 'locked.mp4')
    fs.writeFileSync(file, 'video')
    // Node opens allow sharing on Windows; FileShare.None reproduces the copy lock.
    const writer = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$f = [IO.File]::Open($env:WATCH_TEST_FILE, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None); try { [Console]::WriteLine("ready"); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $f.Dispose() }'
    ], { env: { ...process.env, WATCH_TEST_FILE: file }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const exited = once(writer, 'exit')
    try {
      await Promise.race([
        once(writer.stdout, 'data'),
        exited.then(() => { throw new Error('Writer exited before acquiring the lock') })
      ])
      const { watcher, onAdd } = setup()
      const open = vi.spyOn(fs.promises, 'open')
      watcher.emit('add', file)
      await vi.waitFor(() => expect(open.mock.settledResults[0]?.type).toBe('rejected'))
      expect(onAdd).not.toHaveBeenCalled()
      writer.stdin.end('\n')
      await exited
      await vi.waitFor(() => expect(onAdd).toHaveBeenCalledExactlyOnceWith([file]))
      await watcher.close()
    } finally {
      writer.kill()
      await exited
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
