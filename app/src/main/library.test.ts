import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Library } from './library'
import fs from 'fs'
import path from 'path'
import os from 'os'

describe('Library', () => {
  let tmpFile: string
  let lib: Library

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `aditor_lib_test_${Date.now()}_${Math.random()}.json`)
    lib = new Library(tmpFile)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps the recorded game, also for a file a folder watcher imported first', () => {
    lib.add(['D:/Videos/obs.mp4'], 'recording', 'valorant')
    lib.add(['D:/Videos/watched.mp4'])
    lib.add(['D:/Videos/watched.mp4'], 'recording', 'valorant')
    expect(lib.get('D:/Videos/obs.mp4')?.game).toBe('valorant')
    expect(lib.get('D:/Videos/watched.mp4')?.game).toBe('valorant')
  })

  it('add dedupes by normalized path and filters extensions', () => {
    const p1 = 'D:\\Videos\\match1.MP4'
    const p1_lower = 'd:/videos/match1.mp4'
    const p2 = 'D:/Videos/match2.mkv'
    const bad1 = 'D:/Videos/notes.txt'
    const bad2 = 'D:/Videos/match.avi'

    const added = lib.add([p1, p1_lower, p2, bad1, bad2])
    expect(added.length).toBe(2)
    expect(added.map((e) => e.path)).toEqual([p1, p2])

    // Adding p1 again should return empty
    const addedAgain = lib.add([p1_lower])
    expect(addedAgain.length).toBe(0)
    expect(lib.getEntries().length).toBe(2)
  })

  it('search matches filename case-insensitively and filters favorites', () => {
    lib.add(['D:/Videos/Apex_Match_01.mp4', 'D:/Videos/Apex_Clip_02.mp4', 'D:/Videos/Other.mp4'])
    lib.toggleFavorite('D:/Videos/Apex_Match_01.mp4')

    const searchMatch = lib.search('match')
    expect(searchMatch.length).toBe(1)
    expect(searchMatch[0].path).toBe('D:/Videos/Apex_Match_01.mp4')

    const searchFav = lib.search('', { favorite: true })
    expect(searchFav.length).toBe(1)
    expect(searchFav[0].path).toBe('D:/Videos/Apex_Match_01.mp4')
  })

  it('persists favorites across load', () => {
    lib.add(['D:/Videos/Apex_01.mp4'])
    lib.toggleFavorite('D:/Videos/Apex_01.mp4')
    expect(lib.getEntries()[0].favorite).toBe(true)

    // New instance loading from same file
    const lib2 = new Library(tmpFile)
    lib2.load()
    expect(lib2.getEntries().length).toBe(1)
    expect(lib2.getEntries()[0].favorite).toBe(true)
  })

  it('get() finds an entry by normalised path', () => {
    lib.add(['D:/Videos/Get_Me.mp4'])
    expect(lib.get('d:/VIDEOS/get_me.mp4')?.path).toBe('D:/Videos/Get_Me.mp4')
    expect(lib.get('D:/Videos/none.mp4')).toBeUndefined()
  })

  it('resetStaleAnalyzing() turns leftovers of an interrupted run into idle entries and persists', () => {
    lib.add(['D:/Videos/a.mp4', 'D:/Videos/b.mp4'])
    lib.update('D:/Videos/a.mp4', { status: 'analyzing', progress: 0.4, analyzingSince: 123 })
    lib.update('D:/Videos/b.mp4', { status: 'done', progress: 1 })
    expect(lib.resetStaleAnalyzing()).toBe(1)
    const a = lib.get('D:/Videos/a.mp4')!
    expect(a).toMatchObject({ status: 'pending', progress: 0 })
    expect(a.analyzingSince).toBeUndefined()
    expect(lib.get('D:/Videos/b.mp4')?.status).toBe('done')
    expect(new Library(tmpFile).get('D:/Videos/a.mp4')?.status).toBe('pending')
    expect(lib.resetStaleAnalyzing()).toBe(0)
  })

  describe('remove', () => {
    it('deletes the source file of external and legacy entries when deleteSource is set', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-lib-remove-'))
      try {
        const external = path.join(dir, 'external.mp4')
        const legacy = path.join(dir, 'legacy.mp4')
        fs.writeFileSync(external, 'external')
        fs.writeFileSync(legacy, 'legacy')
        lib.add([external, legacy], 'external')
        lib.update(legacy, { source: undefined })

        expect(lib.remove(external, { deleteSource: true })).toBe(true)
        expect(lib.remove(legacy, { deleteSource: true })).toBe(true)
        expect(fs.existsSync(external)).toBe(false)
        expect(fs.existsSync(legacy)).toBe(false)
        expect(lib.getEntries()).toEqual([])
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('keeps the source file of external and legacy entries by default', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-lib-remove-'))
      try {
        const external = path.join(dir, 'external.mp4')
        const legacy = path.join(dir, 'legacy.mp4')
        fs.writeFileSync(external, 'external')
        fs.writeFileSync(legacy, 'legacy')
        lib.add([external, legacy], 'external')
        lib.update(legacy, { source: undefined })

        expect(lib.remove(external)).toBe(true)
        expect(lib.remove(legacy)).toBe(true)
        expect(fs.existsSync(external)).toBe(true)
        expect(fs.existsSync(legacy)).toBe(true)
        expect(lib.getEntries()).toEqual([])
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('always deletes the source file of a recording, with and without deleteSource', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-lib-remove-'))
      try {
        const recording = path.join(dir, 'recording.mp4')
        const kept = path.join(dir, 'kept.mp4')
        fs.writeFileSync(recording, 'recording')
        fs.writeFileSync(kept, 'recording')
        lib.add([recording, kept], 'recording')

        expect(lib.remove(recording)).toBe(true)
        expect(lib.remove(kept, { deleteSource: false })).toBe(true)
        expect(fs.existsSync(recording)).toBe(false)
        expect(fs.existsSync(kept)).toBe(false)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('tolerates a missing source file and keeps the entry when the deletion fails', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-lib-remove-'))
      try {
        const missing = path.join(dir, 'missing.mp4')
        const locked = path.join(dir, 'locked.mp4')
        fs.writeFileSync(locked, 'external')
        lib.add([missing, locked], 'external')

        // A file that is already gone is still removed from the library.
        expect(lib.remove(missing, { deleteSource: true })).toBe(true)
        expect(lib.get(missing)).toBeUndefined()

        const realUnlink = fs.unlinkSync
        vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
          if (String(file) === locked) throw Object.assign(new Error('file is busy'), { code: 'EBUSY' })
          realUnlink(file)
        })
        expect(() => lib.remove(locked, { deleteSource: true })).toThrow('file is busy')
        expect(lib.get(locked)).toBeDefined()
        expect(fs.existsSync(locked)).toBe(true)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe('removeMany', () => {
    it('removes every entry, unlinks recording sources (ENOENT tolerated), keeps external files and saves once', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-lib-many-'))
      try {
        const recording = path.join(dir, 'recording.mp4')
        const missing = path.join(dir, 'missing.mp4')
        const external = path.join(dir, 'external.mp4')
        fs.writeFileSync(recording, 'recording')
        fs.writeFileSync(external, 'external')
        lib.add([recording, missing, external], 'recording')
        lib.update(external, { source: 'external' })
        const save = vi.spyOn(lib, 'save')

        expect(lib.removeMany([recording, missing, external])).toEqual({ removed: [recording, missing, external], failed: [] })
        expect(fs.existsSync(recording)).toBe(false)
        expect(fs.existsSync(external)).toBe(true)
        expect(lib.getEntries()).toEqual([])
        expect(save).toHaveBeenCalledTimes(1)
        expect(new Library(tmpFile).getEntries()).toEqual([])
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('keeps entries whose source file cannot be deleted and reports only those as failed', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-lib-many-'))
      try {
        const removable = path.join(dir, 'removable.mp4')
        const locked = path.join(dir, 'locked.mp4')
        fs.writeFileSync(removable, 'recording')
        fs.writeFileSync(locked, 'recording')
        lib.add([removable, locked], 'recording')
        const realUnlink = fs.unlinkSync
        vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
          if (String(file) === locked) throw Object.assign(new Error('file is busy'), { code: 'EBUSY' })
          realUnlink(file)
        })

        expect(lib.removeMany([removable, locked])).toEqual({ removed: [removable], failed: [locked] })
        expect(lib.get(removable)).toBeUndefined()
        expect(lib.get(locked)).toBeDefined()
        expect(fs.existsSync(locked)).toBe(true)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('skips paths that are no longer in the library and de-duplicates repeated paths', () => {
      lib.add(['D:/Videos/a.mp4'])
      expect(lib.removeMany(['D:/Videos/a.mp4', 'd:/videos/A.mp4', 'D:/Videos/unknown.mp4'])).toEqual({
        removed: ['D:/Videos/a.mp4'],
        failed: []
      })
    })

    it('unlinks external and legacy sources with deleteSource and keeps them without it', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-lib-many-'))
      try {
        const external = path.join(dir, 'external.mp4')
        const legacy = path.join(dir, 'legacy.mp4')
        const kept = path.join(dir, 'kept.mp4')
        fs.writeFileSync(external, 'external')
        fs.writeFileSync(legacy, 'legacy')
        fs.writeFileSync(kept, 'kept')
        lib.add([external, legacy, kept], 'external')
        lib.update(legacy, { source: undefined })

        expect(lib.removeMany([external, legacy], { deleteSource: true })).toEqual({ removed: [external, legacy], failed: [] })
        expect(fs.existsSync(external)).toBe(false)
        expect(fs.existsSync(legacy)).toBe(false)

        expect(lib.removeMany([kept])).toEqual({ removed: [kept], failed: [] })
        expect(fs.existsSync(kept)).toBe(true)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('reports a source that cannot be deleted as failed and keeps its entry', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-lib-many-'))
      try {
        const locked = path.join(dir, 'locked.mp4')
        fs.writeFileSync(locked, 'external')
        lib.add([locked], 'external')
        vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
          throw Object.assign(new Error('file is busy'), { code: 'EBUSY' })
        })

        expect(lib.removeMany([locked], { deleteSource: true })).toEqual({ removed: [], failed: [locked] })
        expect(lib.get(locked)).toBeDefined()
        expect(fs.existsSync(locked)).toBe(true)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  it('backs up a library whose array holds a malformed entry instead of crashing startup', () => {
    fs.writeFileSync(tmpFile, JSON.stringify([null]))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const loaded = new Library(tmpFile)
    expect(loaded.getEntries()).toEqual([])
    expect(loaded.corruptBackup).not.toBeNull()
    expect(fs.readFileSync(loaded.corruptBackup!, 'utf-8')).toBe('[null]')
    expect(() => loaded.resetStaleAnalyzing()).not.toThrow()
  })
})
