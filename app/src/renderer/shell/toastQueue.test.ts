import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createToastQueue, defaultTtl, Toast } from './toastQueue'

const t = (id: string, ttlMs = 3800, action?: Toast['action']): Toast => ({ id, message: id, ttlMs, action })

describe('toastQueue', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('With max=3, the fourth toast drops the oldest', () => {
    const q = createToastQueue(3)
    q.push(t('a')); q.push(t('b')); q.push(t('c'))
    const list = q.push(t('d'))
    expect(list.map((x) => x.id)).toEqual(['b', 'c', 'd'])
  })

  it('defaultTtl is 6000 with an action and 3800 otherwise', () => {
    expect(defaultTtl(true)).toBe(6000)
    expect(defaultTtl(false)).toBe(3800)
  })

  it('Automatically removes expired toasts and notifies subscribers', () => {
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

  it('Paused toasts do not expire; resuming continues the remaining time', () => {
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

  it('dismiss removes a toast; a missing id does not throw', () => {
    const q = createToastQueue()
    q.push(t('a'))
    expect(() => q.dismiss('nope')).not.toThrow()
    expect(() => q.pause('nope')).not.toThrow()
    expect(() => q.resume('nope')).not.toThrow()
    q.dismiss('a')
    expect(q.list()).toHaveLength(0)
    vi.advanceTimersByTime(5000)
  })

  it('The timer for a dropped old toast no longer fires', () => {
    const q = createToastQueue(1)
    q.push(t('a', 1000)); q.push(t('b', 5000))
    vi.advanceTimersByTime(1000)
    expect(q.list().map((x) => x.id)).toEqual(['b'])
  })
})
