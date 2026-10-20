import { afterAll, describe, expect, test } from 'vitest'
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
    // Newest to oldest within a group.
    expect(groups[0].entries.map((e) => e.path)).toEqual(['a', 'd'])
    expect(groups[1].entries.map((e) => e.path)).toEqual(['c'])
  })

  test('groupByDate handles timezone boundary at local midnight', () => {
    const now = new Date(2026, 9, 16, 0, 30, 0).getTime()
    const beforeMidnight = new Date(2026, 9, 15, 23, 59, 0).getTime()
    const afterMidnight = new Date(2026, 9, 16, 0, 10, 0).getTime()

    const groups = groupByDate([entry('late', beforeMidnight), entry('early', afterMidnight)], now)

    // Items on either side of local midnight belong to different groups (not grouped by UTC date).
    expect(groups.map((g) => g.label)).toEqual(['今天', '昨天'])
    expect(groups[0].key).toBe('2026-10-16')
    expect(groups[1].key).toBe('2026-10-15')
  })

  test('empty input returns no groups', () => {
    expect(groupByDate([], Date.now())).toEqual([])
  })
})

// Switching TZ confirms grouping by local day, not UTC: two items around local midnight must remain on separate days even in a time zone far from UTC.
describe('groupByDate local-day split is independent of UTC', () => {
  const originalTz = process.env.TZ
  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ
    else process.env.TZ = originalTz
  })

  test.each([
    ['Asia/Taipei', -480],
    ['America/Los_Angeles', 420], // October 2026 is PDT (UTC-7).
    ['Pacific/Kiritimati', -840] // UTC+14
  ])('%s: 23:59 and 00:10 around local midnight land in different labelled days', (tz, expectedOffset) => {
    process.env.TZ = tz
    // If the runtime cannot switch TZ dynamically, fail explicitly instead of silently skipping the assertion.
    expect(new Date(2026, 9, 16, 12).getTimezoneOffset()).toBe(expectedOffset)

    const now = new Date(2026, 9, 16, 0, 30).getTime()
    const late = new Date(2026, 9, 15, 23, 59).getTime()
    const early = new Date(2026, 9, 16, 0, 10).getTime()
    const groups = groupByDate([entry('late', late), entry('early', early)], now)

    expect(groups.map((g) => [g.key, g.label])).toEqual([
      ['2026-10-16', '今天'],
      ['2026-10-15', '昨天']
    ])
    expect(groups[0].entries[0].path).toBe('early')
    expect(groups[1].entries[0].path).toBe('late')
  })

  test('after local midnight the same entries re-label (today -> yesterday)', () => {
    process.env.TZ = 'Asia/Taipei'
    const e = entry('a', new Date(2026, 9, 16, 23, 0).getTime())
    expect(groupByDate([e], new Date(2026, 9, 16, 23, 59).getTime())[0].label).toBe('今天')
    expect(groupByDate([e], new Date(2026, 9, 17, 0, 1).getTime())[0].label).toBe('昨天')
  })
})
