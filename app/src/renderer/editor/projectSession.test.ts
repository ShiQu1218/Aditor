import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest'
import { createProject } from './project'
import { ProjectSession, createSessionIo, type SessionIo } from './projectSession'
import type { ProjectWithId } from './projectIo'

const item = (id: string) => ({ id, source: 'C:/v/a.mp4', start: 0, end: 1 })
const initial: ProjectWithId = { ...createProject('初始'), id: 'p_init' }
const withItems = (base: ProjectWithId, ...ids: string[]): ProjectWithId => ({ ...base, items: ids.map(item) })

function mkIo(overrides: { save?: Mock<(p: ProjectWithId) => Promise<unknown>> } = {}) {
  return {
    save: overrides.save ?? vi.fn(async (_p: ProjectWithId): Promise<unknown> => undefined),
    saveSync: vi.fn((_p: ProjectWithId) => {})
  }
}

let ids = 0
const mk = (io = mkIo()) => ({
  io,
  s: new ProjectSession({ initial, io: io as SessionIo, newId: () => `p_new${++ids}`, now: () => 1234 })
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('saveState transitions', () => {
  test('saved → saving → saved with lastSavedAt', async () => {
    const { s, io } = mk()
    s.settingsLoaded(true)
    expect(s.getState().saveState).toBe('saved')
    s.apply(withItems(initial, 'a'))
    expect(s.getState().saveState).toBe('pending') // Debounce is pending; the write has not started.
    await vi.advanceTimersByTimeAsync(500)
    expect(io.save).toHaveBeenCalledTimes(1)
    expect(s.getState().lastSavedAt).toBe(1234)
    expect(s.getState().saveState).toBe('saved')
  })

  test('saving is visible while the write is in flight; rejection → error; next success recovers', async () => {
    let resolve!: () => void
    const save = vi.fn((_p: ProjectWithId) => new Promise<void>((r) => (resolve = r)))
    const { s } = mk(mkIo({ save }))
    s.settingsLoaded(true)
    s.apply(withItems(initial, 'a'))
    vi.advanceTimersByTime(500)
    expect(s.getState().saveState).toBe('saving')
    resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.getState().saveState).toBe('saved')

    save.mockRejectedValueOnce(new Error('disk full'))
    s.apply(withItems(initial, 'a', 'b'))
    await vi.advanceTimersByTimeAsync(500)
    expect(s.getState().saveState).toBe('error')
    save.mockResolvedValueOnce(undefined)
    s.apply(withItems(initial, 'a', 'b', 'c'))
    await vi.advanceTimersByTimeAsync(500)
    expect(s.getState().saveState).toBe('saved')
  })

  test('an older write finishing late cannot overwrite the newer write state', async () => {
    const rejects: Array<(e: Error) => void> = []
    const resolves: Array<() => void> = []
    const save = vi.fn(
      (_p: ProjectWithId) =>
        new Promise<void>((res, rej) => {
          resolves.push(res)
          rejects.push(rej)
        })
    )
    const { s } = mk(mkIo({ save }))
    s.settingsLoaded(true)
    s.apply(withItems(initial, 'a'))
    vi.advanceTimersByTime(500)
    s.apply(withItems(initial, 'a', 'b'))
    vi.advanceTimersByTime(500)
    resolves[1]() // The newer write succeeds first.
    await vi.advanceTimersByTimeAsync(0)
    rejects[0](new Error('late failure')) // The older write fails later.
    await vi.advanceTimersByTimeAsync(0)
    expect(s.getState().saveState).toBe('saved')
  })
})

describe('undo / redo wiring', () => {
  test('apply → undo → redo walks history and autosaves each resulting state', async () => {
    const { s, io } = mk()
    s.settingsLoaded(true)
    s.apply(withItems(initial, 'a'))
    s.apply(withItems(initial, 'a', 'b'))
    expect(s.getState().canUndo).toBe(true)
    s.undo()
    expect(s.getState().project.items.map((i) => i.id)).toEqual(['a'])
    expect(s.getState().canRedo).toBe(true)
    await vi.advanceTimersByTimeAsync(500)
    expect(io.save).toHaveBeenCalledTimes(1)
    expect(io.save.mock.calls[0][0].items).toHaveLength(1)
    s.redo()
    expect(s.getState().project.items).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(500)
    expect(io.save.mock.calls[1][0].items).toHaveLength(2)
  })

  test('undo/redo with empty stacks do nothing and do not write', async () => {
    const { s, io } = mk()
    s.settingsLoaded(true)
    s.undo()
    s.redo()
    await vi.advanceTimersByTimeAsync(1000)
    expect(io.save).not.toHaveBeenCalled()
  })

  test('apply keeps the current id when the next project has none', () => {
    const { s } = mk()
    s.apply({ ...createProject('x'), items: [item('a')] })
    expect(s.getState().project.id).toBe('p_init')
  })
})

describe('boot ordering', () => {
  test('edit before settings load is held, then flushed exactly once when autosave turns out enabled', async () => {
    const { s, io } = mk()
    s.apply(withItems(initial, 'a'))
    s.apply(withItems(initial, 'a', 'b'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(io.save).not.toHaveBeenCalled() // Settings are unknown: do not write or discard.
    s.settingsLoaded(true)
    expect(io.save).toHaveBeenCalledTimes(1)
    expect(io.save.mock.calls[0][0].items).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(5000)
    expect(io.save).toHaveBeenCalledTimes(1)
  })

  test('edit before settings load is not written when autosave is disabled', async () => {
    const { s, io } = mk()
    s.apply(withItems(initial, 'a'))
    s.settingsLoaded(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(io.save).not.toHaveBeenCalled()
    // The user later turns autosave back on in settings; subsequent edits are written.
    s.settingsLoaded(true)
    s.apply(withItems(initial, 'z'))
    await vi.advanceTimersByTimeAsync(500)
    expect(io.save).toHaveBeenCalledTimes(1)
  })

  test('restore with no edits is applied: fresh history, no write, saved state', async () => {
    const { s, io } = mk()
    s.startBoot()
    s.settingsLoaded(true)
    const restored: ProjectWithId = withItems({ ...createProject('還原'), id: 'p_old' }, 'r1')
    expect(s.restored(restored)).toBe(true)
    expect(s.getState().project).toEqual(restored)
    expect(s.getState().canUndo).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(io.save).not.toHaveBeenCalled()
  })

  test('restore after the user edited is skipped and does not touch history', async () => {
    const { s, io } = mk()
    s.startBoot()
    s.settingsLoaded(true)
    s.apply(withItems(initial, 'mine'))
    const before = s.getState()
    expect(s.restored({ ...withItems(initial, 'r1'), id: 'p_old' })).toBe(false)
    expect(s.getState().project).toBe(before.project)
    expect(s.getState().canUndo).toBe(true)
    await vi.advanceTimersByTimeAsync(500)
    expect(io.save).toHaveBeenCalledTimes(1)
    expect(io.save.mock.calls[0][0].id).toBe('p_init')
  })

  test('restore resolving to nothing keeps the initial project', () => {
    const { s } = mk()
    s.startBoot()
    expect(s.restored(null)).toBe(false)
    expect(s.getState().project).toEqual(initial)
  })

  test('newProject before the restore resolves also counts as the user taking over', () => {
    const { s } = mk()
    s.startBoot()
    s.newProject()
    expect(s.restored({ ...withItems(initial, 'r1'), id: 'p_old' })).toBe(false)
    expect(s.getState().project.id).toMatch(/^p_new/)
  })
})

describe('newProject', () => {
  test('newProject does not write an empty project until the first edit', async () => {
    const { s, io } = mk()
    s.settingsLoaded(true)
    s.newProject()
    await vi.advanceTimersByTimeAsync(2000)
    expect(io.save).not.toHaveBeenCalled()
    const id = s.getState().project.id
    expect(id).not.toBe('p_init')
    expect(s.getState().canUndo).toBe(false)
    s.apply(withItems(s.getState().project, 'a'))
    await vi.advanceTimersByTimeAsync(500)
    expect(io.save).toHaveBeenCalledTimes(1)
    expect(io.save.mock.calls[0][0].id).toBe(id)
  })

  test('a pending edit of the old project is written before switching to a new project', async () => {
    const { s, io } = mk()
    s.settingsLoaded(true)
    s.apply(withItems(initial, 'a'))
    s.newProject()
    expect(io.saveSync).toHaveBeenCalledTimes(1)
    expect(io.saveSync.mock.calls[0][0].id).toBe('p_init')
    await vi.advanceTimersByTimeAsync(2000)
    expect(io.saveSync).toHaveBeenCalledTimes(1)
  })

})

describe('close-time flush', () => {
  test('flushSync sends the latest project synchronously even inside the debounce window', () => {
    const { s, io } = mk()
    s.settingsLoaded(true)
    s.apply(withItems(initial, 'a'))
    vi.advanceTimersByTime(100)
    s.flushSync()
    expect(io.saveSync).toHaveBeenCalledTimes(1)
    expect(io.saveSync.mock.calls[0][0].items).toHaveLength(1)
    vi.advanceTimersByTime(2000)
    expect(io.save).not.toHaveBeenCalled()
  })

  test('flushSync before settings are known still saves (never lose an edit on close)', () => {
    const { s, io } = mk()
    s.apply(withItems(initial, 'a'))
    s.flushSync()
    expect(io.saveSync).toHaveBeenCalledTimes(1)
  })

  test('flushSync skips clean projects but saves edits with autosave disabled', () => {
    const { s, io } = mk()
    s.settingsLoaded(true)
    s.flushSync()
    expect(io.saveSync).not.toHaveBeenCalled()
    s.settingsLoaded(false)
    s.apply(withItems(initial, 'a'))
    s.flushSync()
    expect(io.saveSync).toHaveBeenCalledTimes(1)
    expect(s.getState().unsaved).toBe(false)
  })
})

describe('subscribe', () => {
  test('notifies on change and stops after unsubscribe', () => {
    const { s } = mk()
    const cb = vi.fn()
    const off = s.subscribe(cb)
    s.apply(withItems(initial, 'a'))
    expect(cb).toHaveBeenCalled()
    off()
    cb.mockClear()
    s.apply(withItems(initial, 'a', 'b'))
    expect(cb).not.toHaveBeenCalled()
  })

  test('getState returns a stable snapshot until something changes', () => {
    const { s } = mk()
    expect(s.getState()).toBe(s.getState())
    const a = s.getState()
    s.apply(withItems(initial, 'a'))
    expect(s.getState()).not.toBe(a)
  })
})

describe('createSessionIo (lastProjectId lives in main)', () => {
  test('save/saveSync call only projects.save / projects.flushSync, never settings.set', async () => {
    const api = {
      projects: { save: vi.fn(async () => true), flushSync: vi.fn(() => true) },
      settings: { set: vi.fn() }
    }
    const io = createSessionIo(api as never)
    await io.save(initial)
    io.saveSync(initial)
    expect(api.projects.save).toHaveBeenCalledWith(initial)
    expect(api.projects.flushSync).toHaveBeenCalledWith(initial)
    expect(api.settings.set).not.toHaveBeenCalled()
  })

  test('a false save result becomes a rejection so saveState goes to error', async () => {
    const io = createSessionIo({ projects: { save: async () => false, flushSync: () => false } } as never)
    await expect(io.save(initial)).rejects.toThrow()
    expect(() => io.saveSync(initial)).toThrow()
  })

  test('without window.api the io is a no-op', async () => {
    const io = createSessionIo(undefined)
    await expect(io.save(initial)).resolves.toBeUndefined()
    expect(() => io.saveSync(initial)).not.toThrow()
  })
})

describe('unsaved changes while autosave is off (I5)', () => {
  test('edits with autosave off mark the session unsaved; nothing is written', async () => {
    const { s, io } = mk()
    s.settingsLoaded(false)
    expect(s.getState().unsaved).toBe(false)
    s.apply(withItems(initial, 'a'))
    expect(s.getState().unsaved).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(io.save).not.toHaveBeenCalled()
    s.undo()
    expect(s.getState().unsaved).toBe(true)
  })

  test('edits made before settings load, then autosave resolves to off, count as unsaved', () => {
    const { s } = mk()
    s.apply(withItems(initial, 'a'))
    s.settingsLoaded(false)
    expect(s.getState().unsaved).toBe(true)
  })

  test('autosave on: never unsaved once the write lands', async () => {
    const { s } = mk()
    s.settingsLoaded(true)
    s.apply(withItems(initial, 'a'))
    await vi.advanceTimersByTimeAsync(500)
    expect(s.getState().unsaved).toBe(false)
  })

  test('turning autosave on later and editing writes and clears the flag', async () => {
    const { s, io } = mk()
    s.settingsLoaded(false)
    s.apply(withItems(initial, 'a'))
    s.settingsLoaded(true)
    s.apply(withItems(initial, 'a', 'b'))
    await vi.advanceTimersByTimeAsync(500)
    expect(io.save).toHaveBeenCalledTimes(1)
    expect(s.getState().unsaved).toBe(false)
  })
})

describe('Synchronous save data protection', () => {
  test('Window close sends the latest snapshot while an async write is still pending', async () => {
    const { s, io } = mk()
    let complete: () => void = () => undefined
    io.save.mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve }))
    s.settingsLoaded(true)
    s.apply(withItems(initial, 'a'))
    vi.advanceTimersByTime(500)
    s.apply(withItems(initial, 'a', 'b'))
    expect(s.flushSync()).toBe(true)
    expect(io.saveSync.mock.calls[0][0].items).toHaveLength(2)
    complete()
    await Promise.resolve()
    expect(s.getState().saveState).toBe('saved')
    expect(s.getState().unsaved).toBe(false)
  })

  test('A failed synchronous save preserves edits and error state, then clears them after a successful retry', () => {
    const { s, io } = mk()
    s.settingsLoaded(false)
    s.apply(withItems(initial, 'a'))
    io.saveSync.mockImplementationOnce(() => { throw new Error('磁碟已滿') })
    expect(s.newProject()).toBe(false)
    expect(s.getState().project.id).toBe('p_init')
    expect(s.getState().unsaved).toBe(true)
    expect(s.getState().saveState).toBe('error')
    expect(s.flushSync()).toBe(true)
    expect(s.getState().saveState).toBe('saved')
  })

  test('An async result from an old project cannot overwrite the new project state', async () => {
    const { s, io } = mk()
    let reject: (e: Error) => void = () => undefined
    io.save.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail }))
    s.settingsLoaded(true)
    s.apply(withItems(initial, 'a'))
    vi.advanceTimersByTime(500)
    expect(s.newProject()).toBe(true)
    reject(new Error('舊寫入失敗'))
    await Promise.resolve()
    expect(s.getState().saveState).toBe('saved')
    expect(s.getState().project.id).toMatch(/^p_new/)
  })
})
