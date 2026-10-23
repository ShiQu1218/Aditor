import { describe, expect, test } from 'vitest'
import type { EngineEvent, EventType } from '../../shared/types'
import { CHIP_TYPES, nearCount, chipCounts, toggleFilter } from './chips'

function ev(t: number, type: EventType, extra: Partial<EngineEvent> = {}): EngineEvent {
  return {
    id: `${type}_${t}`,
    t,
    type,
    score: 0.9,
    damage_line: false,
    name_sig: null,
    counted: true,
    counted_reason: 'first',
    counted_override: null,
    source: 'auto',
    ...extra
  }
}

describe('studio filter chips', () => {
  test('Chips include only kills and assists (the engine no longer produces elim/squad_wipe)', () => {
    expect(CHIP_TYPES).toEqual(['knock', 'kill', 'assist_knock', 'assist_elim'])
  })

  test('chipCounts counts undeleted events by type', () => {
    const events = [ev(1, 'knock'), ev(2, 'knock'), ev(3, 'elim'), ev(4, 'assist_elim', { deleted: true })]
    const counts = chipCounts(events)
    expect(counts.knock).toBe(2)
    expect(counts.elim).toBe(1)
    expect(counts.assist_elim).toBe(0)
    expect(counts.squad_wipe).toBe(0)
  })

  test('toggleFilter adds or removes a type from the filter set', () => {
    const base: Set<EventType> = new Set(['knock'])
    const removed = toggleFilter(base, 'knock')
    expect(removed.has('knock')).toBe(false)
    expect(base.has('knock')).toBe(true) // Original set is unchanged.
    const added = toggleFilter(base, 'elim')
    expect(added.has('elim')).toBe(true)
  })

  test('nearCount counts only counted events from the last 90 seconds (including boundary; excluding deleted and uncounted events)', () => {
    const events = [
      ev(10, 'knock'), // At the window boundary (100-90): included.
      ev(9.9, 'knock'), // Before the window: excluded.
      ev(50, 'knock'),
      ev(95, 'elim'),
      ev(99, 'squad_wipe', { counted_override: false }), // Not counted: excluded.
      ev(80, 'elim', { deleted: true }) // Deleted: excluded.
    ]
    expect(nearCount(events, 100)).toBe(3)
  })
})
