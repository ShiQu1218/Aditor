import { describe, expect, test, vi } from 'vitest'
import { createRefreshGate, missingItemIds, newProjectId, restoreLastProject, validateSources } from './projectIo'
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

describe('validateSources concurrency and timeout', () => {
  const many = (n: number) =>
    createProject(
      'P',
      Array.from({ length: n }, (_, i) => ({ id: `i${i}`, source: `C:/v/${i}.mp4`, start: 0, end: 1 }))
    )

  test('checks concurrently but never above the limit, keeps source order', async () => {
    let active = 0
    let peak = 0
    const { missing } = await validateSources(
      many(10),
      async (s) => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 5))
        active--
        return Number(s.match(/(\d+)\.mp4/)![1]) % 2 === 0
      },
      { concurrency: 3 }
    )
    expect(peak).toBe(3)
    expect(missing).toEqual(['C:/v/1.mp4', 'C:/v/3.mp4', 'C:/v/5.mp4', 'C:/v/7.mp4', 'C:/v/9.mp4'])
  })

  test('a hanging check times out and counts as missing without blocking the rest', async () => {
    const started = Date.now()
    const { missing } = await validateSources(
      many(5),
      (s) => (s.endsWith('2.mp4') ? new Promise<boolean>(() => {}) : Promise.resolve(true)),
      { concurrency: 2, timeoutMs: 30 }
    )
    expect(missing).toEqual(['C:/v/2.mp4'])
    expect(Date.now() - started).toBeLessThan(1000)
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

describe('createRefreshGate', () => {
  test('allows the first call, then throttles within minMs, then allows again', () => {
    let now = 10_000
    const gate = createRefreshGate(2000, () => now)
    expect(gate()).toBe(true)
    now += 500
    expect(gate()).toBe(false)
    now += 1600
    expect(gate()).toBe(true)
  })
})
