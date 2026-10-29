// Wiring test for the library removal channels: the renderer may only ask for the source file to be deleted
// with an explicit `deleteSource: true`; every other shape keeps the file.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

type Fn = (...a: any[]) => any
const handlers = new Map<string, Fn>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: Fn) => void handlers.set(ch, fn), on: () => {}, removeHandler: () => {} },
  dialog: {},
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  app: { getPath: () => os.tmpdir(), isPackaged: false, getVersion: () => '0' },
  shell: {},
  safeStorage: { isEncryptionAvailable: () => false }
}))

import { registerIpcHandlers } from './ipc-handlers'
import { Library } from './library'

describe('library:remove / library:removeMany (source file option)', () => {
  let dir: string
  let library: Library
  let queue: { enqueue: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    handlers.clear()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-lib-ipc-'))
    library = new Library(path.join(dir, 'library.json'))
    queue = { enqueue: vi.fn() }
    const queueMock = { on: () => {}, payload: () => ({}), ...queue, withStoppedAnalysis: async (_paths: string[], remove: () => unknown) => remove() } as any
    registerIpcHandlers(library, queueMock, () => [])
  })
  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** An imported video with a real file on disk. */
  const imported = (name: string): string => {
    const file = path.join(dir, name)
    fs.writeFileSync(file, 'video')
    library.add([file], 'external')
    return file
  }

  test.each(['library:add', 'library:toggleFavorite', 'library:setGame', 'library:remove', 'library:removeMany'])('%s rejects failed persistence and retains changes for retry', async (channel) => {
    const file = imported('save-failure.mp4')
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('disk full')
    })
    const args = channel === 'library:add' ? [[path.join(dir, 'new.mp4')]]
      : channel === 'library:removeMany' ? [[file]]
        : channel === 'library:setGame' ? [file, 'valorant'] : [file]
    await expect(Promise.resolve().then(() => handlers.get(channel)!({}, ...args))).rejects.toThrow('無法儲存媒體庫')
    expect(queue.enqueue).not.toHaveBeenCalled()
    expect(fs.existsSync(file)).toBe(true)
    rename.mockRestore()
    expect(library.flush()).toBe(true)
    const reloaded = new Library(path.join(dir, 'library.json'))
    expect(reloaded.getEntries()).toEqual(library.getEntries())
  })

  test('deletes the source file only when deleteSource is exactly true', async () => {
    const file = imported('a.mp4')
    expect(await handlers.get('library:remove')!({}, file, { deleteSource: true })).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
  })

  test('keeps the source file without options or with an invalid option', async () => {
    const noOptions = imported('b.mp4')
    expect(await handlers.get('library:remove')!({}, noOptions)).toBe(true)
    expect(fs.existsSync(noOptions)).toBe(true)

    const wrongType = imported('c.mp4')
    expect(await handlers.get('library:remove')!({}, wrongType, { deleteSource: 'yes' })).toBe(true)
    expect(fs.existsSync(wrongType)).toBe(true)

    const notAnObject = imported('d.mp4')
    expect(await handlers.get('library:remove')!({}, notAnObject, null)).toBe(true)
    expect(fs.existsSync(notAnObject)).toBe(true)
  })

  test('removeMany forwards the option and ignores invalid arguments', async () => {
    const deleted = imported('e.mp4')
    expect(await handlers.get('library:removeMany')!({}, [deleted], { deleteSource: true })).toEqual({ removed: [deleted], failed: [] })
    expect(fs.existsSync(deleted)).toBe(false)

    const kept = imported('f.mp4')
    expect(await handlers.get('library:removeMany')!({}, [kept], { deleteSource: false })).toEqual({ removed: [kept], failed: [] })
    expect(fs.existsSync(kept)).toBe(true)

    expect(await handlers.get('library:removeMany')!({}, 'not-an-array', { deleteSource: true })).toEqual({ removed: [], failed: [] })
  })

  test('recording sources are deleted even without the option', async () => {
    const file = path.join(dir, 'recording.mp4')
    fs.writeFileSync(file, 'video')
    library.add([file], 'recording')
    expect(await handlers.get('library:remove')!({}, file)).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
  })

  test('queue:enqueue rejects unsafe paths before reaching the queue', async () => {
    for (const bad of ['http://x/a.mp4', 'concat:a|b', '\\\\srv\\share\\a.mp4', 'D:\\v\\a.exe', 5, null]) {
      expect(() => handlers.get('queue:enqueue')!({}, bad, true)).toThrow()
    }
    expect(queue.enqueue).not.toHaveBeenCalled()

    const file = imported('g.mp4')
    await handlers.get('queue:enqueue')!({}, file, true)
    expect(queue.enqueue).toHaveBeenCalledWith(file, true)
  })
})
