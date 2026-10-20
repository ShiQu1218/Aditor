import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Clip, EngineEvent, EventType } from '../../shared/types'
import { genLong } from '../../../test/fixtures/genEvents'
import { layoutTimeline } from './layout'
import type { View } from './model'
import {
  CLIP_LABEL_ROW,
  DrawModel,
  EVENT_TOP,
  Theme,
  createRedrawScheduler,
  drawTimeline,
  readTheme,
  resetThemeCache
} from './draw'
import { SHAPES } from './eventShapes'
import { interactionReducer, initialInteraction, type IState } from './useTimelineInteractions'
import { playheadX } from './Playhead'

const ALL = new Set<EventType>(Object.keys(SHAPES) as EventType[])
const theme: Theme = {
  font: '11px sans-serif',
  bg: 'T_bg',
  line: 'T_line',
  lineStrong: 'T_lineStrong',
  text1: 'T_text1',
  text2: 'T_text2',
  text3: 'T_text3',
  popover: 'T_popover',
  onShape: 'T_onShape',
  spectatingFill: 'T_specFill',
  spectatingHatch: 'T_specHatch',
  unanalyzed: 'T_unanalyzed',
  heatRgb: '1, 2, 3',
  clipSuggestLine: 'T_sugLine',
  clipSuggestFill: 'T_sugFill',
  clipLine: 'T_clipLine',
  clipFill: 'T_clipFill',
  projectLine: 'T_projectLine',
  projectFill: 'T_projectFill',
  bladeLine: 'T_bladeLine',
  bladeFill: 'T_bladeFill',
  events: {
    knock: 'C_knock',
    assist_knock: 'C_ak',
    assist_elim: 'C_ae',
    elim: 'C_elim',
    squad_wipe: 'C_wipe',
    kill: 'C_kill',
    death: 'C_death',
    multikill: 'C_multi',
    ace: 'C_ace'
  }
}

interface Call {
  name: string
  args: unknown[]
  fillStyle: unknown
  strokeStyle: unknown
  globalAlpha: unknown
  lineWidth: unknown
  dash: number[]
}
function makeCtx(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = []
  const state: Record<string, unknown> = { globalAlpha: 1, lineWidth: 1, fillStyle: '', strokeStyle: '' }
  let dash: number[] = []
  const snap = (name: string, args: unknown[]): Call => ({
    name,
    args,
    fillStyle: state.fillStyle,
    strokeStyle: state.strokeStyle,
    globalAlpha: state.globalAlpha,
    lineWidth: state.lineWidth,
    dash
  })
  const ctx = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'measureText') return (s: string) => ({ width: s.length * 6 })
        return (...args: unknown[]) => {
          if (prop === 'setLineDash') dash = args[0] as number[]
          calls.push(snap(prop, args))
        }
      },
      set(_t, prop: string, value) {
        state[prop] = value
        calls.push(snap('set:' + prop, [value]))
        return true
      }
    }
  ) as unknown as CanvasRenderingContext2D
  return { ctx, calls }
}

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
const clip = (id: string, start: number, end: number, over: Partial<Clip> = {}): Clip => ({
  id,
  start,
  end,
  origin: 'ai',
  event_ids: [],
  status: 'suggested',
  ...over
})

// 1 px = 1 s
const view: View = { duration: 1000, start: 0, span: 1000, width: 1000 }
function model(events: EngineEvent[], over: Partial<DrawModel> = {}, v: View = view): DrawModel {
  return {
    width: v.width,
    height: 132,
    view: v,
    duration: v.duration,
    layout: layoutTimeline(events, v, ALL),
    spectating: [],
    clips: [],
    selected: new Set(),
    ...over
  }
}
const glyphStrokes = (calls: Call[]): Call[] => calls.filter((c) => c.name === 'stroke' && c.args.length === 1)
const texts = (calls: Call[]): string[] => calls.filter((c) => c.name === 'fillText').map((c) => String(c.args[0]))

class FakePath2D {
  constructor(public d: string) {}
}
beforeAll(() => vi.stubGlobal('Path2D', FakePath2D))
afterAll(() => vi.unstubAllGlobals())

