import { describe, expect, test } from 'vitest'
import type { LibraryEntry } from '../../main/library'
import { filterEntries } from './libraryFilter'

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

describe('filterEntries', () => {
  test('filterEntries combines query, favorite and kind; hl filter uses entry.hl', () => {
    const all = filterEntries(list, { query: '', favoriteOnly: false, kind: 'all' })
    expect(all).toHaveLength(3)

  // query: case-insensitive filename substring.
    expect(filterEntries(list, { query: 'apex', favoriteOnly: false, kind: 'all' }).map((e) => e.path)).toEqual([
      list[0].path,
      list[1].path
    ])

    // favorite
    expect(filterEntries(list, { query: '', favoriteOnly: true, kind: 'all' })).toHaveLength(2)

    // kind
    expect(filterEntries(list, { query: '', favoriteOnly: false, kind: 'knock' })).toHaveLength(2)
    expect(filterEntries(list, { query: '', favoriteOnly: false, kind: 'assist' })).toHaveLength(2)
    expect(filterEntries(list, { query: '', favoriteOnly: false, kind: 'hl' }).map((e) => e.path)).toEqual([
      list[0].path
    ])

  // Combined filters: apex + favorites + has highlights.
    expect(
      filterEntries(list, { query: 'Apex', favoriteOnly: true, kind: 'hl' }).map((e) => e.path)
    ).toEqual([list[0].path])

  // Unanalyzed videos (without counts/hl) are hidden by event/highlight filters but shown under All.
    const pending: LibraryEntry[] = [entry('D:/rec/pending.mp4', { status: 'pending', progress: 0 })]
    expect(filterEntries(pending, { query: '', favoriteOnly: false, kind: 'all' })).toHaveLength(1)
    expect(filterEntries(pending, { query: '', favoriteOnly: false, kind: 'knock' })).toHaveLength(0)
    expect(filterEntries(pending, { query: '', favoriteOnly: false, kind: 'hl' })).toHaveLength(0)
  })
})
