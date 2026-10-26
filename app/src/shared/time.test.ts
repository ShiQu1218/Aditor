import { describe, it, expect } from 'vitest'
import { formatTime } from './time'

describe('time utilities', () => {
  it('formatTime', () => {
    expect(formatTime(3725)).toBe('1:02:05')
    expect(formatTime(65)).toBe('1:05')
    expect(formatTime(5)).toBe('0:05')
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(3600)).toBe('1:00:00')
  })
})
