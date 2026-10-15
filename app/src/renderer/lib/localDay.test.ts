import { describe, expect, test } from 'vitest'
import { msUntilNextLocalMidnight } from './localDay'

describe('msUntilNextLocalMidnight', () => {
  test('is the distance to the next LOCAL midnight', () => {
    expect(msUntilNextLocalMidnight(new Date(2026, 9, 16, 23, 0, 0).getTime())).toBe(3_600_000)
    expect(msUntilNextLocalMidnight(new Date(2026, 9, 16, 0, 0, 0).getTime())).toBe(86_400_000)
  })
  test('never returns 0 or negative', () => {
    expect(msUntilNextLocalMidnight(new Date(2026, 9, 16, 23, 59, 59, 999).getTime())).toBe(1)
  })
})
