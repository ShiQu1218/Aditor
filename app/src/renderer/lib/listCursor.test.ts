import { describe, expect, test } from 'vitest'
import { autoScrollDue, cursorScrollTarget, revealScrollTarget, rovingTarget } from './listCursor'

const base = { rowHeight: 44, viewHeight: 440, count: 300 } // Ten visible rows; max scrollTop = 300*44-440 = 12760.

describe('cursorScrollTarget', () => {
  test('row already fully visible -> null (no scroll)', () => {
    expect(cursorScrollTarget({ ...base, index: 5, scrollTop: 0 })).toBeNull()
    expect(cursorScrollTarget({ ...base, index: 14, scrollTop: 220 })).toBeNull() // Within 220..660.
  })

  test('row above the viewport aligns to its top edge', () => {
    expect(cursorScrollTarget({ ...base, index: 3, scrollTop: 1000 })).toBe(3 * 44)
  })

  test('row below the viewport aligns its bottom edge to the view bottom', () => {
    // Index 20 bottom = 21*44 = 924; scrollTop = 924 - 440 = 484.
    expect(cursorScrollTarget({ ...base, index: 20, scrollTop: 0 })).toBe(484)
  })

  test('wrap-around: last -> first scrolls to 0, first -> last scrolls to the max', () => {
    expect(cursorScrollTarget({ ...base, index: 0, scrollTop: 12760 })).toBe(0)
    expect(cursorScrollTarget({ ...base, index: 299, scrollTop: 0 })).toBe(12760)
  })

  test('far jump and clamping to [0, max]', () => {
    expect(cursorScrollTarget({ ...base, index: 150, scrollTop: 0 })).toBe(151 * 44 - 440)
    expect(cursorScrollTarget({ ...base, index: 295, scrollTop: 0 })).toBeLessThanOrEqual(12760)
    // Content is shorter than the viewport, so scrolling is never needed.
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

describe('revealScrollTarget (variable-height content, e.g. grid rows under date headers)', () => {
  const base = { scrollTop: 100, viewHeight: 200, contentHeight: 1000 }
  test('already fully visible -> null', () => {
    expect(revealScrollTarget({ ...base, top: 150, height: 80 })).toBeNull()
  })
  test('above the window -> align top; below -> align bottom', () => {
    expect(revealScrollTarget({ ...base, top: 40, height: 80 })).toBe(40)
    expect(revealScrollTarget({ ...base, top: 330, height: 80 })).toBe(210)
  })
  test('clamped to the scrollable range', () => {
    expect(revealScrollTarget({ ...base, top: 0, height: 80 })).toBe(0)
    expect(revealScrollTarget({ ...base, top: 950, height: 200 })).toBe(800)
  })
})
