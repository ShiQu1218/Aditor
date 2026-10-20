import { describe, expect, test, vi } from 'vitest'
import { attachKeymap, createKeyDownHandler, type KeymapState } from '../hooks/useShortcuts'
import { COMMANDS, KEY_TABLE, resolveKey, type KeyCtx, type KeyInput } from './keymap'
import { targetKindOf, zoneOf, type ElementLike } from './focusZone'

function k(key: string, mods: Partial<KeyInput> = {}): KeyInput {
  const code = key === ' ' ? 'Space' : key.length === 1 ? `Key${key.toUpperCase()}` : key
  return {
    key,
    code,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    ...mods
  }
}
const ctx = (o: Partial<KeyCtx> = {}): KeyCtx => ({
  screen: 'studio',
  zone: null,
  target: 'none',
  mode: 'source',
  overlayOpen: false,
  ...o
})

describe('resolveKey matrix', () => {
  test('Enter on native button is not handled (null)', () => {
    for (const zone of ['src', 'hl', 'proj', null] as const) {
      expect(resolveKey(k('Enter'), ctx({ zone, target: 'native' }))).toBeNull()
    }
  })

  test('Enter: hl→acceptSuggestion, proj→playItem, src→null', () => {
    expect(resolveKey(k('Enter'), ctx({ zone: 'hl' }))).toBe('acceptSuggestion')
    expect(resolveKey(k('Enter'), ctx({ zone: 'proj' }))).toBe('playItem')
    expect(resolveKey(k('Enter'), ctx({ zone: 'src' }))).toBeNull()
  })

  test('Delete by zone', () => {
    expect(resolveKey(k('Delete'), ctx({ zone: 'hl' }))).toBe('skipSuggestion')
    expect(resolveKey(k('Delete'), ctx({ zone: 'proj' }))).toBe('deleteProjectItem')
    expect(resolveKey(k('Delete'), ctx({ zone: 'src' }))).toBeNull()
    expect(resolveKey(k('Delete'), ctx({ zone: 'hl', target: 'native' }))).toBeNull()
    expect(resolveKey(k('Delete'), ctx({ zone: 'hl', target: 'text' }))).toBeNull()
  })

test('Shift combinations take precedence over unshifted keys: redo / openExport', () => {
    expect(resolveKey(k('z', { ctrlKey: true, shiftKey: true }), ctx())).toBe('redo')
    expect(resolveKey(k('Z', { ctrlKey: true, shiftKey: true }), ctx())).toBe('redo')
    expect(resolveKey(k('z', { ctrlKey: true }), ctx())).toBe('undo')
    expect(resolveKey(k('y', { ctrlKey: true }), ctx())).toBe('redo')
    expect(resolveKey(k('E', { ctrlKey: true, shiftKey: true }), ctx())).toBe('openExport')
    expect(resolveKey(k('e', { ctrlKey: true }), ctx())).toBe('addAllToProject')
    expect(resolveKey(k('z', { metaKey: true, shiftKey: true }), ctx())).toBe('redo')
  })

  test('Ctrl+Q → quickOrSplit in both modes', () => {
    expect(resolveKey(k('q', { ctrlKey: true }), ctx({ mode: 'source' }))).toBe('quickOrSplit')
    expect(resolveKey(k('q', { ctrlKey: true }), ctx({ mode: 'project' }))).toBe('quickOrSplit')
    expect(resolveKey(k('q', { ctrlKey: true }), ctx({ target: 'native' }))).toBe('quickOrSplit')
  })

  test('B is always blade mode (never split); modifiers, controls and overlays keep their own behavior', () => {
    expect(resolveKey(k('b'), ctx({ mode: 'source' }))).toBe('blade')
    expect(resolveKey(k('b'), ctx({ mode: 'project' }))).toBe('blade')
    expect(resolveKey(k('b', { repeat: true }), ctx())).toBeNull()
    expect(resolveKey(k('b'), ctx({ target: 'text' }))).toBeNull()
    expect(resolveKey(k('b'), ctx({ target: 'native' }))).toBeNull()
    expect(resolveKey(k('b'), ctx({ overlayOpen: true }))).toBeNull()
    expect(resolveKey(k('b', { ctrlKey: true }), ctx())).toBe('toggleAside')
  })

  test('Alt+ArrowLeft/Right only in proj zone', () => {
    expect(resolveKey(k('ArrowLeft', { altKey: true }), ctx({ zone: 'proj' }))).toBe('moveItemLeft')
    expect(resolveKey(k('ArrowRight', { altKey: true }), ctx({ zone: 'proj' }))).toBe('moveItemRight')
    expect(resolveKey(k('ArrowLeft', { altKey: true }), ctx({ zone: 'proj', target: 'native' }))).toBe(
      'moveItemLeft'
    )
    for (const zone of ['src', 'hl', null] as const) {
      expect(resolveKey(k('ArrowLeft', { altKey: true }), ctx({ zone }))).toBeNull()
      expect(resolveKey(k('ArrowRight', { altKey: true }), ctx({ zone }))).toBeNull()
    }
  })

  test('Ctrl+D duplicate only in proj zone (studio)', () => {
    expect(resolveKey(k('d', { ctrlKey: true }), ctx({ zone: 'proj' }))).toBe('duplicateItem')
    expect(resolveKey(k('d', { ctrlKey: true }), ctx({ zone: 'src' }))).toBeNull()
  })

  test('text input keeps plain keys; removed Ctrl+S is inert and Ctrl+Z still works', () => {
    const t = ctx({ target: 'text', zone: 'src' })
    for (const key of [' ', 's', 'm', '[', ']', '?', 'Enter', 'Delete', 'ArrowLeft', 'ArrowRight']) {
      expect(resolveKey(k(key), t)).toBeNull()
    }
    expect(resolveKey(k('s', { ctrlKey: true }), t)).toBeNull()
    expect(resolveKey(k('z', { ctrlKey: true }), t)).toBe('undo')
  })

  test('Space on buttons and elsewhere returns play', () => {
    expect(resolveKey(k(' '), ctx({ target: 'native' }))).toBe('play')
    for (const zone of ['src', 'hl', 'proj', null] as const) {
      expect(resolveKey(k(' '), ctx({ zone }))).toBe('play')
    }
  })

  test('? opens shortcuts except in text input', () => {
    expect(resolveKey(k('?', { shiftKey: true }), ctx())).toBe('showShortcuts')
    expect(resolveKey(k('?', { shiftKey: true }), ctx({ screen: 'library' }))).toBe('showShortcuts')
    expect(resolveKey(k('?', { shiftKey: true }), ctx({ target: 'text' }))).toBeNull()
  })

  test('Esc: overlay→closeOverlay, project mode→backToSource', () => {
    expect(resolveKey(k('Escape'), ctx({ mode: 'project' }))).toBe('backToSource')
    expect(resolveKey(k('Escape'), ctx({ mode: 'project', overlayOpen: true }))).toBe('closeOverlay')
    expect(resolveKey(k('Escape'), ctx({ mode: 'source', overlayOpen: true }))).toBe('closeOverlay')
    expect(
      resolveKey(k('Escape'), ctx({ mode: 'project', target: 'native', overlayOpen: true }))
    ).toBe('closeOverlay')
    expect(resolveKey(k('Escape'), ctx({ mode: 'source' }))).toBe('closeOverlay') // Clear the selection.
  })

  test('library screen: Ctrl+F → focusSearch, Ctrl+D → toggleFavoriteFilter', () => {
    const lib = ctx({ screen: 'library' })
    expect(resolveKey(k('f', { ctrlKey: true }), lib)).toBe('focusSearch')
    expect(resolveKey(k('d', { ctrlKey: true }), lib)).toBe('toggleFavoriteFilter')
    expect(resolveKey(k('f', { ctrlKey: true }), ctx({ screen: 'settings' }))).toBe('focusSearch')
    expect(resolveKey(k('f', { ctrlKey: true }), ctx())).toBeNull()
    expect(resolveKey(k(' '), lib)).toBeNull()
    expect(resolveKey(k('q', { ctrlKey: true }), lib)).toBeNull()
  })

  test('library screen: Esc clears the search via closeOverlay', () => {
    const lib = ctx({ screen: 'library' })
    expect(resolveKey(k('Escape'), lib)).toBe('closeOverlay')
    // Clear the selection when an input (such as search) is focused; do not handle while composing text.
    expect(resolveKey(k('Escape'), { ...lib, target: 'text' })).toBe('closeOverlay')
    expect(resolveKey(k('Escape', { isComposing: true }), lib)).toBeNull()
  })

  test('settings screen: Esc clears the search via closeOverlay (IME-safe; native controls keep Esc)', () => {
    const set = ctx({ screen: 'settings' })
    expect(resolveKey(k('Escape'), set)).toBe('closeOverlay')
    expect(resolveKey(k('Escape'), { ...set, target: 'text' })).toBe('closeOverlay')
    expect(resolveKey(k('Escape', { isComposing: true }), { ...set, target: 'text' })).toBeNull()
    expect(resolveKey(k('Escape', { keyCode: 229 }), { ...set, target: 'text' })).toBeNull()
    // Let native controls such as dropdowns handle Escape themselves (to close the menu).
    expect(resolveKey(k('Escape'), { ...set, target: 'native' })).toBeNull()
  })

test('Remaining key mappings', () => {
    expect(resolveKey(k('s'), ctx())).toBe('speed')
    expect(resolveKey(k('m'), ctx({ target: 'native' }))).toBe('addEvent')
    expect(resolveKey(k('['), ctx())).toBe('setStart')
    expect(resolveKey(k(']'), ctx())).toBe('setEnd')
    expect(resolveKey(k('ArrowLeft'), ctx({ zone: 'src' }))).toBe('seekBack')
    expect(resolveKey(k('ArrowRight'), ctx({ zone: 'src' }))).toBe('seekFwd')
    expect(resolveKey(k('ArrowRight'), ctx({ zone: 'src', target: 'native' }))).toBeNull()
    expect(resolveKey(k('ArrowRight'), ctx({ zone: 'proj' }))).toBe('selectNextItem')
    expect(resolveKey(k('ArrowLeft'), ctx({ zone: 'proj' }))).toBe('selectPrevItem')
    expect(resolveKey(k('ArrowDown'), ctx({ zone: 'hl' }))).toBe('listNext')
    expect(resolveKey(k('ArrowUp'), ctx({ zone: 'hl' }))).toBe('listPrev')
    expect(resolveKey(k('ArrowUp'), ctx({ zone: 'src' }))).toBeNull()
    expect(resolveKey(k('ArrowLeft'), ctx({ zone: 'hl' }))).toBeNull()
    expect(resolveKey(k('ArrowDown'), ctx({ zone: 'hl', target: 'native' }))).toBeNull()
    expect(resolveKey(k('ArrowRight', { shiftKey: true }), ctx({ zone: 'proj' }))).toBeNull()
    expect(resolveKey(k('ArrowLeft', { ctrlKey: true }), ctx({ zone: 'hl' }))).toBe('prevEvent')
    expect(resolveKey(k('ArrowRight', { ctrlKey: true }), ctx({ target: 'native' }))).toBe('nextEvent')
    expect(resolveKey(k('=', { ctrlKey: true }), ctx())).toBe('zoomIn')
    expect(resolveKey(k('+', { ctrlKey: true, shiftKey: true }), ctx())).toBe('zoomIn')
    expect(resolveKey(k('-', { ctrlKey: true }), ctx())).toBe('zoomOut')
    expect(resolveKey(k('0', { ctrlKey: true }), ctx())).toBe('zoomReset')
    expect(resolveKey(k('m', { ctrlKey: true }), ctx())).toBeNull()
    expect(resolveKey(k('b', { ctrlKey: true }), ctx())).toBe('toggleAside')
    expect(resolveKey(k('s', { ctrlKey: true }), ctx())).toBeNull()
    expect(resolveKey(k('x', { ctrlKey: true }), ctx())).toBeNull()
  })

test('Holding a key (repeat) does not retrigger toggle commands, but arrow keys repeat', () => {
    expect(resolveKey(k(' ', { repeat: true }), ctx())).toBeNull()
    expect(resolveKey(k('m', { repeat: true }), ctx())).toBeNull()
    expect(resolveKey(k('Enter', { repeat: true }), ctx({ zone: 'hl' }))).toBeNull()
    expect(resolveKey(k('ArrowRight', { repeat: true }), ctx({ zone: 'src' }))).toBe('seekFwd')
  })
})

