import { describe, expect, test, vi } from 'vitest'
import { attachKeymap, createKeyDownHandler } from '../hooks/useShortcuts'
import type { Clip, EngineEvent, EventType } from '../../shared/types'
import { genLong } from '../../../test/fixtures/genEvents'
import { layoutTimeline } from './layout'
import type { View } from './model'
import { playheadTarget } from './Playhead'
import { hitDensity } from './select'
import {
  IAction,
  IState,
  cancelRestore,
  initialInteraction,
  interactionReducer,
  attachGestureEscape,
  nextSpaceState,
  swallowEscape,
  pointerToX,
  shouldCancel,
  tipChanged,
  tooltipAt
} from './useTimelineInteractions'

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
const view: View = { duration: 1000, start: 0, span: 1000, width: 1000 }

describe('gesture cancellation', () => {
  const down = { type: 'down', x: 100, y: 60, button: 0, shift: false, space: false } as const
  const run = (actions: IAction[]): { state: IState; outcome: string | null } => {
    let state = initialInteraction
    let outcome: string | null = null
    for (const a of actions) {
      const r = interactionReducer(state, a)
      state = r.state
      outcome = r.outcome
    }
    return { state, outcome }
  }

  test('shouldCancel: blur / Escape cancel any active gesture, never idle', () => {
    for (const phase of ['pressed', 'box', 'pan', 'handle'] as const) {
      expect(shouldCancel(phase, { type: 'blur' })).toBe(true)
      expect(shouldCancel(phase, { type: 'escape' })).toBe(true)
    }
    expect(shouldCancel('idle', { type: 'blur' })).toBe(false)
    expect(shouldCancel('idle', { type: 'escape' })).toBe(false)
  })

  test('shouldCancel: move with no buttons pressed cancels an active gesture', () => {
    expect(shouldCancel('box', { type: 'move', buttons: 0 })).toBe(true)
    expect(shouldCancel('pan', { type: 'move', buttons: 0 })).toBe(true)
    expect(shouldCancel('box', { type: 'move', buttons: 1 })).toBe(false)
    expect(shouldCancel('idle', { type: 'move', buttons: 0 })).toBe(false)
  })

  test('blur mid-box: idle afterwards, plain moves do not box-select, later up fires nothing', () => {
    const r = run([down, { type: 'move', x: 160, y: 60 }, { type: 'cancel' }, { type: 'move', x: 300, y: 60 }])
    expect(r.state.phase).toBe('idle')
    const u = run([down, { type: 'move', x: 160, y: 60 }, { type: 'cancel' }, { type: 'up', x: 300, y: 60 }])
    expect(u.outcome).toBeNull()
  })

  test('blur mid-pan: idle afterwards and up is ignored', () => {
    const r = run([{ ...down, space: true }, { type: 'move', x: 150, y: 60 }, { type: 'cancel' }])
    expect(r.state.phase).toBe('idle')
    expect(run([{ ...down, space: true }, { type: 'cancel' }, { type: 'up', x: 1, y: 1 }]).outcome).toBeNull()
  })

  test('mouseup outside after pressed (cancelled by the next move): no seek', () => {
    expect(run([down, { type: 'cancel' }, { type: 'up', x: 100, y: 60 }]).outcome).toBeNull()
  })

  test('Escape during handle drag restores the original clip', () => {
    const orig: Clip = { id: 'c', start: 100, end: 200, origin: 'ai', event_ids: [] }
    const h = run([{ ...down, handle: { clipId: 'c', edge: 'end' } }, { type: 'move', x: 130, y: 60 }]).state
    expect(cancelRestore(h, orig)).toBe(orig)
    expect(interactionReducer(h, { type: 'cancel' }).state.phase).toBe('idle')
    expect(cancelRestore(run([down, { type: 'move', x: 130, y: 60 }]).state, orig)).toBeNull()
    expect(cancelRestore(h, null)).toBeNull()
  })
})

