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
  vi.useRealTimers()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('Library durability (I3)', () => {
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
