import { describe, it, expect } from 'vitest'
import {
  Project,
  ProjectItem,
  createProject,
  addItems,
  removeItem,
  splitItem,
  duplicateItem,
  moveItem,
  trimItem,
  totalDuration
} from './project'

describe('project pure functions', () => {
  const baseProject: Project = {
    version: 1,
    name: 'Test Project',
    items: [
      { id: 'item1', source: 'v1.mp4', start: 10, end: 20 },
      { id: 'item2', source: 'v2.mp4', start: 5, end: 15 }
    ]
  }

  it('totalDuration calculates sum of all items duration', () => {
    expect(totalDuration(baseProject)).toBe(20) // (20-10) + (15-5) = 20
  })

  it('addItems appends items with generated ids if not provided', () => {
    const updated = addItems(baseProject, [{ source: 'v3.mp4', start: 0, end: 5 }])
    expect(updated.items).toHaveLength(3)
    expect(updated.items[2].id).toBeDefined()
    expect(updated.items[2].source).toBe('v3.mp4')
  })

  it('removeItem removes item by id', () => {
    const updated = removeItem(baseProject, 'item1')
    expect(updated.items).toHaveLength(1)
    expect(updated.items[0].id).toBe('item2')
  })

  it('splitItem produces two segments with unchanged total duration', () => {
    const updated = splitItem(baseProject, 'item1', 14)
    expect(updated.items).toHaveLength(3)
    expect(updated.items[0]).toEqual({ id: 'item1', source: 'v1.mp4', start: 10, end: 14 })
    expect(updated.items[1].source).toBe('v1.mp4')
    expect(updated.items[1].start).toBe(14)
    expect(updated.items[1].end).toBe(20)
    expect(updated.items[1].id).not.toBe('item1')
    expect(updated.items[2].id).toBe('item2')
    expect(totalDuration(updated)).toBe(totalDuration(baseProject))
  })

  it('splitItem outside range is no-op', () => {
    const updatedBefore = splitItem(baseProject, 'item1', 9)
    expect(updatedBefore).toBe(baseProject)
    const updatedAfter = splitItem(baseProject, 'item1', 21)
    expect(updatedAfter).toBe(baseProject)
    const updatedEdge = splitItem(baseProject, 'item1', 10)
    expect(updatedEdge).toBe(baseProject)
  })

  it('duplicateItem clones item with new id right after original', () => {
    const updated = duplicateItem(baseProject, 'item1')
    expect(updated.items).toHaveLength(3)
    expect(updated.items[0].id).toBe('item1')
    expect(updated.items[1].id).not.toBe('item1')
    expect(updated.items[1].source).toBe('v1.mp4')
    expect(updated.items[1].start).toBe(10)
    expect(updated.items[1].end).toBe(20)
    expect(updated.items[2].id).toBe('item2')
  })

  it('moveItem reorders item to new index', () => {
    const p3: Project = {
      version: 1,
      name: 'P3',
      items: [
        { id: '1', source: 's', start: 0, end: 1 },
        { id: '2', source: 's', start: 1, end: 2 },
        { id: '3', source: 's', start: 2, end: 3 }
      ]
    }
    const moved = moveItem(p3, '1', 2)
    expect(moved.items.map((i) => i.id)).toEqual(['2', '3', '1'])
  })

  it('trimItem clamps to min duration and source bounds', () => {
    // Trimming start
    const trimmedStart = trimItem(baseProject, 'item1', 'start', 12, 100)
    expect(trimmedStart.items[0].start).toBe(12)

    // Cannot trim start past end - 0.1
    const clampedStart = trimItem(baseProject, 'item1', 'start', 25, 100)
    expect(clampedStart.items[0].start).toBe(19.9)

    // Trimming end
    const trimmedEnd = trimItem(baseProject, 'item1', 'end', 18, 100)
    expect(trimmedEnd.items[0].end).toBe(18)

    // Cannot trim end before start + 0.1
    const clampedEnd = trimItem(baseProject, 'item1', 'end', 5, 100)
    expect(clampedEnd.items[0].end).toBe(10.1)

    // Cannot exceed sourceDuration
    const exceededEnd = trimItem(baseProject, 'item1', 'end', 120, 100)
    expect(exceededEnd.items[0].end).toBe(100)
  })
})