describe('focusToast (Alt+T focuses the latest Toast action)', () => {
  test('works on every screen and inside text inputs (Alt chords are never plain typing)', () => {
    for (const screen of ['library', 'studio', 'settings'] as const) {
      expect(resolveKey(k('t', { altKey: true }), ctx({ screen }))).toBe('focusToast')
      expect(resolveKey(k('T', { altKey: true }), ctx({ screen, target: 'text' }))).toBe('focusToast')
    }
  })
  test('not with Shift/Ctrl, not on repeat, and a plain "t" is nothing', () => {
    expect(resolveKey(k('t', { altKey: true, shiftKey: true }), ctx())).toBeNull()
    expect(resolveKey(k('t', { altKey: true, ctrlKey: true }), ctx())).toBeNull()
    expect(resolveKey(k('t', { altKey: true, repeat: true }), ctx())).toBeNull()
    expect(resolveKey(k('t'), ctx())).toBeNull()
  })
  test('a studio overlay still blocks it (only Esc is live under a dialog)', () => {
    expect(resolveKey(k('t', { altKey: true }), ctx({ overlayOpen: true }))).toBeNull()
  })
})

describe('overlayOpen blocks the studio underneath', () => {
  const open = (o: Partial<KeyCtx> = {}): KeyCtx => ctx({ overlayOpen: true, ...o })
  test('studio: nothing but Esc resolves while an overlay is open', () => {
    expect(resolveKey(k(' '), open())).toBeNull()
    expect(resolveKey(k('q', { ctrlKey: true }), open())).toBeNull()
    expect(resolveKey(k('z', { ctrlKey: true }), open())).toBeNull()
    expect(resolveKey(k('ArrowLeft'), open({ zone: 'src' }))).toBeNull()
    expect(resolveKey(k('ArrowLeft', { ctrlKey: true }), open())).toBeNull()
    expect(resolveKey(k('m'), open())).toBeNull()
    expect(resolveKey(k('Enter'), open({ zone: 'hl' }))).toBeNull()
    expect(resolveKey(k('?', { shiftKey: true }), open())).toBeNull()
  })
  test('Esc with an overlay open closes the overlay (never backToSource)', () => {
    expect(resolveKey(k('Escape'), open({ mode: 'project' }))).toBe('closeOverlay')
    expect(resolveKey(k('Escape'), open({ mode: 'project', target: 'text' }))).toBe('closeOverlay')
  })
})

