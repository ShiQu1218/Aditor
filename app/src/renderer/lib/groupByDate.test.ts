import { describe, expect, test } from 'vitest'
import type { LibraryEntry } from '../../main/library'
import { groupByDate } from './groupByDate'

const entry = (path: string, addedAt: number, over: Partial<LibraryEntry> = {}): LibraryEntry => ({
  path,
  addedAt,
  favorite: false,
  status: 'done',
  progress: 1,
  ...over
})

describe('groupByDate', () => {
  test('groupByDate labels today/yesterday and sorts newest first', () => {
    const now = new Date(2026, 9, 16, 12, 0, 0).getTime()
    const today10 = new Date(2026, 9, 16, 10, 0, 0).getTime()
    const today8 = new Date(2026, 9, 16, 8, 0, 0).getTime()
    const yesterday = new Date(2026, 9, 15, 22, 0, 0).getTime()
    const older = new Date(2026, 9, 13, 17, 0, 0).getTime()

    const groups = groupByDate(
      [entry('a', today10), entry('b', older), entry('c', yesterday), entry('d', today8)],
      now
    )

    expect(groups.map((g) => g.label)).toEqual(['今天', '昨天', '2026 年 10 月 13 日'])
    expect(groups.map((g) => g.key)).toEqual(['2026-10-16', '2026-10-15', '2026-10-13'])
    // 組內新到舊
    expect(groups[0].entries.map((e) => e.path)).toEqual(['a', 'd'])
    expect(groups[1].entries.map((e) => e.path)).toEqual(['c'])
  })

  test('groupByDate handles timezone boundary at local midnight', () => {
    const now = new Date(2026, 9, 16, 0, 30, 0).getTime()
    const beforeMidnight = new Date(2026, 9, 15, 23, 59, 0).getTime()
    const afterMidnight = new Date(2026, 9, 16, 0, 10, 0).getTime()

    const groups = groupByDate([entry('late', beforeMidnight), entry('early', afterMidnight)], now)

    // 本地午夜前後分屬不同組（不是以 UTC 日期切）
    expect(groups.map((g) => g.label)).toEqual(['今天', '昨天'])
    expect(groups[0].key).toBe('2026-10-16')
    expect(groups[1].key).toBe('2026-10-15')
  })

  test('empty input returns no groups', () => {
    expect(groupByDate([], Date.now())).toEqual([])
  })
})
