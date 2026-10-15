import { describe, expect, test } from 'vitest'
import type { EngineEvent, EventType } from '../../shared/types'
import { genLong } from '../../../test/fixtures/genEvents'
import { CLUSTER_PX, layoutTimeline, zoomToCluster } from './layout'
import { View, timeToX } from './model'

const ALL = new Set<EventType>(['knock', 'assist_knock', 'assist_elim', 'elim', 'squad_wipe'])
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
// 1 px = 1 s
const view = (over: Partial<View> = {}): View => ({
  duration: 1000,
  start: 0,
  span: 1000,
  width: 1000,
  ...over
})

describe('layoutTimeline', () => {
  test('density mode when width/visibleCount < 8', () => {
    const events = Array.from({ length: 300 }, (_, i) => ev('a' + i, i * 3))
    const r = layoutTimeline(events, view({ width: 1400 }), ALL)
    expect(r.mode).toBe('density')
    expect(r.visibleCount).toBe(300)
    expect(r.items).toHaveLength(300)
    expect(r.items.every((i) => i.events.length === 1)).toBe(true)
  })

  test('icons mode with clusters when between 8px and 22px apart', () => {
    const events = [ev('a', 100), ev('b', 110), ev('c', 120), ev('d', 400)]
    const r = layoutTimeline(events, view(), ALL)
    expect(r.mode).toBe('icons')
    expect(r.items.map((i) => i.events.length)).toEqual([3, 1])
  })

  test('single icons when spacing >= 22px', () => {
    const events = [ev('a', 100), ev('b', 100 + CLUSTER_PX), ev('c', 200)]
    const r = layoutTimeline(events, view(), ALL)
    expect(r.items.map((i) => i.events.length)).toEqual([1, 1, 1])
  })

  test('deleted and filtered-out events are excluded', () => {
    const events = [ev('a', 100), ev('b', 200, { deleted: true }), ev('c', 300, { type: 'elim' })]
    const r = layoutTimeline(events, view(), new Set<EventType>(['knock']))
    expect(r.visibleCount).toBe(1)
    expect(r.items[0].events[0].id).toBe('a')
  })

  test('events outside the view are excluded, edge margin 14px included', () => {
    const events = [ev('l', 85), ev('in1', 87), ev('in2', 300), ev('in3', 613), ev('r', 615)]
    const r = layoutTimeline(events, view({ start: 100, span: 500, width: 500 }), ALL)
    expect(r.items.flatMap((i) => i.events.map((e) => e.id))).toEqual(['in1', 'in2', 'in3'])
  })

  test('cluster x is the mean and items sorted by x', () => {
    const events = [ev('c', 400), ev('a', 100), ev('b', 110)] // 未排序輸入
    const r = layoutTimeline(events, view(), ALL)
    expect(r.items.map((i) => i.x)).toEqual([105, 400])
  })

  test('counted state is carried to items', () => {
    const events = [ev('a', 100, { counted: false, counted_reason: 'duplicate' }), ev('b', 300)]
    const r = layoutTimeline(events, view(), ALL)
    expect(r.items.map((i) => i.counted)).toEqual([false, true])
  })

  test('zoomToCluster spans at least 20s and stays within [0,duration]', () => {
    const v = view({ duration: 1000, span: 1000 })
    const small = zoomToCluster({ events: [ev('a', 500), ev('b', 502)] }, v)
    expect(small.span).toBe(20)
    expect(small.start).toBe(491)
    const wide = zoomToCluster({ events: [ev('a', 100), ev('b', 200)] }, v)
    expect(wide.span).toBe(300)
    expect(wide.start).toBe(0)
    const edge = zoomToCluster({ events: [ev('a', 998), ev('b', 999)] }, v)
    expect(edge.start + edge.span).toBeLessThanOrEqual(1000)
    expect(edge.start).toBeGreaterThanOrEqual(0)
    expect(timeToX(501, small)).toBeCloseTo(500)
  })

  test('perf: layoutTimeline 6000 events < 5ms (median of 20 runs)', () => {
    const { events, duration } = genLong(5700)
    expect(events.length).toBeGreaterThan(5900)
    const v: View = { duration, start: 0, span: duration, width: 1400 }
    layoutTimeline(events, v, ALL)
    const times: number[] = []
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now()
      layoutTimeline(events, v, ALL)
      times.push(performance.now() - t0)
    }
    times.sort((a, b) => a - b)
    expect(times[10]).toBeLessThan(5)
  })

  test('fixture: generated 300-event 2h dataset yields density mode at width 1400 and icons mode at 10-minute span', () => {
    const { events, duration } = genLong()
    expect(events.length).toBeGreaterThan(250)
    expect(events.length).toBeLessThan(400)
    const full = layoutTimeline(events, { duration, start: 0, span: duration, width: 1400 }, ALL)
    expect(full.mode).toBe('density')
    const zoomed = layoutTimeline(events, { duration, start: 2000, span: 600, width: 1400 }, ALL)
    expect(zoomed.mode).toBe('icons')
  })
})
