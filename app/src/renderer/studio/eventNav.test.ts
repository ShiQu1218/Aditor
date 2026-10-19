import { describe, expect, test } from 'vitest'
import { navReference } from './eventNav'
import { nextEvent } from '../timeline/model'
import type { EngineEvent, EventType } from '../../shared/types'

const ev = (id: string, t: number): EngineEvent => ({
  id, t, type: 'knock', score: 1, damage_line: false, name_sig: null, counted: true, counted_reason: 'first', counted_override: null, source: 'auto'
})
const ALL = new Set<EventType>(['knock'])

describe('navReference', () => {
  test('no anchor or the playhead moved away -> the playhead time', () => {
    expect(navReference(52, null)).toBe(52)
    expect(navReference(70, { eventT: 60, seekT: 52 })).toBe(70)
  })
  test('playhead still at the lead-in position -> the event time', () => {
    expect(navReference(52, { eventT: 60, seekT: 52 })).toBe(60)
    expect(navReference(52.2, { eventT: 60, seekT: 52 })).toBe(60)
  })
  test('repeated "next" walks forward instead of sticking on the same event', () => {
    const events = [ev('a', 60), ev('b', 120), ev('c', 130)]
    let current = 0
    let anchor: { eventT: number; seekT: number } | null = null
    const seen: string[] = []
    for (let i = 0; i < 3; i++) {
      const e: EngineEvent = nextEvent(events, navReference(current, anchor), 1, ALL)!
      seen.push(e.id)
      current = Math.max(0, e.t - 8)
      anchor = { eventT: e.t, seekT: current }
    }
    expect(seen).toEqual(['a', 'b', 'c'])
  })
  test('"previous" from a lead-in position sees an event inside the lead-in window', () => {
    const events = [ev('a', 60), ev('b', 125), ev('c', 130)]
  // Currently in c's lead-in (122); b (125) is within the lead-in interval, so navigate to b instead of skipping it.
    const prev = nextEvent(events, navReference(122, { eventT: 130, seekT: 122 }), -1, ALL)!
    expect(prev.id).toBe('b')
  })
})