describe('drawTimeline', () => {
  test('selected project range uses a distinct fill and always shows both trim handles', () => {
    const { ctx, calls } = makeCtx()
    drawTimeline(ctx, model([], {
      clips: [clip('suggested', 100, 200)],
      projectItem: { id: 'p', source: 'v.mp4', start: 100, end: 200 }
    }), theme)
    expect(calls.some((c) => c.name === 'fillRect' && c.fillStyle === theme.clipSuggestFill)).toBe(true)
    expect(calls.find((c) => c.name === 'fillRect' && c.fillStyle === theme.projectFill)?.args)
      .toEqual([100, EVENT_TOP, 100, 86])
    const handles = calls.filter((c) => c.name === 'fillRect' && c.fillStyle === theme.projectLine)
    expect(handles.map((c) => c.args[0])).toEqual([98, 196])
  })

  test.each([[100, 200], [200, 100]])('blade marker %s and hover %s fill the same sorted range', (anchor, hover) => {
    const { ctx, calls } = makeCtx()
    drawTimeline(ctx, model([], { blade: { enabled: true, anchor, hover } }), theme)
    expect(calls.find((c) => c.name === 'fillRect' && c.fillStyle === theme.bladeFill)?.args)
      .toEqual([100, EVENT_TOP, 100, 86])
    expect(calls.filter((c) => c.name === 'stroke' && c.strokeStyle === theme.bladeLine)).toHaveLength(2)
    expect(calls.find((c) => c.name === 'fillRect' && c.fillStyle === theme.bladeLine)?.args)
      .toEqual([anchor - 4, 0, 8, 8])
  })

  test('leaving the track keeps only the blade marker; disabled mode paints none', () => {
    const left = makeCtx()
    drawTimeline(left.ctx, model([], { blade: { enabled: true, anchor: 100, hover: null } }), theme)
    expect(left.calls.some((c) => c.fillStyle === theme.bladeFill)).toBe(false)
    expect(left.calls.filter((c) => c.name === 'stroke' && c.strokeStyle === theme.bladeLine)).toHaveLength(1)
    const disabled = makeCtx()
    drawTimeline(disabled.ctx, model([], { blade: { enabled: false, anchor: 100, hover: 200 } }), theme)
    expect(disabled.calls.some((c) => c.strokeStyle === theme.bladeLine || c.fillStyle === theme.bladeFill)).toBe(false)
  })

  test('density mode draws no event shapes, only ticks and heat bars', () => {
    const { events, duration } = genLong()
    const v: View = { duration, start: 0, span: duration, width: 1400 }
    const m = model(events, {}, v)
    expect(m.layout.mode).toBe('density')
    const { ctx, calls } = makeCtx()
    drawTimeline(ctx, m, theme)
    expect(glyphStrokes(calls)).toHaveLength(0)
    expect(calls.some((c) => c.name === 'arc')).toBe(false)
    expect(calls.some((c) => c.name === 'roundRect')).toBe(false)
    const ticks = calls.filter((c) => c.name === 'fillRect' && c.args[2] === 2 && c.args[3] === 10)
    expect(ticks).toHaveLength(m.layout.items.length)
    const heat = calls.filter((c) => c.name === 'fillRect' && String(c.fillStyle).startsWith('rgba(1, 2, 3'))
    expect(heat.length).toBeGreaterThan(0)
    expect(texts(calls).some((s) => s.includes(String(m.layout.visibleCount)))).toBe(true)
  })

  test('icons mode draws one shape per single item and a pill per cluster', () => {
    const events = [
      ev('a', 100),
      ev('b', 300, { type: 'elim' }),
      ev('c', 500, { type: 'squad_wipe' }),
      ev('d', 700),
      ev('e', 710)
    ]
    const m = model(events)
    expect(m.layout.mode).toBe('icons')
    expect(m.layout.items.map((i) => i.events.length)).toEqual([1, 1, 1, 2])
    const { ctx, calls } = makeCtx()
    drawTimeline(ctx, m, theme)
    expect(glyphStrokes(calls)).toHaveLength(3)
    expect(texts(calls)).toContain('×2')
    const fills = calls.filter((c) => c.name === 'fill').map((c) => c.fillStyle)
    expect(fills).toEqual(expect.arrayContaining(['C_knock', 'C_elim', 'C_wipe']))
    expect(SHAPES.squad_wipe.shape).toBe('star')
  })

  test('density ticks retain every banner colour and uncounted opacity', () => {
    const types = Object.keys(SHAPES) as EventType[]
    const events = types.map((type, i) => ev(String(i), 100 + i * 90, { type, counted: i !== 1 }))
    const m = model(events, {}, { ...view, width: 30 })
    expect(m.layout.mode).toBe('density')
    const { ctx, calls } = makeCtx()
    drawTimeline(ctx, m, theme)
    const ticks = calls.filter((c) => c.name === 'fillRect' && c.args[2] === 2 && c.args[3] === 10)
    expect(ticks.map((c) => c.fillStyle)).toEqual(types.map((type) => theme.events[type]))
    expect(ticks.map((c) => c.globalAlpha)).toEqual(types.map((_, i) => (i === 1 ? 0.65 : 1)))
  })

  test('a single-type cluster uses its banner colour for the pill and counted bar', () => {
    const { ctx, calls } = makeCtx()
    drawTimeline(ctx, model([ev('a', 300, { type: 'assist_elim' }), ev('b', 305, { type: 'assist_elim' })]), theme)
    const pill = calls.filter((c) => c.name === 'fillRect' && c.args[3] === 20)
    expect(pill).toHaveLength(1)
    expect(pill[0].fillStyle).toBe('C_ae')
    const bar = calls.filter((c) => c.name === 'fillRect' && c.args[1] === 80 && c.args[3] === 2)
    expect(bar).toHaveLength(1)
    expect(bar[0].fillStyle).toBe('C_ae')
  })

  test('mixed clusters split colours in proportion to type counts; the bar counts only included events', () => {
    const events = [ev('a', 300), ev('b', 303), ev('c', 306, { type: 'assist_knock', counted: false })]
    const { ctx, calls } = makeCtx()
    drawTimeline(ctx, model(events, { selected: new Set(['c']) }), theme)
    const pill = calls.filter((c) => c.name === 'fillRect' && c.args[3] === 20)
    expect(pill.map((c) => c.fillStyle)).toEqual(['C_knock', 'C_ak'])
    expect(pill[0].args[2] as number).toBeCloseTo((pill[1].args[2] as number) * 2)
    expect(pill.map((c) => c.globalAlpha)).toEqual([1, 0.65])
    const bar = calls.filter((c) => c.name === 'fillRect' && c.args[1] === 80 && c.args[3] === 2)
    expect(bar.map((c) => c.fillStyle)).toEqual(['C_knock'])
    expect(bar[0].args[2]).toBeCloseTo((28 - 8) * 2 / 3)
    expect(texts(calls)).toContain('×3')
    expect(calls.some((c) => c.name === 'roundRect' && c.args[3] === 26)).toBe(true)
    expect(calls.some((c) => c.name === 'clip')).toBe(true)
  })

  test('unknown banners use the same fallback colour in density and cluster views', () => {
    const events = [ev('a', 300, { type: 'future_banner' as EventType }), ev('b', 301)]
    for (const width of [10, 1000]) {
      const { ctx, calls } = makeCtx()
      const v = { ...view, width }
      const layout = layoutTimeline(events, v, new Set([...ALL, 'future_banner' as EventType]))
      drawTimeline(ctx, model(events, { layout }, v), theme)
      const marks = calls.filter((c) => c.name === 'fillRect' && (c.args[3] === 10 || c.args[3] === 20))
      expect(marks.length).toBeGreaterThan(0)
      expect(marks.every((c) => c.fillStyle === 'C_knock')).toBe(true)
    }
  })

  test('uncounted events use reduced alpha 0.65 and outline', () => {
    const events = [ev('a', 300, { counted: false, counted_reason: 'duplicate' }), ev('b', 600)]
    const { ctx, calls } = makeCtx()
    drawTimeline(ctx, model(events), theme)
    const idx = calls.findIndex(
      (c) => c.name === 'stroke' && c.args.length === 0 && c.strokeStyle === 'C_knock' && c.lineWidth === 2
    )
    expect(idx).toBeGreaterThan(-1)
    expect(calls[idx].globalAlpha).toBe(0.65)
  // Included events use a solid fill at alpha 1.
    const counted = calls.filter((c) => c.name === 'fill' && c.fillStyle === 'C_knock' && c.globalAlpha === 1)
    expect(counted).toHaveLength(1)
    const lastAlpha = [...calls].reverse().find((c) => c.name === 'set:globalAlpha')
    expect(lastAlpha?.args[0]).toBe(1)
  })

  test('clip handles drawn only for hovered/active clip', () => {
    const clips = [clip('x', 100, 300), clip('y', 500, 700)]
    const isHandle = (c: Call): boolean => c.name === 'fillRect' && c.args[2] === 6
    const none = makeCtx()
    drawTimeline(none.ctx, model([], { clips }), theme)
    expect(none.calls.filter(isHandle)).toHaveLength(0)
    const hover = makeCtx()
    drawTimeline(hover.ctx, model([], { clips, hoverClipId: 'x' }), theme)
    expect(hover.calls.filter(isHandle)).toHaveLength(2)
    const active = makeCtx()
    drawTimeline(active.ctx, model([], { clips, activeClipId: 'y' }), theme)
    expect(active.calls.filter(isHandle)).toHaveLength(2)
  })

  test('narrow clip (<12px) drawn as solid bar without dashed stroke', () => {
    const { ctx, calls } = makeCtx()
    drawTimeline(ctx, model([], { clips: [clip('n', 400, 408)] }), theme)
    expect(calls.some((c) => c.name === 'strokeRect')).toBe(false)
    expect(calls.some((c) => c.name === 'setLineDash' && (c.args[0] as number[]).length > 0)).toBe(false)
    expect(calls.some((c) => c.name === 'fillRect' && c.args[0] === 400 && c.args[2] === 8)).toBe(true)
    const wide = makeCtx()
    drawTimeline(wide.ctx, model([], { clips: [clip('w', 400, 500)] }), theme)
    expect(wide.calls.some((c) => c.name === 'setLineDash' && (c.args[0] as number[]).length > 0)).toBe(true)
    expect(wide.calls.some((c) => c.name === 'strokeRect')).toBe(true)
  })

  test('accepted clip: solid line, check mark in label', () => {
    const { ctx, calls } = makeCtx()
    drawTimeline(ctx, model([], { clips: [clip('a', 400, 500, { status: 'accepted', origin: 'manual' })] }), theme)
    const sr = calls.find((c) => c.name === 'strokeRect')!
    expect(sr.strokeStyle).toBe('T_clipLine')
    expect(sr.lineWidth).toBe(2)
    expect(sr.dash).toEqual([])
    expect(texts(calls).some((s) => s.startsWith('✓'))).toBe(true)
  })

  test('skipped clips are not drawn', () => {
    const { ctx, calls } = makeCtx()
    drawTimeline(ctx, model([], { clips: [clip('s', 400, 500, { status: 'skipped' })] }), theme)
    expect(calls.some((c) => c.name === 'strokeRect')).toBe(false)
  })

  test('clip label is drawn on its own row above the box', () => {
    const { ctx, calls } = makeCtx()
    drawTimeline(ctx, model([], { clips: [clip('l', 400, 600)] }), theme)
    const box = calls.find((c) => c.name === 'strokeRect')!
    const label = calls.find((c) => c.name === 'fillRect' && c.args[1] === CLIP_LABEL_ROW.y)!
    expect(label).toBeDefined()
    expect(label.args[1] as number).toBeGreaterThanOrEqual(22)
    expect((label.args[1] as number) + (label.args[3] as number)).toBeLessThanOrEqual(box.args[1] as number)
    expect(box.args[1] as number).toBeGreaterThanOrEqual(EVENT_TOP)
    const t = calls.find((c) => c.name === 'fillText' && /AI/.test(String(c.args[0])))!
    expect(t.args[2] as number).toBeLessThan(box.args[1] as number)
  })

  test('unanalyzed: nothing drawn when undefined, drawn when provided', () => {
    const absent = makeCtx()
    drawTimeline(absent.ctx, model([]), theme)
    expect(absent.calls.some((c) => c.fillStyle === 'T_unanalyzed' && c.name === 'fillRect')).toBe(false)
    const given = makeCtx()
    drawTimeline(given.ctx, model([], { unanalyzed: [{ start: 600, end: 700 }] }), theme)
    const r = given.calls.find((c) => c.fillStyle === 'T_unanalyzed' && c.name === 'fillRect')
    expect(r?.args[0]).toBe(600)
    expect(r?.args[2]).toBe(100)
  })

  test('spectating hatch and ruler are drawn; label only when wide', () => {
    const { ctx, calls } = makeCtx()
    drawTimeline(ctx, model([], { spectating: [{ start: 100, end: 300 }, { start: 500, end: 540 }] }), theme)
    expect(calls.filter((c) => c.name === 'fillRect' && c.fillStyle === 'T_specFill')).toHaveLength(2)
    expect(texts(calls).filter((s) => s.includes('觀戰'))).toHaveLength(1)
    expect(texts(calls)).toContain('2:00')
  })

  test('selected events get a ring; current event too', () => {
    const events = [ev('a', 300), ev('b', 600)]
    const none = makeCtx()
    drawTimeline(none.ctx, model(events), theme)
    const sel = makeCtx()
    drawTimeline(sel.ctx, model(events, { selected: new Set(['a']), currentId: 'b' }), theme)
    const rings = (calls: Call[]): number => calls.filter((c) => c.name === 'arc' && c.args[2] === 15).length
    expect(rings(none.calls)).toBe(0)
    expect(rings(sel.calls)).toBe(2)
  })

  test('zero width does not throw or emit NaN', () => {
    const v: View = { ...view, width: 0 }
    const { ctx, calls } = makeCtx()
    drawTimeline(ctx, model([ev('a', 5)], {}, v), theme)
    for (const c of calls) for (const a of c.args) if (typeof a === 'number') expect(Number.isFinite(a)).toBe(true)
  })
})