describe('nextSpaceState', () => {
  test('keydown Space sets only when active and not typing', () => {
    expect(nextSpaceState(false, { type: 'keydown', code: 'Space', typing: false, active: true })).toBe(true)
    expect(nextSpaceState(false, { type: 'keydown', code: 'Space', typing: true, active: true })).toBe(false)
    expect(nextSpaceState(false, { type: 'keydown', code: 'Space', typing: false, active: false })).toBe(false)
    expect(nextSpaceState(false, { type: 'keydown', code: 'KeyA', typing: false, active: true })).toBe(false)
  })
  test('keyup Space and blur clear it (no stuck pan)', () => {
    expect(nextSpaceState(true, { type: 'keyup', code: 'Space' })).toBe(false)
    expect(nextSpaceState(true, { type: 'keyup', code: 'KeyA' })).toBe(true)
    expect(nextSpaceState(true, { type: 'blur' })).toBe(false)
  })
})

describe('pointerToX / tipChanged', () => {
  test('pointerToX maps client px to track px, honouring CSS scaling', () => {
    expect(pointerToX(172, 72, 1000, 1000)).toBe(100)
    expect(pointerToX(172, 72, 500, 1000)).toBe(200)
    expect(pointerToX(10, 0, 0, 1000)).toBe(10)
  })
  test('tipChanged ignores sub-pixel movement with the same text', () => {
    const a = { x: 10.2, y: 30, text: 't' }
    expect(tipChanged(a, { x: 10.4, y: 30.1, text: 't' })).toBe(false)
    expect(tipChanged(a, { x: 12, y: 30, text: 't' })).toBe(true)
    expect(tipChanged(a, { x: 10, y: 30, text: 'u' })).toBe(true)
    expect(tipChanged(a, null)).toBe(true)
    expect(tipChanged(null, null)).toBe(false)
  })
})

describe('density lookup and cluster counts', () => {
  test('hitDensity (binary search) matches a linear scan', () => {
    const { events, duration } = genLong()
    const v: View = { duration, start: 0, span: duration, width: 1400 }
    const L = layoutTimeline(events, v, ALL)
    expect(L.mode).toBe('density')
    for (const x of [0, 3, 250.5, 700, 1399, 2000]) {
      const lin = L.items.filter((it) => Math.abs(it.x - x) <= 6).flatMap((it) => it.events)
      expect(hitDensity(L.items, x, 6).map((e) => e.id)).toEqual(lin.map((e) => e.id))
    }
    expect(tooltipAt(L, 5000, 60)).toBeNull()
  })
  test('layout carries countedCount per cluster', () => {
    const L = layoutTimeline([ev('a', 100), ev('b', 110, { counted: false, counted_reason: 'duplicate' })], view, ALL)
    expect(L.items[0].countedCount).toBe(1)
    expect(L.items[0].events).toHaveLength(2)
  })
})

describe('playheadTarget', () => {
  test('while playing it never returns the stale prop time', () => {
    expect(playheadTarget({ playing: true, time: 12.0, getTime: () => 12.75 })).toBe(12.75)
    expect(playheadTarget({ playing: true, time: 99, getTime: () => 5 })).toBe(5)
  })
  test('paused (or no getTime) uses the prop time', () => {
    expect(playheadTarget({ playing: false, time: 12, getTime: () => 99 })).toBe(12)
    expect(playheadTarget({ playing: true, time: 12 })).toBe(12)
  })
})

