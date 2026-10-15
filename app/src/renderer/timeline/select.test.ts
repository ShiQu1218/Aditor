import { describe, expect, test } from 'vitest'
import type { EngineEvent, EventType } from '../../shared/types'
import type { LayoutItem } from './layout'
import { boxSelect, hitDensity, hitItem } from './select'

const ALL = new Set<EventType>(['knock', 'elim'])
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

describe('boxSelect', () => {
  const events = [
    ev('a', 10),
    ev('b', 20),
    ev('c', 30, { deleted: true }),
    ev('d', 40, { type: 'assist_elim' }),
    ev('e', 50)
  ]
  test('boxSelect inclusive bounds, swaps reversed range, ignores deleted/filtered', () => {
    expect(boxSelect(events, 10, 50, ALL)).toEqual(['a', 'b', 'e'])
    expect(boxSelect(events, 50, 20, ALL)).toEqual(['b', 'e'])
    expect(boxSelect(events, 21, 29, ALL)).toEqual([])
  })
})

describe('hit testing', () => {
  const mk = (x: number, id: string): LayoutItem => ({ x, events: [ev(id, x)], counted: true })
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
