import { describe, expect, test } from 'vitest'
import type { EngineEvent } from '../../shared/types'
import { createLatestGate, mergeDerived, planBatchDelete, planBoxSelect, planDeleteEvents } from './eventActions'

function ev(id: string, t: number, over: Partial<EngineEvent> = {}): EngineEvent {
  return {
    id,
    t,
    type: 'knock',
    score: 1,
    damage_line: false,
    name_sig: null,
    counted: true,
    counted_reason: 'first',
    counted_override: null,
    source: 'auto',
    ...over
  }
}

describe('mergeDerived', () => {
  const snapshot = [ev('a', 1), ev('b', 2), ev('c', 3)]
  const derived = [
    ev('a', 1, { counted: false, counted_reason: 'dup' }),
    ev('b', 2, { counted: true, counted_reason: 'first' }),
    ev('c', 3, { counted: false, counted_reason: 'spectating' })
  ]

  test('merges only counted / counted_reason by id', () => {
    const out = mergeDerived(snapshot, derived)
    expect(out.map((e) => [e.id, e.counted, e.counted_reason])).toEqual([
      ['a', false, 'dup'],
      ['b', true, 'first'],
      ['c', false, 'spectating']
    ])
  })

  test('a delete made during the await survives (event stays deleted, still present)', () => {
    const current = [ev('a', 1), ev('b', 2, { deleted: true }), ev('c', 3)]
    const out = mergeDerived(current, derived)
    expect(out).toHaveLength(3)
    expect(out.find((e) => e.id === 'b')?.deleted).toBe(true)
  })

  test('an override edit made during the await survives', () => {
    const current = [ev('a', 1), ev('b', 2, { counted_override: false }), ev('c', 3)]
    const out = mergeDerived(current, derived)
    expect(out.find((e) => e.id === 'b')?.counted_override).toBe(false)
  })

  test('events added meanwhile are kept untouched; events missing from the response are untouched', () => {
    const added = ev('m1', 9, { source: 'manual', counted_reason: 'manual' })
    const out = mergeDerived([...snapshot, added], derived.slice(0, 2))
    expect(out.find((e) => e.id === 'm1')).toBe(added)
    expect(out.find((e) => e.id === 'c')).toBe(snapshot[2])
  })

  test('events absent from current are not resurrected', () => {
    const out = mergeDerived([ev('a', 1)], derived)
    expect(out.map((e) => e.id)).toEqual(['a'])
  })

  test('does not mutate inputs', () => {
    const cur = [ev('a', 1)]
    const before = JSON.stringify(cur)
    mergeDerived(cur, derived)
    expect(JSON.stringify(cur)).toBe(before)
  })
})

describe('createLatestGate (out-of-order derive responses)', () => {
  test('only the most recently issued ticket is accepted', () => {
    const gate = createLatestGate()
    const t1 = gate.next()
    const t2 = gate.next()
    expect(gate.isLatest(t1)).toBe(false) // 舊回應晚到＝丟棄
    expect(gate.isLatest(t2)).toBe(true)
    const t3 = gate.next()
    expect(gate.isLatest(t2)).toBe(false)
    expect(gate.isLatest(t3)).toBe(true)
  })
})

describe('planDeleteEvents', () => {
  const events = [ev('a', 1), ev('b', 2, { deleted: true }), ev('c', 3)]
  test('selection wins', () => {
    expect(planDeleteEvents(new Set(['a', 'c']), 'b', events)).toEqual(['a', 'c'])
  })
  test('no selection -> the cursor row', () => {
    expect(planDeleteEvents(new Set(), 'c', events)).toEqual(['c'])
  })
  test('no selection and no usable cursor (none, missing, already deleted) -> nothing', () => {
    expect(planDeleteEvents(new Set(), null, events)).toEqual([])
    expect(planDeleteEvents(new Set(), 'zz', events)).toEqual([])
    expect(planDeleteEvents(new Set(), 'b', events)).toEqual([])
  })
})

describe('planBatchDelete (Toast undo restores events and previous selection)', () => {
  test('captures ids and the selection to restore', () => {
    const plan = planBatchDelete(['a', 'c'], new Set(['a', 'c', 'x']))
    expect(plan.ids).toEqual(['a', 'c'])
    expect(plan.undoSelection).toEqual(['a', 'c', 'x'])
  })
  test('single cursor delete (no selection) restores an empty selection', () => {
    expect(planBatchDelete(['c'], new Set()).undoSelection).toEqual([])
  })
})

describe('planBoxSelect', () => {
  test('0 events in replace mode: no toast, selection untouched, tab not switched', () => {
    expect(planBoxSelect([], false)).toBeNull()
  })
  test('0 events in additive mode: nothing either', () => {
    expect(planBoxSelect([], true)).toBeNull()
  })
  test('some events: select with the right mode', () => {
    expect(planBoxSelect(['a'], false)).toEqual({ mode: 'replace' })
    expect(planBoxSelect(['a', 'b'], true)).toEqual({ mode: 'add' })
  })
})
