import { describe, it, expect } from 'vitest'
import {
  View,
  timeToX,
  xToTime,
  zoom,
  pan,
  heatmap,
  hitTestEvent,
  nextEvent
} from './model'
import { EngineEvent, EventType } from '../../shared/types'

describe('Timeline Model', () => {
  const defaultView: View = {
    duration: 600,
    start: 100,
    span: 200,
    width: 1000
  }

  it('timeToX/xToTime roundtrip', () => {
    const t = 180
    const x = timeToX(t, defaultView)
    expect(x).toBe(400) // (180 - 100) / 200 * 1000 = 400
    expect(xToTime(x, defaultView)).toBe(t)
  })

  it('zoom keeps anchor time under cursor and clamps span', () => {
    const anchorT = 200
    // Zoom in by factor 0.5 (span 200 -> 100)
    const zoomed = zoom(defaultView, 0.5, anchorT)
    expect(zoomed.span).toBe(100)
    // In original view, anchorT=200 was at fraction (200 - 100) / 200 = 0.5 (x = 500)
    // In zoomed view, anchorT=200 should still be at x = 500:
    expect(timeToX(anchorT, zoomed)).toBeCloseTo(500)

    // Clamps to min 10
    const zoomedMax = zoom(defaultView, 0.01, anchorT)
    expect(zoomedMax.span).toBe(10)

    // Clamps to max duration
    const zoomedOut = zoom(defaultView, 10, anchorT)
    expect(zoomedOut.span).toBe(600)
    expect(zoomedOut.start).toBe(0)
  })

  it('heatmap ignores non-counted and normalizes', () => {
    const events: EngineEvent[] = [
      { id: '1', t: 10, type: 'knock', counted: true, counted_override: null, score: 0.9, damage_line: true, name_sig: null, counted_reason: '', source: 'auto' },
      { id: '2', t: 12, type: 'knock', counted: true, counted_override: null, score: 0.9, damage_line: true, name_sig: null, counted_reason: '', source: 'auto' },
      { id: '3', t: 15, type: 'knock', counted: false, counted_override: null, score: 0.9, damage_line: true, name_sig: null, counted_reason: '', source: 'auto' }, // ignored
      { id: '4', t: 90, type: 'knock', counted: true, counted_override: null, score: 0.9, damage_line: true, name_sig: null, counted_reason: '', source: 'auto' }
    ]

    const bins = 10
    const duration = 100
    const map = heatmap(events, duration, bins)
    expect(map.length).toBe(10)
    // Bin 1 (t in [10, 20)) has 2 counted events (events 1 & 2)
    // Bin 9 (t in [90, 100)) has 1 counted event (event 4)
    // Max is 2, so bin 1 is 1.0, bin 9 is 0.5
    expect(map[1]).toBe(1.0)
    expect(map[9]).toBe(0.5)
    expect(map[0]).toBe(0)
  })

  it('heatmap/hitTest fast on 2000 events over 6000s', () => {
    const events: EngineEvent[] = []
    for (let i = 0; i < 2000; i++) {
      events.push({
        id: `ev_${i}`,
        t: (i / 2000) * 6000,
        type: 'knock',
        counted: true,
        counted_override: null,
        score: 0.8,
        damage_line: true,
        name_sig: null,
        counted_reason: 'first',
        source: 'auto'
      })
    }

    const t0 = performance.now()
    const map = heatmap(events, 6000, 100)
    const tHeatmap = performance.now() - t0
    expect(tHeatmap).toBeLessThan(15) // comfortably < 5-15ms

    const view: View = { duration: 6000, start: 1000, span: 1000, width: 1200 }
    const t1 = performance.now()
    const hit = hitTestEvent(events, 500, view, 10)
    const tHit = performance.now() - t1
    expect(tHit).toBeLessThan(15)
    expect(hit).toBeDefined()
  })

  it('nextEvent respects type filter and direction', () => {
    const events: EngineEvent[] = [
      { id: '1', t: 10, type: 'knock', counted: true, counted_override: null, score: 0.9, damage_line: true, name_sig: null, counted_reason: '', source: 'auto' },
      { id: '2', t: 20, type: 'assist_knock', counted: true, counted_override: null, score: 0.9, damage_line: true, name_sig: null, counted_reason: '', source: 'auto' },
      { id: '3', t: 30, type: 'knock', counted: true, counted_override: null, score: 0.9, damage_line: true, name_sig: null, counted_reason: '', source: 'auto' }
    ]

    const knockTypes = new Set<EventType>(['knock'])
    // Next forward knock after t=10 is t=30 (skips t=20 assist_knock)
    expect(nextEvent(events, 10, 1, knockTypes)?.id).toBe('3')
    // Next backward knock before t=30 is t=10
    expect(nextEvent(events, 30, -1, knockTypes)?.id).toBe('1')

    const allTypes = new Set<EventType>(['knock', 'assist_knock'])
    expect(nextEvent(events, 10, 1, allTypes)?.id).toBe('2')
  })
})
