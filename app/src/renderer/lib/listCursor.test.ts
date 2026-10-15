import { describe, expect, test } from 'vitest'
import { autoScrollDue, cursorScrollTarget, rovingTarget } from './listCursor'

const base = { rowHeight: 44, viewHeight: 440, count: 300 } // 可視 10 列，最大 scrollTop = 300*44-440 = 12760

describe('cursorScrollTarget', () => {
  test('row already fully visible -> null (no scroll)', () => {
    expect(cursorScrollTarget({ ...base, index: 5, scrollTop: 0 })).toBeNull()
    expect(cursorScrollTarget({ ...base, index: 14, scrollTop: 220 })).toBeNull() // 220..660 內
  })

  test('row above the viewport aligns to its top edge', () => {
    expect(cursorScrollTarget({ ...base, index: 3, scrollTop: 1000 })).toBe(3 * 44)
  })

  test('row below the viewport aligns its bottom edge to the view bottom', () => {
    // index 20 底 = 21*44 = 924；scrollTop = 924 - 440 = 484
    expect(cursorScrollTarget({ ...base, index: 20, scrollTop: 0 })).toBe(484)
  })

  test('wrap-around: last -> first scrolls to 0, first -> last scrolls to the max', () => {
    expect(cursorScrollTarget({ ...base, index: 0, scrollTop: 12760 })).toBe(0)
    expect(cursorScrollTarget({ ...base, index: 299, scrollTop: 0 })).toBe(12760)
  })

  test('far jump and clamping to [0, max]', () => {
    expect(cursorScrollTarget({ ...base, index: 150, scrollTop: 0 })).toBe(151 * 44 - 440)
    expect(cursorScrollTarget({ ...base, index: 295, scrollTop: 0 })).toBeLessThanOrEqual(12760)
    // 內容比視窗短：永遠不需要捲動
    expect(cursorScrollTarget({ rowHeight: 44, viewHeight: 440, count: 5, index: 4, scrollTop: 0 })).toBeNull()
  })

  test('invalid index / empty list -> null', () => {
    expect(cursorScrollTarget({ ...base, index: -1, scrollTop: 0 })).toBeNull()
    expect(cursorScrollTarget({ ...base, index: 300, scrollTop: 0 })).toBeNull()
    expect(cursorScrollTarget({ ...base, count: 0, index: 0, scrollTop: 0 })).toBeNull()
  })
})

describe('rovingTarget', () => {
  test('keeps the cursor row when rendered, otherwise the first rendered row (list stays Tab-reachable)', () => {
    expect(rovingTarget('c', ['a', 'b', 'c'])).toBe('c')
    expect(rovingTarget('zzz', ['a', 'b', 'c'])).toBe('a')
    expect(rovingTarget(null, ['a', 'b'])).toBe('a')
    expect(rovingTarget('a', [])).toBeNull()
  })
})

describe('autoScrollDue (playhead follow rate limit)', () => {
  test('first time always due; afterwards only after the interval', () => {
    expect(autoScrollDue(1000, 0, 500)).toBe(true)
    expect(autoScrollDue(1200, 1000, 500)).toBe(false)
    expect(autoScrollDue(1500, 1000, 500)).toBe(true)
  })
})