describe('IME / AltGr / Esc / Alt / repeat', () => {
test('Returns null during IME composition', () => {
    const c = ctx({ zone: 'src', mode: 'project' })
    expect(resolveKey(k('Escape', { isComposing: true }), c)).toBeNull()
    expect(resolveKey(k(' ', { isComposing: true }), c)).toBeNull()
    expect(resolveKey(k('z', { ctrlKey: true, isComposing: true }), c)).toBeNull()
    expect(resolveKey(k('s', { isComposing: true }), c)).toBeNull()
    expect(resolveKey(k('Process', { keyCode: 229 }), c)).toBeNull()
    expect(resolveKey(k('s', { keyCode: 229 }), c)).toBeNull()
    expect(resolveKey(k('s', { keyCode: 83 }), c)).toBe('speed')
  })
test('Esc does not return to source from an input or native control; it only closes an overlay', () => {
    for (const target of ['text', 'native'] as const) {
      expect(resolveKey(k('Escape'), ctx({ mode: 'project', target }))).toBeNull()
      expect(resolveKey(k('Escape'), ctx({ mode: 'source', target }))).toBeNull()
      expect(resolveKey(k('Escape'), ctx({ mode: 'project', target, overlayOpen: true }))).toBe(
        'closeOverlay'
      )
    }
  })
test('AltGr (ctrl+alt) does not trigger Ctrl or bracket shortcuts', () => {
    const c = ctx({ zone: 'proj' })
    const ag = { ctrlKey: true, altKey: true }
    expect(resolveKey(k('q', ag), c)).toBeNull()
    expect(resolveKey(k('[', ag), c)).toBeNull()
    expect(resolveKey(k(']', ag), c)).toBeNull()
    expect(resolveKey(k('ArrowLeft', ag), c)).toBeNull()
    expect(resolveKey(k('s', { altKey: true }), c)).toBeNull()
    expect(resolveKey(k('[', { altKey: true }), c)).toBeNull()
  })
test('Alt+←/→ works in the project zone even in text fields and native controls', () => {
    for (const target of ['text', 'native', 'none'] as const) {
      expect(resolveKey(k('ArrowLeft', { altKey: true }), ctx({ zone: 'proj', target }))).toBe('moveItemLeft')
      expect(resolveKey(k('ArrowRight', { altKey: true }), ctx({ zone: 'proj', target }))).toBe('moveItemRight')
    }
    expect(resolveKey(k('ArrowLeft', { altKey: true }), ctx({ zone: 'hl', target: 'text' }))).toBeNull()
  })
test('Only repeatable commands pass through on key repeat', () => {
    const r = { repeat: true }
    expect(resolveKey(k('z', { ctrlKey: true, ...r }), ctx())).toBe('undo')
    expect(resolveKey(k('ArrowLeft', { ctrlKey: true, ...r }), ctx())).toBe('prevEvent')
    expect(resolveKey(k('=', { ctrlKey: true, ...r }), ctx())).toBe('zoomIn')
    expect(resolveKey(k('ArrowLeft', { altKey: true, ...r }), ctx({ zone: 'proj' }))).toBe('moveItemLeft')
    expect(resolveKey(k('ArrowRight', r), ctx({ zone: 'proj' }))).toBe('selectNextItem')
    expect(resolveKey(k('ArrowDown', r), ctx({ zone: 'hl' }))).toBe('listNext')
    expect(resolveKey(k('q', { ctrlKey: true, ...r }), ctx())).toBeNull()
    expect(resolveKey(k('s', { ctrlKey: true, ...r }), ctx())).toBeNull()
    expect(resolveKey(k('e', { ctrlKey: true, shiftKey: true, ...r }), ctx())).toBeNull()
    expect(resolveKey(k('Escape', r), ctx({ mode: 'project' }))).toBeNull()
    expect(resolveKey(k('['), ctx())).toBe('setStart')
    expect(resolveKey(k('[', r), ctx())).toBeNull()
  })
})

