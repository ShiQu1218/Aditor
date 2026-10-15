import { describe, expect, test } from 'vitest'
import {
  getCurrentZone,
  setCurrentZone,
  zoneAfterEvent,
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
    setCurrentZone('ev', el('DIV', { 'data-zone': 'ev' }))
    expect(getCurrentZone()).toBe('ev')
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

  test('zoneAfterEvent：focusin 進入區域時記錄元素', () => {
    const target = el('DIV', { 'data-zone': 'src' })
    const next = zoneAfterEvent({ type: 'focusin', target, related: null })
    expect(next.zone).toBe('src')
    expect(next.el).toBe(target)
  })

  test('zoneAfterEvent：mousedown 在區域外清除記錄', () => {
    const button = el('BUTTON')
    const next = zoneAfterEvent({ type: 'mousedown', target: button, related: null })
    expect(next.zone).toBeNull()
    expect(next.el).toBeNull()
  })

  test('zoneAfterEvent：focusout 到區域外（relatedTarget 為 null）時清除，避免殘留', () => {
    const next = zoneAfterEvent({ type: 'focusout', target: el('DIV', { 'data-zone': 'proj' }), related: null })
    expect(next.zone).toBeNull()
  })

  test('zoneAfterEvent：焦點在區域之間移動時記錄新區域', () => {
    const to = el('LI', { 'data-zone': 'ev' })
    const next = zoneAfterEvent({ type: 'focusout', target: el('DIV', { 'data-zone': 'hl' }), related: to })
    expect(next.zone).toBe('ev')
    expect(next.el).toBe(to)
    expect(zoneOf(to)).toBe('ev')
  })
})
