import { describe, expect, test } from 'vitest'
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

describe('resolveKey 矩陣', () => {
  test('Enter on native button is not handled (null)', () => {
    for (const zone of ['src', 'hl', 'ev', 'proj', null] as const) {
      expect(resolveKey(k('Enter'), ctx({ zone, target: 'native' }))).toBeNull()
    }
  })

  test('Enter: hl→acceptSuggestion, ev→null (跳到事件由清單自行處理), proj→playItem, src→null', () => {
    expect(resolveKey(k('Enter'), ctx({ zone: 'hl' }))).toBe('acceptSuggestion')
    expect(resolveKey(k('Enter'), ctx({ zone: 'ev' }))).toBeNull()
    expect(resolveKey(k('Enter'), ctx({ zone: 'proj' }))).toBe('playItem')
    expect(resolveKey(k('Enter'), ctx({ zone: 'src' }))).toBeNull()
  })

  test('Delete by zone', () => {
    expect(resolveKey(k('Delete'), ctx({ zone: 'hl' }))).toBe('skipSuggestion')
    expect(resolveKey(k('Delete'), ctx({ zone: 'ev' }))).toBe('deleteSelectedEvents')
    expect(resolveKey(k('Delete'), ctx({ zone: 'proj' }))).toBe('deleteProjectItem')
    expect(resolveKey(k('Delete'), ctx({ zone: 'src' }))).toBeNull()
    expect(resolveKey(k('Delete'), ctx({ zone: 'hl', target: 'native' }))).toBeNull()
    expect(resolveKey(k('Delete'), ctx({ zone: 'ev', target: 'text' }))).toBeNull()
  })

  test('Shift 組合先於無 Shift：redo / openExport', () => {
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

  test('Alt+ArrowLeft/Right only in proj zone', () => {
    expect(resolveKey(k('ArrowLeft', { altKey: true }), ctx({ zone: 'proj' }))).toBe('moveItemLeft')
    expect(resolveKey(k('ArrowRight', { altKey: true }), ctx({ zone: 'proj' }))).toBe('moveItemRight')
    expect(resolveKey(k('ArrowLeft', { altKey: true }), ctx({ zone: 'proj', target: 'native' }))).toBe(
      'moveItemLeft'
    )
    for (const zone of ['src', 'hl', 'ev', null] as const) {
      expect(resolveKey(k('ArrowLeft', { altKey: true }), ctx({ zone }))).toBeNull()
      expect(resolveKey(k('ArrowRight', { altKey: true }), ctx({ zone }))).toBeNull()
    }
  })

  test('Ctrl+D duplicate only in proj zone (studio)', () => {
    expect(resolveKey(k('d', { ctrlKey: true }), ctx({ zone: 'proj' }))).toBe('duplicateItem')
    expect(resolveKey(k('d', { ctrlKey: true }), ctx({ zone: 'src' }))).toBeNull()
  })

  test('text input swallows plain keys but not Ctrl+S / Ctrl+Z', () => {
    const t = ctx({ target: 'text', zone: 'src' })
    for (const key of [' ', 's', 'm', '[', ']', '?', 'Enter', 'Delete', 'ArrowLeft', 'ArrowRight']) {
      expect(resolveKey(k(key), t)).toBeNull()
    }
    expect(resolveKey(k('s', { ctrlKey: true }), t)).toBe('saveProjectFile')
    expect(resolveKey(k('z', { ctrlKey: true }), t)).toBe('undo')
  })

  test('Space on button returns null; Space elsewhere returns play', () => {
    expect(resolveKey(k(' '), ctx({ target: 'native' }))).toBeNull()
    for (const zone of ['src', 'hl', 'ev', 'proj', null] as const) {
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
    expect(resolveKey(k('Escape'), ctx({ mode: 'source' }))).toBe('closeOverlay') // 清除選取
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

  test('其餘格子', () => {
    expect(resolveKey(k('s'), ctx())).toBe('speed')
    expect(resolveKey(k('m'), ctx({ target: 'native' }))).toBe('addEvent')
    expect(resolveKey(k('['), ctx())).toBe('setStart')
    expect(resolveKey(k(']'), ctx())).toBe('setEnd')
    expect(resolveKey(k('ArrowLeft'), ctx({ zone: 'src' }))).toBe('seekBack')
    expect(resolveKey(k('ArrowRight'), ctx({ zone: 'src' }))).toBe('seekFwd')
    expect(resolveKey(k('ArrowRight'), ctx({ zone: 'src', target: 'native' }))).toBeNull()
    expect(resolveKey(k('ArrowRight'), ctx({ zone: 'proj' }))).toBeNull()
    expect(resolveKey(k('ArrowDown'), ctx({ zone: 'ev' }))).toBeNull()
    expect(resolveKey(k('ArrowLeft', { ctrlKey: true }), ctx({ zone: 'ev' }))).toBe('prevEvent')
    expect(resolveKey(k('ArrowRight', { ctrlKey: true }), ctx({ target: 'native' }))).toBe('nextEvent')
    expect(resolveKey(k('=', { ctrlKey: true }), ctx())).toBe('zoomIn')
    expect(resolveKey(k('+', { ctrlKey: true, shiftKey: true }), ctx())).toBe('zoomIn')
    expect(resolveKey(k('-', { ctrlKey: true }), ctx())).toBe('zoomOut')
    expect(resolveKey(k('0', { ctrlKey: true }), ctx())).toBe('zoomReset')
    expect(resolveKey(k('m', { ctrlKey: true }), ctx())).toBe('supercut')
    expect(resolveKey(k('b', { ctrlKey: true }), ctx())).toBe('toggleAside')
    expect(resolveKey(k('s', { ctrlKey: true }), ctx())).toBe('saveProjectFile')
    expect(resolveKey(k('x', { ctrlKey: true }), ctx())).toBeNull()
  })

  test('長按（repeat）不重複觸發切換類指令，但方向鍵可連續', () => {
    expect(resolveKey(k(' ', { repeat: true }), ctx())).toBeNull()
    expect(resolveKey(k('m', { repeat: true }), ctx())).toBeNull()
    expect(resolveKey(k('Enter', { repeat: true }), ctx({ zone: 'hl' }))).toBeNull()
    expect(resolveKey(k('ArrowRight', { repeat: true }), ctx({ zone: 'src' }))).toBe('seekFwd')
  })
})

describe('KEY_TABLE', () => {
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
  test('zoneOf walks up to data-zone', () => {
    const wrap = el('DIV', { 'data-zone': 'ev' })
    expect(zoneOf(el('DIV', {}, el('SPAN', {}, wrap)))).toBe('ev')
    expect(zoneOf(el('DIV', { 'data-zone': 'bogus' }))).toBeNull()
    expect(zoneOf(null)).toBeNull()
  })
})
