import { describe, expect, test } from 'vitest'
import { Project, ProjectItem } from './project'
import { nextAfter, nextPlayableItem } from './sequence'

const item = (id: string, source: string, start: number, end: number): ProjectItem => ({
  id,
  source,
  start,
  end
})

describe('sequence', () => {
  test('nextAfter continues inside item, moves to next at end, ends after last', () => {
    const project: Project = {
      version: 1,
      name: 'p',
      items: [item('a', 'v1.mp4', 0, 10), item('b', 'v1.mp4', 20, 30)]
    }

    expect(nextAfter(project, 'a', 5)).toEqual({ kind: 'continue' })
    expect(nextAfter(project, 'a', 9.999)).toEqual({ kind: 'continue' })

    const atEnd = nextAfter(project, 'a', 10)
    expect(atEnd.kind).toBe('next')
    if (atEnd.kind === 'next') expect(atEnd.item.id).toBe('b')

    const beyond = nextAfter(project, 'a', 12.5)
    expect(beyond.kind).toBe('next')

    expect(nextAfter(project, 'b', 30)).toEqual({ kind: 'end' })
    expect(nextAfter(project, 'b', 100)).toEqual({ kind: 'end' })
    // 片段不存在（例如剛被刪除）→ 結束
    expect(nextAfter(project, 'missing', 5)).toEqual({ kind: 'end' })
  })

  test('nextAfter handles cross-video items (returns next item with different source)', () => {
    const project: Project = {
      version: 1,
      name: 'p',
      items: [item('a', 'C:\\rec\\v1.mp4', 0, 10), item('b', 'D:\\rec\\v2.mp4', 0, 12)]
    }
    expect(nextAfter(project, 'a', 10)).toEqual({ kind: 'next', item: project.items[1] })
    const r = nextAfter(project, 'a', 10)
    if (r.kind === 'next') {
      expect(r.item.id).toBe('b')
      expect(r.item.source).not.toBe(project.items[0].source)
    }
    // 不同來源的下一段播完 → 專案結束
    expect(nextAfter(project, 'b', 12)).toEqual({ kind: 'end' })
  })
})

describe('nextPlayableItem', () => {
  const project: Project = {
    version: 1,
    name: 'p',
    items: [item('a', 'v1.mp4', 0, 10), item('b', 'gone.mp4', 0, 5), item('c', 'v2.mp4', 3, 9), item('d', 'v1.mp4', 20, 30)]
  }
  test('returns the immediately following item when nothing is missing', () => {
    expect(nextPlayableItem(project, 'a', new Set())).toEqual({ kind: 'item', item: project.items[1] })
  })
  test('skips missing sources and crosses videos', () => {
    expect(nextPlayableItem(project, 'a', new Set(['b']))).toEqual({ kind: 'item', item: project.items[2] })
  })
  test('all remaining missing → allMissing', () => {
    expect(nextPlayableItem(project, 'a', new Set(['b', 'c', 'd']))).toEqual({ kind: 'allMissing' })
  })
  test('last item (or unknown id) → end', () => {
    expect(nextPlayableItem(project, 'd', new Set())).toEqual({ kind: 'end' })
    expect(nextPlayableItem(project, 'zzz', new Set())).toEqual({ kind: 'end' })
  })
  test('nextAfter skips missing items and reports allMissing', () => {
    expect(nextAfter(project, 'a', 10, new Set(['b']))).toEqual({ kind: 'next', item: project.items[2] })
    expect(nextAfter(project, 'c', 9, new Set(['d']))).toEqual({ kind: 'allMissing' })
    expect(nextAfter(project, 'a', 5, new Set(['b']))).toEqual({ kind: 'continue' })
  })
})
