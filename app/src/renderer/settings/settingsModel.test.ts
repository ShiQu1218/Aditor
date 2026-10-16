import { describe, expect, test } from 'vitest'
import { SETTINGS_RANGES } from '../../shared/settings'
import { clampToRange, formatBytes, nextTabIndex, fillTemplate } from './settingsModel'

describe('clampToRange', () => {
  test('clamps to the legal range and rounds to an integer', () => {
    const r = SETTINGS_RANGES.autoclip.gap
    expect(clampToRange(r, 4)).toBe(5)
    expect(clampToRange(r, 61)).toBe(60)
    expect(clampToRange(r, 7.6)).toBe(8)
    expect(clampToRange(r, 5)).toBe(5)
    expect(clampToRange(r, 60)).toBe(60)
  })
  test('non-finite input yields null (nothing should be sent)', () => {
    for (const bad of [NaN, Infinity, -Infinity, '3' as unknown as number, undefined as unknown as number]) {
      expect(clampToRange(SETTINGS_RANGES.before, bad)).toBeNull()
    }
  })
})

describe('nextTabIndex（roving tabindex 的方向鍵）', () => {
  test('arrows move and wrap; Home/End jump; other keys are ignored', () => {
    expect(nextTabIndex('ArrowDown', 0, 3)).toBe(1)
    expect(nextTabIndex('ArrowRight', 1, 3)).toBe(2)
    expect(nextTabIndex('ArrowDown', 2, 3)).toBe(0)
    expect(nextTabIndex('ArrowUp', 0, 3)).toBe(2)
    expect(nextTabIndex('ArrowLeft', 1, 3)).toBe(0)
    expect(nextTabIndex('Home', 2, 3)).toBe(0)
    expect(nextTabIndex('End', 0, 3)).toBe(2)
    expect(nextTabIndex('Enter', 1, 3)).toBeNull()
    expect(nextTabIndex('a', 1, 3)).toBeNull()
  })
})

describe('formatBytes / fillTemplate', () => {
  test('formats sizes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(2.4 * 1024 ** 3)).toBe('2.4 GB')
  })
  test('fills {name} placeholders', () => {
    expect(fillTemplate('{n} 項符合', { n: 3 })).toBe('3 項符合')
  })
})