describe('KEY_TABLE', () => {
  const KEYMAP: Record<string, string> = {
    '←': 'ArrowLeft',
    '→': 'ArrowRight',
    '↑': 'ArrowUp',
    '↓': 'ArrowDown',
    Esc: 'Escape',
    Space: ' '
  }
  const parse = (keys: string): KeyInput | null => {
    const one = keys.split(' ／ ')[0].trim()
    if (one.includes('滾輪')) return null
    const idx = one.lastIndexOf('+', one.length - 2) // The final segment may be '+'.
    const mods = idx >= 0 ? one.slice(0, idx).split('+') : []
    const key = idx >= 0 ? one.slice(idx + 1) : one
    return k(KEYMAP[key] ?? key, {
      ctrlKey: mods.includes('Ctrl'),
      altKey: mods.includes('Alt'),
      shiftKey: mods.includes('Shift')
    })
  }
  const zoneOfScope = (scope: string): KeyCtx['zone'] => {
    if (scope.includes('來源')) return 'src'
    if (scope.includes('精華')) return 'hl'
    if (scope.includes('事件')) return null
    if (scope.includes('專案軌')) return 'proj'
    return null
  }
test('KEY_TABLE keys match resolveKey (the first key combination in each row)', () => {
    for (const r of KEY_TABLE) {
      const input = parse(r.keys)
      if (!input) continue
      const screen: KeyCtx['screen'] = r.scope.includes('影片庫')
        ? 'library'
        : r.scope.includes('設定')
          ? 'settings'
          : 'studio'
      const mode: KeyCtx['mode'] = r.command === 'backToSource' ? 'project' : 'source'
      const got = resolveKey(input, ctx({ screen, mode, zone: zoneOfScope(r.scope) }))
      expect([r.command, r.keys, got]).toEqual([r.command, r.keys, r.command])
    }
  })
test('KEY_TABLE alternate key combination (Ctrl+Shift+Z for redo)', () => {
    const redo = KEY_TABLE.find((r) => r.command === 'redo')!
    expect(redo.keys).toContain('Ctrl+Shift+Z')
    expect(resolveKey(k('z', { ctrlKey: true, shiftKey: true }), ctx())).toBe('redo')
  })
  test('KEY_TABLE covers every Command exactly once', () => {
    const cmds = KEY_TABLE.map((r) => r.command)
    expect(new Set(cmds).size).toBe(cmds.length)
    expect([...cmds].sort()).toEqual([...COMMANDS].sort())
    for (const r of KEY_TABLE) {
      expect(r.keys.length).toBeGreaterThan(0)
      expect(r.label.length).toBeGreaterThan(0)
      expect(r.scope.length).toBeGreaterThan(0)
    }
  })
})

