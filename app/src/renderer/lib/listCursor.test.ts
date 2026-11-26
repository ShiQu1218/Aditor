import { describe, expect, test } from 'vitest'
import { revealScrollTarget } from './listCursor'

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
