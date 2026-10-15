import { describe, it, expect, beforeEach } from 'vitest'
import { Library } from './library'
import path from 'path'
import fs from 'fs'
import os from 'os'

describe('Library', () => {
  let tmpFile: string
  let lib: Library

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `apexhl_lib_test_${Date.now()}_${Math.random()}.json`)
    lib = new Library(tmpFile)
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
})
