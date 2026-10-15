import { describe, expect, test } from 'vitest'
import type { EngineEvent, EventType } from '../../shared/types'
import { nearCount, chipCounts, toggleFilter } from './chips'

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
  test('chipCounts 依類型計算未刪除事件', () => {
    const events = [ev(1, 'knock'), ev(2, 'knock'), ev(3, 'elim'), ev(4, 'assist_elim', { deleted: true })]
    const counts = chipCounts(events)
    expect(counts.knock).toBe(2)
    expect(counts.elim).toBe(1)
    expect(counts.assist_elim).toBe(0)
    expect(counts.squad_wipe).toBe(0)
  })

  test('toggleFilter 切換類型進出篩選集合', () => {
    const base: Set<EventType> = new Set(['knock'])
    const removed = toggleFilter(base, 'knock')
    expect(removed.has('knock')).toBe(false)
    expect(base.has('knock')).toBe(true) // 不變動原集合
    const added = toggleFilter(base, 'elim')
    expect(added.has('elim')).toBe(true)
  })

  test('nearCount 只計入近 90 秒內「計入」的事件（含邊界、排除刪除與不計入）', () => {
    const events = [
      ev(10, 'knock'), // 視窗邊界（100-90）：含
      ev(9.9, 'knock'), // 視窗之前：排除
      ev(50, 'knock'),
      ev(95, 'elim'),
      ev(99, 'squad_wipe', { counted_override: false }), // 不計入：排除
      ev(80, 'elim', { deleted: true }) // 已刪除：排除
    ]
    expect(nearCount(events, 100)).toBe(3)
  })
})
