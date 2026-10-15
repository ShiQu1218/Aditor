import { describe, expect, test, vi } from 'vitest'
import { missingItemIds, newProjectId, restoreLastProject, validateSources } from './projectIo'
import { createProject } from './project'

describe('restoreLastProject', () => {
  test('restore last project on start', async () => {
    const stored = createProject('已存專案', [{ id: 'i', source: 'C:/v/a.mp4', start: 1, end: 2 }])
    const api = {
      getSettings: vi.fn(async () => ({ lastProjectId: 'p_1' })),
      loadProject: vi.fn(async () => stored)
    }
    const restored = await restoreLastProject(api)
    expect(restored).toEqual({ ...stored, id: 'p_1' })
    expect(api.loadProject).toHaveBeenCalledWith('p_1')
  })

  test('falls back to null when the setting is missing, the load fails, or the file is corrupt', async () => {
    // 沒有 lastProjectId
    expect(
      await restoreLastProject({ getSettings: async () => ({ lastProjectId: null }), loadProject: vi.fn() })
    ).toBeNull()
    // 檔案不存在／損毀（load 回 null）
    expect(
      await restoreLastProject({ getSettings: async () => ({ lastProjectId: 'p_x' }), loadProject: async () => null })
    ).toBeNull()
    // 設定讀取失敗
    expect(
      await restoreLastProject({
        getSettings: async () => {
          throw new Error('boom')
        },
        loadProject: vi.fn()
      })
    ).toBeNull()
  })
})

describe('validateSources', () => {
  test('returns deduped missing sources in order', async () => {
    const project = createProject('P', [
      { id: 'a', source: 'C:/v/a.mp4', start: 0, end: 1 },
      { id: 'b', source: 'C:/v/b.mp4', start: 0, end: 1 },
      { id: 'c', source: 'C:/v/a.mp4', start: 5, end: 6 }
    ])
    const { missing } = await validateSources(project, async (s) => s !== 'C:/v/b.mp4')
    expect(missing).toEqual(['C:/v/b.mp4'])
  })

  test('treats a rejected exists check as missing', async () => {
    const project = createProject('P', [{ id: 'a', source: 'C:/v/a.mp4', start: 0, end: 1 }])
    const { missing } = await validateSources(project, async () => {
      throw new Error('IPC down')
    })
    expect(missing).toEqual(['C:/v/a.mp4'])
  })
})

describe('newProjectId', () => {
  test('is path-safe and unique', () => {
    const a = newProjectId()
    const b = newProjectId()
    expect(a).toMatch(/^p_[A-Za-z0-9_-]+$/)
    expect(a).not.toBe(b)
  })
})

describe('missingItemIds', () => {
  const project = createProject('P', [
    { id: 'a', source: 'C:\\v\\a.mp4', start: 0, end: 1 },
    { id: 'b', source: 'C:/v/B.mp4', start: 0, end: 1 },
    { id: 'c', source: 'C:/v/a.mp4', start: 5, end: 6 }
  ])

  test('flags every item whose source is missing (case/slash-insensitive)', () => {
    const ids = missingItemIds(project, ['c:/v/a.mp4'])
    expect([...ids].sort()).toEqual(['a', 'c'])
  })

  test('empty missing list flags nothing; does not mutate project', () => {
    const before = JSON.stringify(project)
    expect(missingItemIds(project, []).size).toBe(0)
    missingItemIds(project, ['C:/v/B.mp4'])
    expect(JSON.stringify(project)).toBe(before)
  })
})
