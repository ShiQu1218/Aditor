import { describe, it, expect } from 'vitest'
import { toCurrentTime, fromCurrentTime, formatTime, getStartOffset } from './time'

describe('time utilities', () => {
  it('toCurrentTime and fromCurrentTime roundtrip', () => {
    const t = 12.5
    const offset = 5.0
    const ct = toCurrentTime(t, offset)
    expect(ct).toBe(17.5)
    expect(fromCurrentTime(ct, offset)).toBe(12.5)
  })

  it('getStartOffset returns 0.0 for video', () => {
    expect(getStartOffset()).toBe(0.0)
    expect(getStartOffset({ start_time: 5.0 } as any)).toBe(0.0)
  })

  it('fromCurrentTime clamps to 0', () => {
    expect(fromCurrentTime(2.0, 5.0)).toBe(0)
  })

  it('formatTime', () => {
    expect(formatTime(3725)).toBe('1:02:05')
    expect(formatTime(65)).toBe('1:05')
    expect(formatTime(5)).toBe('0:05')
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(3600)).toBe('1:00:00')
  })
})