describe('useKeymap core (createKeyDownHandler / attachKeymap)', () => {
  const evt = (key: string, extra: Record<string, unknown> = {}) => {
    const e = {
      ...k(key),
      defaultPrevented: false,
      target: null,
      preventDefault: vi.fn(() => {
        e.defaultPrevented = true
      }),
      ...extra
    }
    return e as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> }
  }
  const state = (handlers: KeymapState['handlers']): KeymapState => ({
    handlers,
    screen: 'studio',
    mode: 'source',
    overlayOpen: false
  })

test('Calls preventDefault only when a command and handler are present', () => {
    const play = vi.fn()
    const h = createKeyDownHandler(() => state({ play }))
    const e1 = evt(' ')
    h(e1)
    expect(play).toHaveBeenCalledTimes(1)
    expect(e1.preventDefault).toHaveBeenCalled()
    const e2 = evt('s') // No handler for speed.
    h(e2)
    expect(e2.preventDefault).not.toHaveBeenCalled()
    const e3 = evt('x') // No command.
    h(e3)
    expect(e3.preventDefault).not.toHaveBeenCalled()
  })
test('Skips events that are already defaultPrevented or during IME composition', () => {
    const play = vi.fn()
    const h = createKeyDownHandler(() => state({ play }))
    h(evt(' ', { defaultPrevented: true }))
    h(evt(' ', { isComposing: true }))
    h(evt(' ', { keyCode: 229 }))
    expect(play).not.toHaveBeenCalled()
  })
test('attachKeymap stops triggering after cleanup and uses the latest handlers', () => {
    const listeners = new Set<(e: KeyboardEvent) => void>()
    const fakeWin = {
      addEventListener: (_: string, fn: (e: KeyboardEvent) => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: (e: KeyboardEvent) => void) => listeners.delete(fn)
    } as unknown as Window
    const first = vi.fn()
    const second = vi.fn()
    let cur = state({ play: first })
    const detach = attachKeymap(fakeWin, () => cur)
    expect(listeners.size).toBe(2)
    cur = state({ play: second })
    ;[...listeners].forEach((fn) => fn(evt(' ')))
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    detach()
    expect(listeners.size).toBe(0)
  })
})

