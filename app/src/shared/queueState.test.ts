import { describe, expect, test } from 'vitest'
import { queueItemState, summarizeQueue, type QueuePayload } from './queueState'

const payload = (over: Partial<QueuePayload> = {}): QueuePayload => ({
  queue: { analyzing: 'D:\\v\\a.mp4', queued: ['D:\\v\\b.mp4', 'D:\\v\\c.mp4'] },
  current: { path: 'D:\\v\\a.mp4', progress: 0.5, analyzingSince: 1_000_000 },
  ...over
})

describe('summarizeQueue (pure)', () => {
  test('nothing analyzing / queued => empty summary (strip hides, never "0/N")', () => {
    for (const p of [null, undefined, { queue: { analyzing: null, queued: [] }, current: null }]) {
      const s = summarizeQueue(p, 1_100_000)
      expect(s.total).toBe(0)
      expect(s.rows).toEqual([])
      expect(s.analyzing).toBeNull()
      expect(s.progress).toBe(0)
    }
  })

  test('analyzing first then queued in order; total counts both; index/total drive "i/n"', () => {
    const s = summarizeQueue(payload(), 1_060_000)
    expect(s.rows.map((r) => [r.path, r.state])).toEqual([
      ['D:\\v\\a.mp4', 'analyzing'],
      ['D:\\v\\b.mp4', 'queued'],
      ['D:\\v\\c.mp4', 'queued']
    ])
    expect(s.total).toBe(3)
    expect(s.analyzing?.path).toBe('D:\\v\\a.mp4')
    expect(s.progress).toBe(0.5)
  })

  test('ETA uses now - analyzingSince; null while elapsed < 3 s or progress < 2%', () => {
    // 60 秒前開始、50% → 再 60 秒
    expect(summarizeQueue(payload(), 1_060_000).analyzing?.etaMs).toBeCloseTo(60000)
    // 剛開始 1 秒
    expect(summarizeQueue(payload(), 1_001_000).analyzing?.etaMs).toBeNull()
    // 進度 < 2%
    const low = payload({ current: { path: 'D:\\v\\a.mp4', progress: 0.01, analyzingSince: 1_000_000 } })
    expect(summarizeQueue(low, 1_060_000).analyzing?.etaMs).toBeNull()
    // 沒有 analyzingSince
    const none = payload({ current: { path: 'D:\\v\\a.mp4', progress: 0.5, analyzingSince: null } })
    expect(summarizeQueue(none, 1_060_000).analyzing?.etaMs).toBeNull()
    // queued 項目沒有 ETA
    expect(summarizeQueue(payload(), 1_060_000).rows[1].etaMs).toBeNull()
  })

  test('queued but nothing analyzing (transient) still counts; queued rows have progress 0', () => {
    const s = summarizeQueue({ queue: { analyzing: null, queued: ['x.mp4'] }, current: null }, 5)
    expect(s.total).toBe(1)
    expect(s.analyzing).toBeNull()
    expect(s.rows[0]).toMatchObject({ path: 'x.mp4', state: 'queued', progress: 0 })
  })

  test('progress is clamped to 0..1', () => {
    const s = summarizeQueue(payload({ current: { path: 'D:\\v\\a.mp4', progress: 7, analyzingSince: 1 } }), 99_999_999)
    expect(s.progress).toBe(1)
  })
})

describe('queueItemState — per-card label comes from the real queue, never from status === "pending"', () => {
  test('analyzing / queued / idle (imported but not queued, or cancelled)', () => {
    const s = summarizeQueue(payload(), 1_060_000)
    expect(queueItemState(s, 'D:\\v\\a.mp4')).toBe('analyzing')
    expect(queueItemState(s, 'D:\\v\\b.mp4')).toBe('queued')
    expect(queueItemState(s, 'd:/v/B.MP4')).toBe('queued') // 路徑拼法不同
    expect(queueItemState(s, 'D:\\v\\never-queued.mp4')).toBe('idle')
    expect(queueItemState(summarizeQueue(null, 0), 'D:\\v\\a.mp4')).toBe('idle')
  })
})
