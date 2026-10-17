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
  test('getCurrentZone 回傳最近一次 set 的區域', () => {
    setCurrentZone('hl', el('DIV', { 'data-zone': 'hl' }))
    expect(getCurrentZone()).toBe('hl')
    setCurrentZone(null)
    expect(getCurrentZone()).toBeNull()
  })

  test('記錄的元素被移除（isConnected=false）後不再回傳過期區域', () => {
    const node = el('DIV', { 'data-zone': 'hl' })
    setCurrentZone('hl', node)
    expect(getCurrentZone()).toBe('hl')
    node.isConnected = false
    expect(getCurrentZone()).toBeNull()
  })

  test('reduceZone：focusin 進入區域時記錄元素', () => {
    const target = el('DIV', { 'data-zone': 'src' })
    const next = reduceZone(initialZoneState, { type: 'focusin', target, related: null })
    expect(next.zone).toBe('src')
    expect(next.el).toBe(target)
  })

  test('reduceZone：mousedown 在區域外清除記錄', () => {
    const inZone = reduceZone(initialZoneState, { type: 'focusin', target: el('DIV', { 'data-zone': 'src' }), related: null })
    const next = reduceZone(inZone, { type: 'mousedown', target: el('BUTTON'), related: null })
    expect(next.zone).toBeNull()
  })

  test('reduceZone：焦點在區域之間移動時記錄新區域', () => {
    const from = reduceZone(initialZoneState, { type: 'focusin', target: el('DIV', { 'data-zone': 'hl' }), related: null })
    const to = el('LI', { 'data-zone': 'proj' })
    const next = reduceZone(from, { type: 'focusout', target: el('DIV', { 'data-zone': 'hl' }), related: to })
    expect(next.zone).toBe('proj')
    expect(next.el).toBe(to)
    expect(zoneOf(to)).toBe('proj')
  })

  test('鍵盤把焦點移出區域（focusout，relatedTarget 為 null）會清除，避免殘留', () => {
    const inZone = reduceZone(initialZoneState, { type: 'focusin', target: el('DIV', { 'data-zone': 'proj' }), related: null })
    const next = reduceZone(inZone, { type: 'focusout', target: el('DIV', { 'data-zone': 'proj' }), related: null })
    expect(next.zone).toBeNull()
  })
})

describe('指標鎖存（點在區域內的非可聚焦元素）', () => {
  const zoneRoot = el('DIV', { 'data-zone': 'hl' })
  const card = el('DIV', {}, zoneRoot) // 非可聚焦的卡片內容
  const previouslyFocused = el('LI', {}, zoneRoot)
  const outside = el('MAIN')

  function seq(...evs: Parameters<typeof reduceZone>[1][]) {
    return evs.reduce(reduceZone, initialZoneState)
  }

  test('mousedown(區域內非可聚焦) → focusout(null) → 沒有 focusin：維持該區域', () => {
    const s = seq(
      { type: 'focusin', target: el('DIV', { 'data-zone': 'hl' }), related: null },
      { type: 'mousedown', target: card, related: null },
      { type: 'focusout', target: previouslyFocused, related: null }
    )
    expect(s.zone).toBe('hl')
  })

  test('之後 focusin 落在所有區域之外：清除', () => {
    const s = seq(
      { type: 'mousedown', target: card, related: null },
      { type: 'focusout', target: previouslyFocused, related: null },
      { type: 'focusin', target: outside, related: null }
    )
    expect(s.zone).toBeNull()
  })

  test('鎖存只保護緊接著的那一次 focusout；之後的鍵盤離開區域仍會清除', () => {
    const s = seq(
      { type: 'mousedown', target: card, related: null },
      { type: 'focusout', target: previouslyFocused, related: null },
      { type: 'focusin', target: el('BUTTON', {}, zoneRoot), related: null },
      { type: 'focusout', target: el('BUTTON', {}, zoneRoot), related: null }
    )
    expect(s.zone).toBeNull()
  })

  test('mousedown 在區域外：清除，且 focusout 不會復活', () => {
    const s = seq(
      { type: 'mousedown', target: card, related: null },
      { type: 'mousedown', target: outside, related: null },
      { type: 'focusout', target: previouslyFocused, related: null }
    )
    expect(s.zone).toBeNull()
  })
})
