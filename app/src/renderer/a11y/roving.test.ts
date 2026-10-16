import { describe, expect, test } from 'vitest'
import { gridStep, rovingStep } from './roving'

describe('rovingStep (grid, 4 columns, 10 items)', () => {
  const base = { count: 10, columns: 4 }
  test('left/right move by one and stop at the ends', () => {
    expect(rovingStep({ ...base, index: 3, key: 'ArrowRight' })).toBe(4)
    expect(rovingStep({ ...base, index: 4, key: 'ArrowLeft' })).toBe(3)
    expect(rovingStep({ ...base, index: 0, key: 'ArrowLeft' })).toBeNull()
    expect(rovingStep({ ...base, index: 9, key: 'ArrowRight' })).toBeNull()
  })
  test('up/down move by a whole row', () => {
    expect(rovingStep({ ...base, index: 1, key: 'ArrowDown' })).toBe(5)
    expect(rovingStep({ ...base, index: 5, key: 'ArrowUp' })).toBe(1)
    expect(rovingStep({ ...base, index: 1, key: 'ArrowUp' })).toBeNull()
  })
  test('down into a shorter last row lands on the last item; from the last row it stops', () => {
    expect(rovingStep({ ...base, index: 3, key: 'ArrowDown' })).toBe(7)
    expect(rovingStep({ ...base, index: 7, key: 'ArrowDown' })).toBe(9)
    expect(rovingStep({ ...base, index: 9, key: 'ArrowDown' })).toBeNull()
    expect(rovingStep({ ...base, index: 8, key: 'ArrowDown' })).toBeNull()
  })
  test('Home/End jump to the first/last item (null when already there)', () => {
    expect(rovingStep({ ...base, index: 6, key: 'Home' })).toBe(0)
    expect(rovingStep({ ...base, index: 6, key: 'End' })).toBe(9)
    expect(rovingStep({ ...base, index: 0, key: 'Home' })).toBeNull()
    expect(rovingStep({ ...base, index: 9, key: 'End' })).toBeNull()
  })
  test('other keys, empty lists and out-of-range indexes', () => {
    expect(rovingStep({ ...base, index: 2, key: 'a' })).toBeNull()
    expect(rovingStep({ ...base, index: 2, key: 'Tab' })).toBeNull()
    expect(rovingStep({ count: 0, index: -1, key: 'ArrowDown', columns: 4 })).toBeNull()
    expect(rovingStep({ ...base, index: -1, key: 'ArrowRight' })).toBe(0)
    expect(rovingStep({ ...base, index: -1, key: 'End' })).toBe(9)
    expect(rovingStep({ ...base, index: 99, key: 'ArrowLeft' })).toBe(8)
  })
  test('columns below 1 are treated as 1', () => {
    expect(rovingStep({ count: 3, index: 0, key: 'ArrowDown', columns: 0 })).toBe(1)
  })
})

describe('rovingStep orientation', () => {
  test('vertical lists only react to up/down (and Home/End)', () => {
    const p = { count: 5, columns: 1, orientation: 'vertical' as const }
    expect(rovingStep({ ...p, index: 1, key: 'ArrowDown' })).toBe(2)
    expect(rovingStep({ ...p, index: 1, key: 'ArrowUp' })).toBe(0)
    expect(rovingStep({ ...p, index: 1, key: 'ArrowRight' })).toBeNull()
    expect(rovingStep({ ...p, index: 1, key: 'End' })).toBe(4)
  })
  test('horizontal lists only react to left/right (and Home/End)', () => {
    const p = { count: 5, columns: 1, orientation: 'horizontal' as const }
    expect(rovingStep({ ...p, index: 1, key: 'ArrowRight' })).toBe(2)
    expect(rovingStep({ ...p, index: 1, key: 'ArrowDown' })).toBeNull()
    expect(rovingStep({ ...p, index: 4, key: 'Home' })).toBe(0)
  })
})

describe('gridStep (date groups of 5 and 3 items, 4 columns)', () => {
  const groups = [5, 3]
  const step = (group: number, index: number, key: string) => gridStep({ groups, group, index, key, columns: 4 })
  test('moves inside a group like rovingStep', () => {
    expect(step(0, 0, 'ArrowRight')).toEqual({ group: 0, index: 1 })
    expect(step(0, 0, 'ArrowDown')).toEqual({ group: 0, index: 4 })
  })
  test('left/right cross the group boundary', () => {
    expect(step(0, 4, 'ArrowRight')).toEqual({ group: 1, index: 0 })
    expect(step(1, 0, 'ArrowLeft')).toEqual({ group: 0, index: 4 })
    expect(step(0, 0, 'ArrowLeft')).toBeNull()
    expect(step(1, 2, 'ArrowRight')).toBeNull()
  })
  test('down from the last row enters the next group in the same column (clamped)', () => {
    expect(step(0, 4, 'ArrowDown')).toEqual({ group: 1, index: 0 })
    expect(step(0, 3, 'ArrowDown')).toEqual({ group: 0, index: 4 }) // still inside group 0 (row 2 has one item)
    expect(step(0, 4, 'ArrowDown')).toEqual({ group: 1, index: 0 })
    expect(step(1, 2, 'ArrowDown')).toBeNull()
  })
  test('up from the first row enters the previous group last row in the same column (clamped)', () => {
    expect(step(1, 2, 'ArrowUp')).toEqual({ group: 0, index: 4 }) // column 2 of last row (1 item) -> clamp
    expect(step(1, 0, 'ArrowUp')).toEqual({ group: 0, index: 4 })
    expect(step(0, 2, 'ArrowUp')).toBeNull()
  })
  test('empty groups are skipped; Home/End are global', () => {
    const g = [2, 0, 3]
    expect(gridStep({ groups: g, group: 0, index: 1, key: 'ArrowRight', columns: 4 })).toEqual({ group: 2, index: 0 })
    expect(gridStep({ groups: g, group: 2, index: 1, key: 'Home', columns: 4 })).toEqual({ group: 0, index: 0 })
    expect(gridStep({ groups: g, group: 0, index: 0, key: 'End', columns: 4 })).toEqual({ group: 2, index: 2 })
  })
})
