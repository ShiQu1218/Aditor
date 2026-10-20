import { describe, expect, test } from 'vitest'
import {
  getCurrentZone,
  setCurrentZone,
  initialZoneState,
  reduceZone,
  zoneOf,
  type ElementLike
} from './focusZone'

function el(tag: string, attrs: Record<string, string> = {}, parent?: ElementLike): ElementLike & { isConnected?: boolean } {
  const node = {
    tagName: tag,
    parentElement: parent ?? null,
    isConnected: true,
    getAttribute(name: string): string | null {
      return attrs[name] ?? null
    }
  }
  return node
}

describe('focus zone state', () => {
test('getCurrentZone returns the most recently set zone', () => {
    setCurrentZone('hl', el('DIV', { 'data-zone': 'hl' }))
    expect(getCurrentZone()).toBe('hl')
    setCurrentZone(null)
    expect(getCurrentZone()).toBeNull()
  })

test('Does not return a stale zone after its recorded element is removed (isConnected=false)', () => {
    const node = el('DIV', { 'data-zone': 'hl' })
    setCurrentZone('hl', node)
    expect(getCurrentZone()).toBe('hl')
    node.isConnected = false
    expect(getCurrentZone()).toBeNull()
  })

test('reduceZone records the element when focusin enters a zone', () => {
    const target = el('DIV', { 'data-zone': 'src' })
    const next = reduceZone(initialZoneState, { type: 'focusin', target, related: null })
    expect(next.zone).toBe('src')
    expect(next.el).toBe(target)
  })

test('reduceZone clears the record when mousedown occurs outside a zone', () => {
    const inZone = reduceZone(initialZoneState, { type: 'focusin', target: el('DIV', { 'data-zone': 'src' }), related: null })
    const next = reduceZone(inZone, { type: 'mousedown', target: el('BUTTON'), related: null })
    expect(next.zone).toBeNull()
  })

test('reduceZone records the new zone when focus moves between zones', () => {
    const from = reduceZone(initialZoneState, { type: 'focusin', target: el('DIV', { 'data-zone': 'hl' }), related: null })
    const to = el('LI', { 'data-zone': 'proj' })
    const next = reduceZone(from, { type: 'focusout', target: el('DIV', { 'data-zone': 'hl' }), related: to })
    expect(next.zone).toBe('proj')
    expect(next.el).toBe(to)
    expect(zoneOf(to)).toBe('proj')
  })

test('Keyboard focus leaving a zone (focusout with null relatedTarget) clears it to prevent stale state', () => {
    const inZone = reduceZone(initialZoneState, { type: 'focusin', target: el('DIV', { 'data-zone': 'proj' }), related: null })
    const next = reduceZone(inZone, { type: 'focusout', target: el('DIV', { 'data-zone': 'proj' }), related: null })
    expect(next.zone).toBeNull()
  })
})

describe('Pointer latch (clicking a non-focusable element inside a zone)', () => {
  const zoneRoot = el('DIV', { 'data-zone': 'hl' })
  const card = el('DIV', {}, zoneRoot) // Non-focusable card content.
  const previouslyFocused = el('LI', {}, zoneRoot)
  const outside = el('MAIN')

  function seq(...evs: Parameters<typeof reduceZone>[1][]) {
    return evs.reduce(reduceZone, initialZoneState)
  }

test('mousedown on non-focusable zone content → focusout(null) → no focusin: keep the zone', () => {
    const s = seq(
      { type: 'focusin', target: el('DIV', { 'data-zone': 'hl' }), related: null },
      { type: 'mousedown', target: card, related: null },
      { type: 'focusout', target: previouslyFocused, related: null }
    )
    expect(s.zone).toBe('hl')
  })

test('A later focusin outside all zones clears the zone', () => {
    const s = seq(
      { type: 'mousedown', target: card, related: null },
      { type: 'focusout', target: previouslyFocused, related: null },
      { type: 'focusin', target: outside, related: null }
    )
    expect(s.zone).toBeNull()
  })

test('The latch protects only the next focusout; a later keyboard exit still clears the zone', () => {
    const s = seq(
      { type: 'mousedown', target: card, related: null },
      { type: 'focusout', target: previouslyFocused, related: null },
      { type: 'focusin', target: el('BUTTON', {}, zoneRoot), related: null },
      { type: 'focusout', target: el('BUTTON', {}, zoneRoot), related: null }
    )
    expect(s.zone).toBeNull()
  })

test('mousedown outside a zone clears it and focusout does not restore it', () => {
    const s = seq(
      { type: 'mousedown', target: card, related: null },
      { type: 'mousedown', target: outside, related: null },
      { type: 'focusout', target: previouslyFocused, related: null }
    )
    expect(s.zone).toBeNull()
  })
})
