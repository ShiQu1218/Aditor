import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createToastQueue, defaultTtl, Toast } from './toastQueue'

const t = (id: string, ttlMs = 3800, action?: Toast['action']): Toast => ({ id, message: id, ttlMs, action })

describe('toastQueue', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('max=3 時第 4 則丟掉最舊', () => {
    const q = createToastQueue(3)
    q.push(t('a')); q.push(t('b')); q.push(t('c'))
    const list = q.push(t('d'))
    expect(list.map((x) => x.id)).toEqual(['b', 'c', 'd'])
  })

  it('defaultTtl：含 action 6000、否則 3800', () => {
    expect(defaultTtl(true)).toBe(6000)
    expect(defaultTtl(false)).toBe(3800)
  })

  it('到期後自動移除並通知訂閱者', () => {
    const q = createToastQueue()
    const seen: string[][] = []
    q.subscribe((l) => seen.push(l.map((x) => x.id)))
    q.push(t('a', 1000))
    vi.advanceTimersByTime(999)
    expect(q.list()).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(q.list()).toHaveLength(0)
    expect(seen[seen.length - 1]).toEqual([])
  })

  it('pause 後不過期、resume 後剩餘時間續算', () => {
    const q = createToastQueue()
    q.push(t('a', 1000))
    vi.advanceTimersByTime(400)
    q.pause('a')
    vi.advanceTimersByTime(10_000)
    expect(q.list()).toHaveLength(1)
    q.resume('a')
    vi.advanceTimersByTime(599)
    expect(q.list()).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(q.list()).toHaveLength(0)
  })

  it('dismiss 移除；不存在的 id 不丟錯', () => {
    const q = createToastQueue()
    q.push(t('a'))
    expect(() => q.dismiss('nope')).not.toThrow()
    expect(() => q.pause('nope')).not.toThrow()
    expect(() => q.resume('nope')).not.toThrow()
    q.dismiss('a')
    expect(q.list()).toHaveLength(0)
    vi.advanceTimersByTime(5000)
  })

  it('被丟掉的舊 toast 計時器不再觸發', () => {
    const q = createToastQueue(1)
    q.push(t('a', 1000)); q.push(t('b', 5000))
    vi.advanceTimersByTime(1000)
    expect(q.list().map((x) => x.id)).toEqual(['b'])
  })
})
