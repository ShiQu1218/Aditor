import { describe, expect, test } from 'vitest'
import type { EngineEvent } from '../../shared/types'
import { eventAriaLabel, eventReason } from './reasons'

function ev(over: Partial<EngineEvent> = {}): EngineEvent {
  return {
    id: 'e1',
    t: 332,
    type: 'knock',
    score: 0.93,
    damage_line: true,
    name_sig: null,
    counted: true,
    counted_reason: 'first',
    counted_override: null,
    source: 'auto',
    ...over
  }
}

describe('eventReason', () => {
  test('eventReason covers every counted_reason plus override states', () => {
    expect(eventReason(ev())).toBe('首次')
    expect(eventReason(ev({ counted: false, counted_reason: 'duplicate' }))).toBe('重複敵人')
    expect(eventReason(ev({ counted: false, counted_reason: 'spectating' }))).toBe('觀戰中')
    expect(eventReason(ev({ counted: false, counted_reason: 'not_counting_type', type: 'squad_wipe' }))).toBe(
      '小隊抹殺不計'
    )
    expect(eventReason(ev({ counted_reason: 'manual', source: 'manual' }))).toBe('手動')

  // override takes precedence over counted_reason.
    expect(eventReason(ev({ counted_override: true }))).toBe('強制計入')
    expect(eventReason(ev({ counted: false, counted_reason: 'spectating', counted_override: false }))).toBe(
      '強制不計入'
    )

  // Soft deletion takes precedence.
    expect(eventReason(ev({ deleted: true, counted: false, counted_reason: 'deleted' }))).toBe('已刪除')
    expect(eventReason(ev({ deleted: true, counted_override: true }))).toBe('已刪除')

  // Show unknown reasons unchanged (forward compatibility).
    expect(eventReason(ev({ counted_reason: 'new_reason' }))).toBe('new_reason')
  })
})

describe('eventAriaLabel', () => {
  test('eventAriaLabel includes type, time and counted state', () => {
    expect(eventAriaLabel(ev())).toBe('擊倒 5:32 計入')
    expect(eventAriaLabel(ev({ counted: false, counted_reason: 'spectating' }))).toBe('擊倒 5:32 不計入：觀戰中')
    expect(eventAriaLabel(ev({ type: 'assist_elim', t: 61 }))).toBe('助攻消滅 1:01 計入')
    expect(eventAriaLabel(ev({ counted_override: false }))).toBe('擊倒 5:32 不計入：強制不計入')
  })
})
