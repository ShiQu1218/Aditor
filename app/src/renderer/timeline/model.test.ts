import { describe, it, expect } from 'vitest'
import {
  View,
  timeToX,
  xToTime,
  zoom,
  pan,
  heatmap,
  hitTestEvent,
  nextEvent,
  DETAIL_SPAN,
  TimelineZoom,
  maxCustomZoom,
  resizeTimeline,
  scrollStartAt,
  setCustomZoom,
  setZoomMode,
  timelineScroll,
  updateTimelineView,
  zoomTimeline
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
    heatmap(events, 6000, 100)
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

describe('Timeline zoom modes', () => {
  const full = (duration = 600): TimelineZoom => ({
    mode: 'full', customZoom: 1,
    view: { duration, start: 0, span: duration, width: 1000 }
  })

  it('full extent fills the viewport and ignores panning', () => {
    const state = setZoomMode(setCustomZoom(full(), 4, 300), 'full', 300)
    expect(state.view).toEqual(full().view)
    expect(updateTimelineView(state, (v) => pan(v, 100))).toBe(state)
    expect(timelineScroll(state.view)).toEqual({ left: 0, width: 1000, maxStart: 0 })
    expect(scrollStartAt(state.view, 800, 0)).toBe(0)
  })

  it('detail keeps a fixed 30-second window centred on the playhead and clamps at the ends', () => {
    const detail = setZoomMode(full(), 'detail', 300)
    expect(detail.view.span).toBe(DETAIL_SPAN)
    expect(detail.view.start).toBe(285)
    expect(setZoomMode(detail, 'detail', 400).view.start).toBe(385)
    expect(setZoomMode(detail, 'detail', 2).view.start).toBe(0)
    expect(setZoomMode(detail, 'detail', 599).view.start).toBe(570)
    expect(setZoomMode(detail, 'detail', 300)).toBe(detail)
  })

  it('switching modes preserves the custom multiplier', () => {
    const custom = setCustomZoom(full(), 8, 300)
    expect(custom.view.span).toBe(75)
    const detail = setZoomMode(setZoomMode(custom, 'full', 400), 'detail', 400)
    expect(detail.customZoom).toBe(8)
    const restored = setZoomMode(detail, 'custom', 400)
    expect(restored.mode).toBe('custom')
    expect(restored.view.span).toBe(75)
    expect(restored.view.start).toBe(362.5)
  })

  it('manual zoom enters custom mode, centres the playhead and clamps the multiplier', () => {
    const state = zoomTimeline(full(), 0.5, 200)
    expect(state.mode).toBe('custom')
    expect(state.view.span).toBe(300)
    expect(state.view.start).toBe(50) // Center on 200: viewport [50, 350].
    expect(timeToX(200, state.view)).toBe(500)
    expect(state.customZoom).toBe(2)
    expect(setCustomZoom(state, 1000, 150).view.span).toBe(10)
    expect(setCustomZoom(state, -1, 150).view.span).toBe(600)
    expect(zoomTimeline(full(), 2, 300).mode).toBe('custom')
  })

  it('custom zoom centres on the playhead, not on the current view centre', () => {
    // Zoom in near the start, then move the playhead to 450 and change scale: the viewport should center on 450.
    const zoomed = setCustomZoom(full(), 4, 100)
    expect(zoomed.view.start).toBe(25)
    const moved = setCustomZoom(zoomed, 8, 450)
    expect(moved.view.span).toBe(75)
    expect(moved.view.start).toBe(412.5)
    expect(zoomTimeline(moved, 0.5, 450).view.start).toBeCloseTo(431.25)
  })

  it('centred zoom clamps at the source ends', () => {
    expect(setCustomZoom(full(), 4, 5).view.start).toBe(0)
    expect(setCustomZoom(full(), 4, 598).view.start).toBe(450)
  })

  it('manual pan and cluster zoom enter custom mode without changing unrelated view data', () => {
    const detail = setZoomMode(full(), 'detail', 300)
    const panned = updateTimelineView(detail, (v) => pan(v, 20))
    expect(panned.mode).toBe('custom')
    expect(panned.view.start).toBe(305)
    expect(panned.view.span).toBe(30)
    expect(panned.customZoom).toBe(20)
    const clustered = updateTimelineView(full(), (v) => ({ ...v, start: 200, span: 20 }))
    expect(clustered.customZoom).toBe(30)
  })

  it('scroll thumb reflects visible proportion and supports dragging with an arbitrary grab offset', () => {
    const view = setCustomZoom(full(), 4, 300).view
    expect(timelineScroll(view)).toEqual({ left: 375, width: 250, maxStart: 450 })
    expect(scrollStartAt(view, 500, 25)).toBe(285)
    expect(scrollStartAt(view, -500, 25)).toBe(0)
    expect(scrollStartAt(view, 2000, 25)).toBe(450)
    expect(scrollStartAt({ ...view, width: 0 }, 500, 25)).toBe(view.start)
  })

  it('resize and duration changes preserve modes and custom magnification within bounds', () => {
    const custom = setCustomZoom(full(), 4, 300)
    const resized = resizeTimeline(custom, 1200, 800, 300)
    expect(resized.mode).toBe('custom')
    expect(resized.view.span).toBe(300)
    expect(resized.customZoom).toBe(4)
    expect(resizeTimeline(custom, 20, 800, 300).view).toEqual({ duration: 20, width: 800, span: 10, start: 10 })
    expect(resizeTimeline(full(), 1200, 800, 300).view.span).toBe(1200)
    expect(resizeTimeline(setZoomMode(full(), 'detail', 300), 1200, 800, 500).view.start).toBe(485)
    expect(resizeTimeline(custom, 600, 1000, 300)).toBe(custom)
  })

  it('short or zero-duration sources remain finite and cannot scroll beyond the source', () => {
    expect(maxCustomZoom(0)).toBe(1)
    const state = resizeTimeline(full(), 0, 0, 0)
    for (const mode of ['full', 'detail', 'custom'] as const) {
      const next = setZoomMode(state, mode, 300)
      expect(next.view).toEqual({ duration: 1, width: 0, span: 1, start: 0 })
      expect(timelineScroll(next.view)).toEqual({ left: 0, width: 0, maxStart: 0 })
    }
    expect(zoomTimeline(full(5), 0.01, 2).view.span).toBe(5)
  })
})
