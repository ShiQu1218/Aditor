import { describe, expect, test } from 'vitest'
import { resolveCardActivation, resolveLibraryEscape } from './cardLogic'
import { attachKeymap, type KeymapState } from '../hooks/useShortcuts'

describe('resolveCardActivation', () => {
  test('done card opens', () => {
    expect(resolveCardActivation({ status: 'done' }, 'idle')).toBe('open')
  })
  test('analyzing and queued pending show the blocked toast, never open', () => {
    expect(resolveCardActivation({ status: 'analyzing' }, 'analyzing')).toBe('toast-blocked')
    expect(resolveCardActivation({ status: 'pending' }, 'queued')).toBe('toast-blocked')
  })
  test('pending that is not queued shows the not-analyzed toast', () => {
    expect(resolveCardActivation({ status: 'pending' }, 'idle')).toBe('toast-not-analyzed')
  })
  test('error card does nothing', () => {
    expect(resolveCardActivation({ status: 'error' }, 'idle')).toBe('none')
  })
})

describe('resolveLibraryEscape', () => {
  test('open menu wins: closes only the menu even with a query', () => {
    expect(resolveLibraryEscape({ menuOpen: true, query: 'abc' })).toBe('close-menu')
  })
  test('no menu: clears the query', () => {
    expect(resolveLibraryEscape({ menuOpen: false, query: 'abc' })).toBe('clear-query')
  })
  test('nothing open: no action', () => {
    expect(resolveLibraryEscape({ menuOpen: false, query: '' })).toBe('none')
  })
})

/** 以最小的假 window 驗證 keymap 層：Esc → closeOverlay → resolveLibraryEscape 的整條路徑 */
function harness(menuOpen: boolean, query: string) {
  const log: string[] = []
  let listener: ((e: KeyboardEvent) => void) | null = null
  const target = {
    addEventListener: (type: string, fn: unknown) => {
      if (type === 'keydown') listener = fn as (e: KeyboardEvent) => void
    },
    removeEventListener: () => undefined
  }
  const state: KeymapState = {
    screen: 'library',
    mode: 'source',
    overlayOpen: false,
    handlers: {
      closeOverlay: () => {
        const a = resolveLibraryEscape({ menuOpen, query })
        if (a === 'close-menu') log.push('menu')
        else if (a === 'clear-query') log.push('query')
      }
    }
  }
  attachKeymap(target, () => state)
  const press = (over: Record<string, unknown>): void =>
    listener?.({
      key: 'Escape',
      code: 'Escape',
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      repeat: false,
      defaultPrevented: false,
      target: null,
      preventDefault: () => undefined,
      ...over
    } as unknown as KeyboardEvent)
  return { log, press }
}

describe('library Esc through the keymap', () => {
  test('Esc during IME composition does nothing', () => {
    const h = harness(false, '搜')
    h.press({ isComposing: true })
    h.press({ keyCode: 229 })
    expect(h.log).toEqual([])
  })
  test('Esc with a menu open closes only the menu', () => {
    const h = harness(true, 'abc')
    h.press({})
    expect(h.log).toEqual(['menu'])
  })
  test('Esc with no menu clears the search', () => {
    const h = harness(false, 'abc')
    h.press({})
    expect(h.log).toEqual(['query'])
  })
})
