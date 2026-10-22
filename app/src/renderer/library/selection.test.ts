import { describe, expect, test } from 'vitest'
import { isAllSelected, pruneSelection, selectAll, toggleGroup, toggleOne } from './selection'

describe('toggleOne', () => {
  test('adds an unselected path and removes a selected one without mutating the input', () => {
    const start = new Set<string>()
    const added = toggleOne(start, 'a.mp4')
    expect([...added]).toEqual(['a.mp4'])
    expect(start.size).toBe(0)

    const removed = toggleOne(added, 'a.mp4')
    expect([...removed]).toEqual([])
    expect(added.size).toBe(1)
  })
})

describe('isAllSelected', () => {
  test('is true only when every path is selected', () => {
    const sel = new Set(['a', 'b'])
    expect(isAllSelected(sel, ['a', 'b'])).toBe(true)
    expect(isAllSelected(sel, ['a', 'b', 'c'])).toBe(false)
    expect(isAllSelected(sel, [])).toBe(false)
  })
})

describe('toggleGroup', () => {
  test('selects the whole group, then deselects it when all are already selected', () => {
    const start = new Set(['outside'])
    const selected = toggleGroup(start, ['a', 'b'])
    expect([...selected].sort()).toEqual(['a', 'b', 'outside'])
    expect(start.size).toBe(1)

    const cleared = toggleGroup(selected, ['a', 'b'])
    expect([...cleared]).toEqual(['outside'])
  })

  test('fills in the missing paths when only part of the group is selected', () => {
    expect([...toggleGroup(new Set(['a']), ['a', 'b'])].sort()).toEqual(['a', 'b'])
  })
})

describe('selectAll', () => {
  test('unions the shown paths with the existing selection', () => {
    const selected = selectAll(new Set(['hidden']), ['a', 'b'])
    expect([...selected].sort()).toEqual(['a', 'b', 'hidden'])
  })
})

describe('pruneSelection', () => {
  test('drops paths that no longer exist and keeps the rest', () => {
    const pruned = pruneSelection(new Set(['a', 'b', 'c']), ['a', 'c'])
    expect([...pruned]).toEqual(['a', 'c'])
  })

  test('returns the same Set instance when every path still exists', () => {
    const sel = new Set(['a', 'b'])
    expect(pruneSelection(sel, ['a', 'b', 'c'])).toBe(sel)
    expect(pruneSelection(new Set(), ['a'])).toEqual(new Set())
  })
})
