import { describe, expect, test } from 'vitest'
import type { LibraryEntry } from '../../main/library'
import { entryGame, filterEntries } from './libraryFilter'

const entry = (path: string, over: Partial<LibraryEntry> = {}): LibraryEntry => ({
  path,
  addedAt: Date.now(),
  favorite: false,
  status: 'done',
  progress: 1,
  ...over
})

const list: LibraryEntry[] = [
  entry('D:/rec/Apex Legends_10-13-2026_16-45-41.mp4', {
    counts: { knock: 15, assist: 6 },
    hl: 4,
    favorite: true
  }),
  entry('D:/rec/Apex Legends_10-13-2026_22-41-18.mp4', {
    counts: { knock: 0, assist: 3 },
    hl: 0
  }),
  entry('D:/rec/other_game_10-14.mp4', { counts: { knock: 2, assist: 0 }, favorite: true })
]

describe('entryGame', () => {
  test('uses the explicit game', () => {
    expect(entryGame(entry('D:/rec/valorant.mp4', { game: 'valorant' }))).toBe('valorant')
    expect(entryGame(entry('D:/rec/apex.mp4', { game: 'apex' }))).toBe('apex')
  })

  test('completed entries without a game are legacy Apex analyses', () => {
    expect(entryGame(entry('D:/rec/legacy.mp4', { status: 'done' }))).toBe('apex')
  })

  test('entries that are not done and have no game yet return null', () => {
    expect(entryGame(entry('D:/rec/pending.mp4', { status: 'pending', progress: 0 }))).toBeNull()
    expect(entryGame(entry('D:/rec/analyzing.mp4', { status: 'analyzing' }))).toBeNull()
    expect(
      entryGame(entry('D:/rec/unknown.mp4', { status: 'error', progress: 0, errorCode: 'unknown_game' }))
    ).toBeNull()
  })
})

describe('filterEntries', () => {
  test('filterEntries combines query, favorite and kind; hl filter uses entry.hl', () => {
    const all = filterEntries(list, { query: '', favoriteOnly: false, kind: 'all', game: 'all' })
    expect(all).toHaveLength(3)

  // query: case-insensitive filename substring.
    expect(
      filterEntries(list, { query: 'apex', favoriteOnly: false, kind: 'all', game: 'all' }).map((e) => e.path)
    ).toEqual([list[0].path, list[1].path])

    // favorite
    expect(filterEntries(list, { query: '', favoriteOnly: true, kind: 'all', game: 'all' })).toHaveLength(2)

    // kind
    expect(filterEntries(list, { query: '', favoriteOnly: false, kind: 'knock', game: 'all' })).toHaveLength(2)
    expect(filterEntries(list, { query: '', favoriteOnly: false, kind: 'assist', game: 'all' })).toHaveLength(2)
    expect(
      filterEntries(list, { query: '', favoriteOnly: false, kind: 'hl', game: 'all' }).map((e) => e.path)
    ).toEqual([list[0].path])

  // Combined filters: apex + favorites + has highlights.
    expect(
      filterEntries(list, { query: 'Apex', favoriteOnly: true, kind: 'hl', game: 'all' }).map((e) => e.path)
    ).toEqual([list[0].path])

  // Unanalyzed videos (without counts/hl) are hidden by event/highlight filters but shown under All.
    const pending: LibraryEntry[] = [entry('D:/rec/pending.mp4', { status: 'pending', progress: 0 })]
    expect(filterEntries(pending, { query: '', favoriteOnly: false, kind: 'all', game: 'all' })).toHaveLength(1)
    expect(filterEntries(pending, { query: '', favoriteOnly: false, kind: 'knock', game: 'all' })).toHaveLength(0)
    expect(filterEntries(pending, { query: '', favoriteOnly: false, kind: 'hl', game: 'all' })).toHaveLength(0)
  })

  test('game filtering combines with kind and favorites', () => {
    const games: LibraryEntry[] = [
      entry('D:/rec/apex_explicit.mp4', {
        game: 'apex',
        counts: { knock: 2, assist: 0 },
        favorite: true
      }),
      entry('D:/rec/valorant.mp4', {
        game: 'valorant',
        counts: { knock: 1, assist: 2 },
        hl: 2,
        favorite: true
      }),
      entry('D:/rec/legacy_apex.mp4', { counts: { knock: 0, assist: 1 } }),
      entry('D:/rec/pending.mp4', { status: 'pending', progress: 0 }),
      entry('D:/rec/unknown.mp4', { status: 'error', progress: 0, errorCode: 'unknown_game' })
    ]

    // Legacy completed entries count as Apex; pending/unknown-game entries belong to no game yet.
    expect(
      filterEntries(games, { query: '', favoriteOnly: false, kind: 'all', game: 'apex' }).map((e) => e.path)
    ).toEqual([games[0].path, games[2].path])
    expect(
      filterEntries(games, { query: '', favoriteOnly: false, kind: 'all', game: 'valorant' }).map((e) => e.path)
    ).toEqual([games[1].path])
    expect(
      filterEntries(games, { query: '', favoriteOnly: false, kind: 'knock', game: 'apex' }).map((e) => e.path)
    ).toEqual([games[0].path])
    expect(
      filterEntries(games, { query: '', favoriteOnly: true, kind: 'hl', game: 'valorant' }).map((e) => e.path)
    ).toEqual([games[1].path])
    expect(filterEntries(games, { query: 'valo', favoriteOnly: false, kind: 'all', game: 'apex' })).toHaveLength(0)
  })
})