describe('focusZone helpers', () => {
  const el = (tagName: string, extra: Record<string, string> = {}, parent: unknown = null) => ({
    tagName,
    parentElement: parent as ElementLike | null,
    getAttribute: (n: string) => extra[n] ?? null
  })
  test('targetKindOf', () => {
    expect(targetKindOf(el('BUTTON'))).toBe('native')
    expect(targetKindOf(el('SELECT'))).toBe('native')
    expect(targetKindOf(el('A'))).toBe('native')
    expect(targetKindOf(el('DIV', { role: 'slider' }))).toBe('native')
    expect(targetKindOf(el('INPUT', { type: 'checkbox' }))).toBe('native')
    expect(targetKindOf(el('INPUT', { type: 'range' }))).toBe('native')
    expect(targetKindOf(el('INPUT', { type: 'text' }))).toBe('text')
    expect(targetKindOf(el('INPUT', { type: 'number' }))).toBe('text')
    expect(targetKindOf(el('INPUT'))).toBe('text')
    expect(targetKindOf(el('TEXTAREA'))).toBe('text')
    expect(targetKindOf(el('DIV'))).toBe('none')
    expect(targetKindOf(null)).toBe('none')
  })
test('targetKindOf: contenteditable and ARIA roles', () => {
    expect(targetKindOf(el('DIV', { contenteditable: 'true' }))).toBe('text')
    expect(targetKindOf(el('DIV', { contenteditable: '' }))).toBe('text')
    expect(targetKindOf(el('DIV', { contenteditable: 'plaintext-only' }))).toBe('text')
    expect(targetKindOf(el('DIV', { contenteditable: 'false' }))).toBe('none')
    expect(targetKindOf(el('SPAN', {}, el('DIV', { contenteditable: 'true' })))).toBe('text')
    expect(targetKindOf({ ...el('SPAN'), isContentEditable: true })).toBe('text')
    expect(
      targetKindOf({ ...el('SPAN', { contenteditable: 'true' }), isContentEditable: false })
    ).toBe('none')
    for (const role of ['textbox', 'searchbox', 'combobox', 'spinbutton']) {
      expect(targetKindOf(el('DIV', { role }))).toBe('text')
    }
    for (const role of ['tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'switch', 'button', 'link', 'slider', 'checkbox', 'radio']) {
      expect(targetKindOf(el('DIV', { role }))).toBe('native')
    }
    for (const role of ['option', 'listbox', 'row', 'gridcell', 'listitem']) {
      expect(targetKindOf(el('DIV', { role }))).toBe('none')
    }
  })
  test('zoneOf walks up to data-zone', () => {
    const wrap = el('DIV', { 'data-zone': 'hl' })
    expect(zoneOf(el('DIV', {}, el('SPAN', {}, wrap)))).toBe('hl')
    expect(zoneOf(el('DIV', { 'data-zone': 'bogus' }))).toBeNull()
    expect(zoneOf(null)).toBeNull()
  })
})