describe('createRedrawScheduler', () => {
  test('redraw scheduler coalesces multiple invalidations into one rAF', () => {
    let nextId = 1
    const pending = new Map<number, () => void>()
    const raf = vi.fn((cb: () => void) => {
      pending.set(nextId, cb)
      return nextId++
    })
    const cancel = vi.fn((id: number) => void pending.delete(id))
    const draw = vi.fn()
    const s = createRedrawScheduler(draw, raf, cancel)
    s.invalidate()
    s.invalidate()
    s.invalidate()
    expect(raf).toHaveBeenCalledTimes(1)
    expect(draw).not.toHaveBeenCalled()
    pending.forEach((cb) => cb())
    pending.clear()
    expect(draw).toHaveBeenCalledTimes(1)
    s.invalidate()
    expect(raf).toHaveBeenCalledTimes(2)
  })

  test('dispose cancels the pending frame', () => {
    const raf = vi.fn(() => 7)
    const cancel = vi.fn()
    const draw = vi.fn()
    const s = createRedrawScheduler(draw, raf, cancel)
    s.invalidate()
    s.dispose()
    expect(cancel).toHaveBeenCalledWith(7)
  })
})

describe('readTheme', () => {
  test('reads CSS variables once and caches', () => {
    resetThemeCache()
    const getVar = vi.fn((n: string) => 'V' + n)
    const a = readTheme(getVar)
    const calls = getVar.mock.calls.length
    expect(calls).toBeGreaterThan(10)
    const b = readTheme(getVar)
    expect(b).toBe(a)
    expect(getVar.mock.calls.length).toBe(calls)
    for (const type of Object.keys(SHAPES) as EventType[]) {
      expect(a.events[type]).toBe('V' + SHAPES[type].colorVar)
    }
    expect(a.heatRgb).toBe('V--tl-heat')
    expect(a.projectLine).toBe('V--tl-project-line')
    expect(a.projectFill).toBe('V--tl-project-fill')
    expect(a.bladeLine).toBe('V--tl-blade-line')
    expect(a.bladeFill).toBe('V--tl-blade-fill')
    resetThemeCache()
  })
})

