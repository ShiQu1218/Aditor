import { describe, it, expect, beforeEach } from 'vitest'
import { Library } from './library'
import path from 'path'
import fs from 'fs'
import os from 'os'

describe('Library', () => {
  let tmpFile: string
  let lib: Library

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `aditor_lib_test_${Date.now()}_${Math.random()}.json`)
    lib = new Library(tmpFile)
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
})
