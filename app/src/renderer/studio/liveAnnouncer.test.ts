import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createAnnouncer } from './liveAnnouncer'

describe('createAnnouncer (rate-limited polite live region)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('first message is immediate; a burst collapses to the latest one after the gap', () => {
    const out: string[] = []
    const a = createAnnouncer((m) => out.push(m), 500)
    a.announce('1')
    a.announce('2')
    a.announce('3')
    expect(out).toEqual(['1'])
    vi.advanceTimersByTime(499)
    expect(out).toEqual(['1'])
    vi.advanceTimersByTime(2)
    expect(out).toEqual(['1', '3'])
  })

  test('after the gap has passed a new message is immediate again', () => {
    const out: string[] = []
    const a = createAnnouncer((m) => out.push(m), 500)
    a.announce('1')
    vi.advanceTimersByTime(600)
    a.announce('2')
    expect(out).toEqual(['1', '2'])
  })

  test('dispose cancels the pending message', () => {
    const out: string[] = []
    const a = createAnnouncer((m) => out.push(m), 500)
    a.announce('1')
    a.announce('2')
    a.dispose()
    vi.advanceTimersByTime(1000)
    expect(out).toEqual(['1'])
  })
})
