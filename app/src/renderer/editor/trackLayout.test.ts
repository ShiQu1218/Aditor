import { describe, expect, test } from 'vitest'
import { dropIndex, itemWidth, trimFromDrag, trimUpperBound } from './trackLayout'

describe('trackLayout', () => {
  test('itemWidth clamps to [92,360] at 6px/s', () => {
    expect(itemWidth(5)).toBe(92) // 30px → minimum 92
    expect(itemWidth(10)).toBe(92) // 60px → minimum 92
    expect(itemWidth(20)).toBe(120) // 6px/second
    expect(itemWidth(60)).toBe(360) // Maximum 360
    expect(itemWidth(120)).toBe(360)
    expect(itemWidth(0)).toBe(92)
  })

  test('dropIndex picks insertion index by midpoint', () => {
    const xs = [0, 100, 200]
    const widths = [100, 100, 100]
    expect(dropIndex(xs, widths, -50)).toBe(0) // Far left → insert at the start
    expect(dropIndex(xs, widths, 40)).toBe(0) // Left of card 0's midpoint (50)
    expect(dropIndex(xs, widths, 60)).toBe(1) // Right of card 0's midpoint → between cards 0 and 1
    expect(dropIndex(xs, widths, 150)).toBe(2) // Right of card 1's midpoint → between cards 1 and 2
    expect(dropIndex(xs, widths, 260)).toBe(3) // Right of the last card's midpoint → insert at the end
    expect(dropIndex([], [], 10)).toBe(0)
  })

  test('trimFromDrag respects min length 1s and video bounds', () => {
    const item = { start: 10, end: 20 }

    // Dragging the start past the end clamps it to end - 1 (minimum 1 second).
    expect(trimFromDrag(item, 'start', 100 * 6, 6, 30)).toEqual({ start: 19, end: 20 })
    // Dragging the start past the beginning clamps it to 0.
    expect(trimFromDrag(item, 'start', -100 * 6, 6, 30)).toEqual({ start: 0, end: 20 })
    // Dragging the end before the start clamps it to start + 1 (minimum 1 second).
    expect(trimFromDrag(item, 'end', -100 * 6, 6, 30)).toEqual({ start: 10, end: 11 })
    // Dragging the end past the video duration clamps it to duration.
    expect(trimFromDrag(item, 'end', 100 * 6, 6, 30)).toEqual({ start: 10, end: 30 })

    // Small drag: dx / pxPerSec gives the time delta (12px ÷ 6px/s = +2s).
    expect(trimFromDrag(item, 'end', 12, 6, 30)).toEqual({ start: 10, end: 22 })
    expect(trimFromDrag(item, 'start', -6, 6, 30)).toEqual({ start: 9, end: 20 })

    // The source object is not modified.
    expect(item).toEqual({ start: 10, end: 20 })
  })
})

describe('trim of foreign-source items', () => {
  const open = 'C:\\v\\a.mp4'
  test('upper bound: open video uses its duration (path case/separator-insensitive), foreign is unbounded', () => {
    expect(trimUpperBound('c:/V/A.mp4', open, 100)).toBe(100)
    expect(trimUpperBound('D:/other.mp4', open, 100)).toBe(Infinity)
    expect(trimUpperBound(open, open, 0)).toBe(Infinity)
  })
  test('foreign item longer than the open video: end stays where dragged', () => {
    const item = { start: 10, end: 400 }
    const ub = trimUpperBound('D:/other.mp4', open, 100)
    expect(trimFromDrag(item, 'end', 60, 6, ub)).toEqual({ start: 10, end: 410 })
    expect(trimFromDrag(item, 'end', -60, 6, ub)).toEqual({ start: 10, end: 390 })
  })
  test('foreign item: min length 1 s still enforced', () => {
    const item = { start: 200, end: 400 }
    const ub = trimUpperBound('D:/other.mp4', open, 100)
    expect(trimFromDrag(item, 'end', -100000, 6, ub)).toEqual({ start: 200, end: 201 })
    expect(trimFromDrag(item, 'start', 100000, 6, ub)).toEqual({ start: 399, end: 400 })
  })
})
