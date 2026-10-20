import { afterEach, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import type { FSWatcher } from 'chokidar'
import type { AnalysisQueue } from '../queue'
import { Library } from '../library'
import { SettingsStore } from '../settings'
import { WatchManager } from '../watch'
import { tempRoot } from './test-support'

let root: string
let manager: WatchManager
let library: Library
let settings: SettingsStore
afterEach(() => {
  manager?.stop()
  library?.flush()
  if (root) fs.rmSync(root, { recursive: true, force: true })
})

it('ignores .sessions and *.part.mp4 in the watched-folder import path while importing completed videos', async () => {
  root = tempRoot()
  library = new Library(path.join(root, 'library.json'))
  settings = new SettingsStore(path.join(root, 'settings.json'))
  const enqueue = vi.fn()
  let add!: (paths: string[]) => void
  manager = new WatchManager({ library, settings, queue: { enqueue } as unknown as AnalysisQueue,
    createWatcher: (_dir, onAdd) => {
      add = onAdd
      const watcher = Object.assign(new EventEmitter(), { close: async () => {} })
      setTimeout(() => watcher.emit('ready'), 0)
      return watcher as unknown as FSWatcher
    } })
  await manager.add(root)
  add([path.join(root, '.sessions', 'session', 'init.mp4'),
    root + '/.SESSIONS/session/recovered.mp4', root + '\\.sessions\\s\\init.mp4',
    path.join(root, 'Apex.part.mp4'), path.join(root, 'Apex.PART.MP4'), path.join(root, 'Apex.mp4')])
  expect(library.getEntries().map((entry) => entry.path)).toEqual([path.join(root, 'Apex.mp4')])
  expect(enqueue).toHaveBeenCalledOnce()
})
