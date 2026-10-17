import { describe, expect, test } from 'vitest'
import type { EngineEvent } from '../../shared/types'
import type { LayoutItem } from './layout'
import { hitDensity, hitItem } from './select'

const ev = (id: string, t: number, over: Partial<EngineEvent> = {}): EngineEvent => ({
  id,
  t,
  type: 'knock',
  score: 0.9,
  damage_line: false,
  name_sig: null,
  counted: true,
  counted_reason: 'first',
  counted_override: null,
  source: 'auto',
  ...over
})

describe('hit testing', () => {
  const mk = (x: number, id: string): LayoutItem => ({ x, events: [ev(id, x)], counted: true, countedCount: 1 })
  const items = [mk(100, 'a'), mk(110, 'b'), mk(300, 'c')]
  test('hitItem returns the nearest within tolerance', () => {
    expect(hitItem(items, 108)?.events[0].id).toBe('b')
    expect(hitItem(items, 200)).toBeNull()
    expect(hitItem(items, 312)?.events[0].id).toBe('c')
    expect(hitItem(items, 314)).toBeNull()
  })
  test('hitDensity returns all events near x', () => {
    expect(hitDensity(items, 105).map((e) => e.id)).toEqual(['a', 'b'])
    expect(hitDensity(items, 200)).toEqual([])
  })
})
