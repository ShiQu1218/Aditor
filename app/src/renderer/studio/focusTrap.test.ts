import { describe, expect, test } from 'vitest'
import { nextTrapIndex } from './focusTrap'

describe('nextTrapIndex', () => {
  test('Tab cycles forward and wraps to the first', () => {
    expect(nextTrapIndex(3, 0, false)).toBe(1)
    expect(nextTrapIndex(3, 2, false)).toBe(0)
  })
  test('Shift+Tab cycles backward and wraps to the last', () => {
    expect(nextTrapIndex(3, 1, true)).toBe(0)
    expect(nextTrapIndex(3, 0, true)).toBe(2)
  })
  test('focus outside the list (index -1, e.g. the dialog box itself) enters at first/last', () => {
    expect(nextTrapIndex(3, -1, false)).toBe(0)
    expect(nextTrapIndex(3, -1, true)).toBe(2)
  })
  test('no focusable elements → -1', () => {
    expect(nextTrapIndex(0, -1, false)).toBe(-1)
  })
})
