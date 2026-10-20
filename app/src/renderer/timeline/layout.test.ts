import { describe, expect, test } from 'vitest'
import type { EngineEvent, EventType } from '../../shared/types'
import { genLong } from '../../../test/fixtures/genEvents'
import { CLUSTER_MAX_PX, CLUSTER_PX, MIN_PX_PER_EVENT, layoutTimeline, zoomToCluster } from './layout'
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
    const events = [ev('c', 400), ev('a', 100), ev('b', 110)] // Unsorted input.
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
    expect(wide.span).toBe(150)
    expect(wide.start).toBe(75)
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

describe('layoutTimeline boundaries (Task 4 review)', () => {
  test('exactly 8 px per event is icons mode, just below is density', () => {
    const v = view({ width: 800, span: 800, duration: 800 })
    const at8 = Array.from({ length: 100 }, (_, i) => ev('a' + i, 1 + i * 7.9))
    expect(MIN_PX_PER_EVENT).toBe(8)
    const r8 = layoutTimeline(at8, v, ALL)
    expect(r8.visibleCount).toBe(100)
    expect(r8.mode).toBe('icons')
    const below = Array.from({ length: 101 }, (_, i) => ev('b' + i, 1 + i * 7.8))
    const r = layoutTimeline(below, v, ALL)
    expect(r.visibleCount).toBe(101)
    expect(r.mode).toBe('density')
  })

  test('width 0 and no visible events: no NaN / Infinity', () => {
    const events = [ev('a', 100), ev('b', 200)]
    const r0 = layoutTimeline(events, view({ width: 0 }), ALL)
    for (const it of r0.items) expect(Number.isFinite(it.x)).toBe(true)
    expect(Number.isFinite(r0.visibleCount)).toBe(true)
    const none = layoutTimeline([], view(), ALL)
    expect(none).toEqual({ mode: 'icons', items: [], visibleCount: 0 })
    const filteredOut = layoutTimeline(events, view(), new Set<EventType>())
    expect(filteredOut.visibleCount).toBe(0)
    expect(filteredOut.items).toEqual([])
  })

  test('does not mutate the input array (even when unsorted)', () => {
    const events = [ev('c', 400), ev('a', 100), ev('b', 110)]
    const ids = events.map((e) => e.id)
    layoutTimeline(events, view(), ALL)
    expect(events.map((e) => e.id)).toEqual(ids)
  })

  test('edge margin: exactly +-14 px included, beyond excluded', () => {
    const v = view({ start: 100, span: 500, width: 500 })
    const r = layoutTimeline([ev('l', 86), ev('lo', 85.9), ev('r', 614), ev('ro', 614.1)], v, ALL)
    expect(r.items.flatMap((i) => i.events.map((e) => e.id))).toEqual(['l', 'r'])
  })

  test('chain of 21 px-spaced events is split into groups no wider than CLUSTER_MAX_PX', () => {
    const events = Array.from({ length: 30 }, (_, i) => ev('a' + i, 50 + i * 21))
    const r = layoutTimeline(events, view(), ALL)
    expect(r.mode).toBe('icons')
    expect(r.items.length).toBeGreaterThan(1)
    for (const it of r.items) {
      const ts = it.events.map((e) => e.t)
      expect(Math.max(...ts) - Math.min(...ts)).toBeLessThanOrEqual(CLUSTER_MAX_PX)
    }
    expect(r.items.reduce((n, i) => n + i.events.length, 0)).toBe(30)
  })
})

describe('zoomToCluster never zooms out', () => {
  test('span <= 0.6 x current span for a strict-subset cluster', () => {
    const v = view({ duration: 1000, start: 0, span: 100 })
    const z = zoomToCluster({ events: [ev('a', 10), ev('b', 90)] }, v)
    expect(z.span).toBe(60)
    expect(z.span).toBeLessThanOrEqual(v.span * 0.6)
  })

  test('span already <= 20 s returns the view unchanged', () => {
    const v = view({ duration: 1000, start: 40, span: 20 })
    expect(zoomToCluster({ events: [ev('a', 45)] }, v)).toBe(v)
    const v2 = view({ duration: 1000, start: 40, span: 12 })
    expect(zoomToCluster({ events: [ev('a', 45)] }, v2)).toBe(v2)
  })

  test('span 30 s: clamped to 20 s (not 18, not larger than current)', () => {
    const v = view({ duration: 1000, start: 0, span: 30 })
    const z = zoomToCluster({ events: [ev('a', 5), ev('b', 6)] }, v)
    expect(z.span).toBe(20)
  })

  test('empty cluster does not produce NaN', () => {
    const v = view()
    const z = zoomToCluster({ events: [] }, v)
    expect(z).toBe(v)
  })
})

describe('layoutTimeline perf (icons path)', () => {
  test('6000 events zoomed so ~175 visible: < 5ms median', () => {
    const { events, duration } = genLong(5700)
    const v: View = { duration, start: 3000, span: 200, width: 1400 }
    const r = layoutTimeline(events, v, ALL)
    expect(r.mode).toBe('icons')
    expect(r.visibleCount).toBeGreaterThan(120)
    expect(r.visibleCount).toBeLessThanOrEqual(175)
    const times: number[] = []
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now()
      layoutTimeline(events, v, ALL)
      times.push(performance.now() - t0)
    }
    times.sort((a, b) => a - b)
    expect(times[10]).toBeLessThan(5)
  })
})
