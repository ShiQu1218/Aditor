import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Library } from './library'

let dir: string
let file: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-lib-'))
  file = path.join(dir, 'library.json')
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('Library durability (I3)', () => {
  it('deletes recorded sources after reloading and persists removal', () => {
    const video = path.join(dir, 'recorded.mp4')
    fs.writeFileSync(video, 'recording')
    const lib = new Library(file)
    lib.add([video], 'recording')
    expect(new Library(file).get(video)?.source).toBe('recording')
    expect(new Library(file).remove(video.toUpperCase())).toBe(true)
    expect(fs.existsSync(video)).toBe(false)
    expect(new Library(file).getEntries()).toEqual([])
  })

  it('preserves external sources and legacy sources with unknown provenance', () => {
    const external = path.join(dir, 'external.mp4')
    const legacy = path.join(dir, 'legacy.mp4')
    fs.writeFileSync(external, 'external')
    fs.writeFileSync(legacy, 'legacy')
    const lib = new Library(file)
    lib.add([external, legacy])
    lib.update(legacy, { source: undefined })
    const reloaded = new Library(file)
    expect(reloaded.remove(external)).toBe(true)
    expect(reloaded.remove(legacy)).toBe(true)
    expect(fs.readFileSync(external, 'utf8')).toBe('external')
    expect(fs.readFileSync(legacy, 'utf8')).toBe('legacy')
  })

  it('marks recordings already imported by a watcher without duplicating them or losing ownership on reimport', () => {
    const lib = new Library(file)
    const video = path.join(dir, 'watched.mp4')
    lib.add([video])
    expect(lib.add([video], 'recording')).toEqual([])
    lib.add([video])
    const entries = new Library(file).getEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0].source).toBe('recording')
  })

  it('retains the entry and source when deletion fails', () => {
    const video = path.join(dir, 'locked.mp4')
    fs.writeFileSync(video, 'recording')
    const lib = new Library(file)
    lib.add([video], 'recording')
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
      throw Object.assign(new Error('file is busy'), { code: 'EBUSY' })
    })
    expect(() => lib.remove(video)).toThrow('file is busy')
    expect(new Library(file).get(video)).toBeDefined()
    expect(lib.get(video)).toBeDefined()
    expect(fs.existsSync(video)).toBe(true)
  })

  it('removes missing recorded files and ignores paths outside the library', () => {
    const lib = new Library(file)
    lib.add([path.join(dir, 'missing.mp4')], 'recording')
    expect(lib.remove(path.join(dir, 'missing.mp4'))).toBe(true)
    const outside = path.join(dir, 'outside.mp4')
    fs.writeFileSync(outside, 'keep')
    expect(lib.remove(outside)).toBe(false)
    expect(fs.existsSync(outside)).toBe(true)
  })

  it('a corrupt library.json is moved to library.bak.<ts>.json (not overwritten) and reported', () => {
    fs.writeFileSync(file, '[{"path":"D:/a.mp4",')
    const lib = new Library(file)
    expect(lib.getEntries()).toEqual([])
    expect(lib.corruptBackup).toMatch(/library\.bak\.\d+\.json$/)
    expect(fs.readFileSync(lib.corruptBackup!, 'utf-8')).toBe('[{"path":"D:/a.mp4",')
    lib.add(['D:/Videos/new.mp4'])
    expect(fs.readFileSync(lib.corruptBackup!, 'utf-8')).toBe('[{"path":"D:/a.mp4",')
  })

  it('a JSON value that is not an array is treated as corrupt too', () => {
    fs.writeFileSync(file, '{"entries":[]}')
    const lib = new Library(file)
    expect(lib.corruptBackup).not.toBeNull()
  })

  it('a healthy file has no corruptBackup', () => {
    fs.writeFileSync(file, '[]')
    expect(new Library(file).corruptBackup).toBeNull()
  })

  it('save is atomic: writes a tmp file then renames (no leftover tmp, original intact when rename fails)', () => {
    const lib = new Library(file)
    lib.add(['D:/Videos/a.mp4'])
    expect(fs.readdirSync(dir)).toEqual(['library.json'])
    const before = fs.readFileSync(file, 'utf-8')
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('EPERM')
    })
    lib.add(['D:/Videos/b.mp4'])
    spy.mockRestore()
    expect(fs.readFileSync(file, 'utf-8')).toBe(before)
  })

  it('progress-only updates are kept in memory and written at most once per 2 s; flush() writes immediately', () => {
    vi.useFakeTimers()
    const lib = new Library(file)
    lib.add(['D:/Videos/a.mp4'])
    const writes = vi.spyOn(fs, 'renameSync')
    for (let i = 1; i <= 20; i++) lib.update('D:/Videos/a.mp4', { progress: i / 20 })
    expect(writes).toHaveBeenCalledTimes(0)
    vi.advanceTimersByTime(2100)
    expect(writes).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))[0].progress).toBe(1)
    lib.update('D:/Videos/a.mp4', { progress: 0.5 })
    lib.flush()
    expect(writes).toHaveBeenCalledTimes(2)
    writes.mockRestore()
  })

  it('a status change is written immediately (and supersedes pending progress)', () => {
    vi.useFakeTimers()
    const lib = new Library(file)
    lib.add(['D:/Videos/a.mp4'])
    lib.update('D:/Videos/a.mp4', { progress: 0.4 })
    lib.update('D:/Videos/a.mp4', { status: 'done', progress: 1 })
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8'))[0]
    expect(saved.status).toBe('done')
    expect(saved.progress).toBe(1)
  })
})
