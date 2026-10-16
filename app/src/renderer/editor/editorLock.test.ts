import { afterEach, describe, expect, test } from 'vitest'
import { applyInert, isEditorLocked, setEditorLocked, subscribeEditorLock, LOCK_SELECTOR } from './editorLock'

function fakeEl() {
  const attrs = new Map<string, string>()
  return {
    attrs,
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    removeAttribute: (k: string) => void attrs.delete(k)
  }
}

afterEach(() => setEditorLocked(false))

describe('editor lock', () => {
  test('applyInert sets and clears inert on every lock target', () => {
    const els = [fakeEl(), fakeEl()]
    const root = { querySelectorAll: (sel: string) => (sel === LOCK_SELECTOR ? els : []) }
    applyInert(root as never, true)
    expect(els.every((e) => e.attrs.has('inert'))).toBe(true)
    expect(els.every((e) => e.attrs.get('aria-disabled') === 'true')).toBe(true)
    applyInert(root as never, false)
    expect(els.every((e) => !e.attrs.has('inert') && !e.attrs.has('aria-disabled'))).toBe(true)
  })

  test('store flag + subscribers', () => {
    let n = 0
    const off = subscribeEditorLock(() => n++)
    expect(isEditorLocked()).toBe(false)
    setEditorLocked(true)
    expect(isEditorLocked()).toBe(true)
    setEditorLocked(true) // 重複設定不通知
    expect(n).toBe(1)
    off()
    setEditorLocked(false)
    expect(n).toBe(1)
  })
})