describe('source hygiene', () => {
  test('no hex colour literals in timeline drawing sources', () => {
    for (const f of ['draw.ts', 'eventShapes.ts', 'Playhead.tsx', 'useTimelineInteractions.ts', 'TimelineCanvas.tsx']) {
      const src = readFileSync(resolve(__dirname, f), 'utf8')
      expect(src, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    }
  })
})

describe('interactionReducer', () => {
  const run = (actions: Parameters<typeof interactionReducer>[1][]): { state: IState; outcome: string | null } => {
    let state = initialInteraction
    let outcome: string | null = null
    for (const a of actions) {
      const r = interactionReducer(state, a)
      state = r.state
      outcome = r.outcome
    }
    return { state, outcome }
  }
  const down = { type: 'down', x: 100, y: 60, button: 0, shift: false } as const

  test('mousedown -> move(3px) -> up = click', () => {
    const r = run([down, { type: 'move', x: 103, y: 60 }, { type: 'up', x: 103, y: 60 }])
    expect(r.outcome).toBe('click')
    expect(r.state.phase).toBe('idle')
  })

  test('exactly 4px is still a click; 5px becomes scrub', () => {
    expect(run([down, { type: 'move', x: 104, y: 60 }, { type: 'up', x: 104, y: 60 }]).outcome).toBe('click')
    expect(run([down, { type: 'move', x: 105, y: 60 }]).state.phase).toBe('scrub')
    expect(run([down, { type: 'move', x: 105, y: 60 }, { type: 'up', x: 105, y: 60 }]).outcome).toBe('scrub')
  })

  test('a scrub stays a scrub when the pointer returns near the start', () => {
    const r = run([down, { type: 'move', x: 130, y: 60 }, { type: 'move', x: 101, y: 60 }, { type: 'up', x: 101, y: 60 }])
    expect(r.outcome).toBe('scrub')
  })

  test('middle button takes priority over handle', () => {
    const r = run([
      { ...down, button: 1, handle: { clipId: 'c', edge: 'start' } },
      { type: 'move', x: 140, y: 60 }
    ])
    expect(r.state.phase).toBe('pan')
    expect(run([{ ...down, button: 1 }, { type: 'up', x: 100, y: 60 }]).outcome).toBe('pan')
  })

  test('middle button = pan', () => {
    expect(run([{ ...down, button: 1 }]).state.phase).toBe('pan')
  })

  test('handle press starts handle drag immediately; up ends it', () => {
    const h = { clipId: 'c', edge: 'end' } as const
    const r = run([{ ...down, handle: h }, { type: 'move', x: 110, y: 60 }])
    expect(r.state.phase).toBe('handle')
    expect(r.state.handle).toEqual(h)
    expect(run([{ ...down, handle: h }, { type: 'up', x: 100, y: 60 }]).outcome).toBe('handle')
  })

  test('shift flag is remembered', () => {
    const r = run([{ ...down, shift: true }, { type: 'move', x: 120, y: 60 }])
    expect(r.state.shift).toBe(true)
  })

  test('move/up when idle are ignored', () => {
    const r = run([{ type: 'move', x: 50, y: 5 }, { type: 'up', x: 50, y: 5 }])
    expect(r.outcome).toBeNull()
    expect(r.state.phase).toBe('idle')
  })

  test('cancel returns to idle', () => {
    expect(run([down, { type: 'cancel' }]).state.phase).toBe('idle')
  })
})

describe('playheadX', () => {
  test('maps time to px and flags off-screen', () => {
    const v: View = { duration: 1000, start: 100, span: 200, width: 1000 }
    expect(playheadX(150, v)).toEqual({ x: 250, visible: true })
    expect(playheadX(50, v).visible).toBe(false)
    expect(playheadX(301, v).visible).toBe(false)
  })
})
