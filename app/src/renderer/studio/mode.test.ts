import { describe, expect, test } from 'vitest'
import type { ProjectItem } from '../editor/project'
import { createMode, currentItem, isForeign, reconcileMode, reduceMode } from './mode'

const item = (id: string, source: string): ProjectItem => ({ id, source, start: 1, end: 5 })

describe('studio mode reducer', () => {
  test('createMode starts in source mode with the opened video', () => {
    const s = createMode('C:\\v\\a.mp4')
    expect(s.mode).toBe('source')
    expect(s.curItemId).toBeNull()
    expect(s.sourceVideo).toBe('C:\\v\\a.mp4')
  })

  test('playItem switches to project mode and sets curItemId', () => {
    const s0 = createMode('C:\\v\\a.mp4')
    const s1 = reduceMode(s0, { type: 'playItem', item: item('i1', 'C:\\v\\b.mp4') })
    expect(s1.mode).toBe('project')
    expect(s1.curItemId).toBe('i1')
    // 來源影片（開啟的影片）不因片段切換而改變
    expect(s1.sourceVideo).toBe('C:\\v\\a.mp4')
  })

  test('backToSource keeps sourceVideo and clears curItemId', () => {
    let s = reduceMode(createMode('C:\\v\\a.mp4'), { type: 'playItem', item: item('i1', 'C:\\v\\b.mp4') })
    s = reduceMode(s, { type: 'backToSource' })
    expect(s).toEqual({ mode: 'source', curItemId: null, sourceVideo: 'C:\\v\\a.mp4' })
  })

  test('seekSource from project mode returns to source mode', () => {
    let s = reduceMode(createMode('C:\\v\\a.mp4'), { type: 'playItem', item: item('i1', 'C:\\v\\b.mp4') })
    s = reduceMode(s, { type: 'seekSource' })
    expect(s).toEqual({ mode: 'source', curItemId: null, sourceVideo: 'C:\\v\\a.mp4' })
  })

  test('openVideo resets to source mode with the new video', () => {
    let s = reduceMode(createMode('C:\\v\\a.mp4'), { type: 'playItem', item: item('i1', 'C:\\v\\b.mp4') })
    s = reduceMode(s, { type: 'openVideo', path: 'C:\\v\\c.mp4' })
    expect(s).toEqual({ mode: 'source', curItemId: null, sourceVideo: 'C:\\v\\c.mp4' })
  })

  test('backToSource in source mode is a no-op', () => {
    const s0 = createMode('C:\\v\\a.mp4')
    expect(reduceMode(s0, { type: 'backToSource' })).toEqual(s0)
  })

  test('currentItem finds the item of the active project mode', () => {
    const project = { version: 1 as const, name: 'p', items: [item('i1', 'C:\\v\\a.mp4'), item('i2', 'C:\\v\\b.mp4')] }
    const s = reduceMode(createMode('C:\\v\\a.mp4'), { type: 'playItem', item: project.items[1] })
    expect(currentItem(s, project)?.id).toBe('i2')
    expect(currentItem(createMode('C:\\v\\a.mp4'), project)).toBeNull()
  })

  test('isForeign true only when item.source differs from opened video', () => {
    const project = {
      version: 1 as const,
      name: 'p',
      items: [item('i1', 'C:\\v\\a.mp4'), item('i2', 'C:\\v\\b.mp4')]
    }
    // 來源模式：永遠不 foreign
    expect(isForeign(createMode('C:\\v\\a.mp4'), project)).toBe(false)
    // 同來源片段：不 foreign
    let s = reduceMode(createMode('C:\\v\\a.mp4'), { type: 'playItem', item: project.items[0] })
    expect(isForeign(s, project)).toBe(false)
    // 不同來源片段（含路徑大小寫與斜線差異）：foreign
    s = reduceMode(s, { type: 'playItem', item: { ...project.items[1], source: 'c:/V/B.mp4' } })
    expect(isForeign(s, project)).toBe(true)
  })

  test('isForeign false when the current item vanished from the project', () => {
    const project = { version: 1 as const, name: 'p', items: [item('i1', 'C:\\v\\a.mp4')] }
    const s = reduceMode(createMode('C:\\v\\a.mp4'), { type: 'playItem', item: item('gone', 'C:\\v\\b.mp4') })
    expect(isForeign(s, project)).toBe(false)
  })
})

describe('reconcileMode', () => {
  const emptyProject = { version: 1 as const, name: 'p', items: [] }
  test('falls back to source when the previewed item no longer exists (undo)', () => {
    const s = reduceMode(createMode('C:\\v\\a.mp4'), { type: 'playItem', item: item('gone', 'C:\\v\\a.mp4') })
    expect(reconcileMode(s, emptyProject)).toEqual({ mode: 'source', curItemId: null, sourceVideo: 'C:\\v\\a.mp4' })
  })
  test('keeps project mode while the item exists; source stays source', () => {
    const it = item('i1', 'C:\\v\\a.mp4')
    const project = { version: 1 as const, name: 'p', items: [it] }
    const s = reduceMode(createMode('C:\\v\\a.mp4'), { type: 'playItem', item: it })
    expect(reconcileMode(s, project)).toBe(s)
    const src = createMode('C:\\v\\a.mp4')
    expect(reconcileMode(src, project)).toBe(src)
  })
})