describe('Escape swallowing', () => {
  type L = (e: KeyboardEvent) => void
  /** 簡易 window：先跑 capture 監聽，再跑 bubble 監聽，遵守 stopPropagation */
  function fakeWindow(): {
    win: Pick<Window, 'addEventListener' | 'removeEventListener'>
    press: (key: string, opts?: { isComposing?: boolean; keyCode?: number }) => { defaultPrevented: boolean }
  } {
    const cap = new Set<L>()
    const bub = new Set<L>()
    const win = {
      addEventListener: (_t: string, fn: L, capture?: boolean) => void (capture ? cap : bub).add(fn),
      removeEventListener: (_t: string, fn: L, capture?: boolean) => void (capture ? cap : bub).delete(fn)
    } as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>
    const press = (key: string, opts?: { isComposing?: boolean; keyCode?: number }): { defaultPrevented: boolean } => {
      let stopped = false
      const e = {
        key,
        keyCode: opts?.keyCode ?? 27,
        isComposing: opts?.isComposing ?? false,
        target: null,
        defaultPrevented: false,
        preventDefault() {
          e.defaultPrevented = true
        },
        stopPropagation() {
          stopped = true
        }
      }
      for (const fn of [...cap]) fn(e as unknown as KeyboardEvent)
      if (!stopped) for (const fn of [...bub]) fn(e as unknown as KeyboardEvent)
      return e
    }
    return { win, press }
  }

  test('swallowEscape is true only for non-idle phases', () => {
    expect(swallowEscape('idle')).toBe(false)
    for (const p of ['pressed', 'box', 'pan', 'handle'] as const) expect(swallowEscape(p)).toBe(true)
  })

  test('with a gesture active, Escape cancels it and never reaches the global keymap', () => {
    const { win, press } = fakeWindow()
    const closeOverlay = vi.fn()
    attachKeymap(win as Window, () => ({ handlers: { closeOverlay }, screen: 'studio', mode: 'source', overlayOpen: true }))
    let phase: IState['phase'] = 'box'
    const cancel = vi.fn(() => {
      phase = 'idle'
    })
    attachGestureEscape(win, () => phase, cancel)
    const e = press('Escape')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(e.defaultPrevented).toBe(true)
    expect(closeOverlay).not.toHaveBeenCalled()
  })

  test('idle: Escape passes through untouched to the global keymap', () => {
    const { win, press } = fakeWindow()
    const closeOverlay = vi.fn()
    attachKeymap(win as Window, () => ({ handlers: { closeOverlay }, screen: 'studio', mode: 'source', overlayOpen: true }))
    const cancel = vi.fn()
    attachGestureEscape(win, () => 'idle', cancel)
    press('Escape')
    expect(cancel).not.toHaveBeenCalled()
    expect(closeOverlay).toHaveBeenCalledTimes(1)
  })

  test('keymap alone honours defaultPrevented even without stopPropagation', () => {
    const closeOverlay = vi.fn()
    const h = createKeyDownHandler(() => ({ handlers: { closeOverlay }, screen: 'studio', mode: 'source', overlayOpen: true }))
    h({ key: 'Escape', keyCode: 27, isComposing: false, defaultPrevented: true, target: null } as unknown as KeyboardEvent)
    expect(closeOverlay).not.toHaveBeenCalled()
  })

  test('non-Escape keys during a gesture are untouched; detach removes the listener', () => {
    const { win, press } = fakeWindow()
    const cancel = vi.fn()
    const detach = attachGestureEscape(win, () => 'pan', cancel)
    expect(press('a').defaultPrevented).toBe(false)
    detach()
    press('Escape')
    expect(cancel).not.toHaveBeenCalled()
  })

  test('Escape during IME composition neither cancels the gesture nor is intercepted', () => {
    for (const opts of [{ isComposing: true }, { keyCode: 229 }]) {
      const { win, press } = fakeWindow()
      const cancel = vi.fn()
      attachGestureEscape(win, () => 'box', cancel)
      const e = press('Escape', opts)
      expect(cancel).not.toHaveBeenCalled()
      expect(e.defaultPrevented).toBe(false)
    }
  })

  test('after a real Escape cancels the gesture, the next Escape passes through', () => {
    const { win, press } = fakeWindow()
    let phase: IState['phase'] = 'box'
    const cancel = vi.fn(() => {
      phase = 'idle'
    })
    attachGestureEscape(win, () => phase, cancel)

    const first = press('Escape')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(first.defaultPrevented).toBe(true)

    // 手勢已取消（phase = idle），第二次 Escape 不得再被攔截
    const second = press('Escape')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(second.defaultPrevented).toBe(false)
  })
})

describe('playheadTarget hardening', () => {
  test('undefined / NaN / Infinity from getTime falls back to the prop time', () => {
    expect(playheadTarget({ playing: true, time: 7, getTime: () => undefined as unknown as number })).toBe(7)
    expect(playheadTarget({ playing: true, time: 7, getTime: () => NaN })).toBe(7)
    expect(playheadTarget({ playing: true, time: 7, getTime: () => Infinity })).toBe(7)
    expect(playheadTarget({ playing: true, time: 7, getTime: () => 0 })).toBe(0)
  })
})
