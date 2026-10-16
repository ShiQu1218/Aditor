// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { activateFocusTrap, focusablesIn, nextTrapIndex } from './focusTrap'

describe('nextTrapIndex (pure)', () => {
  test('Tab cycles forward and wraps; Shift+Tab backward', () => {
    expect(nextTrapIndex(3, 0, false)).toBe(1)
    expect(nextTrapIndex(3, 2, false)).toBe(0)
    expect(nextTrapIndex(3, 0, true)).toBe(2)
    expect(nextTrapIndex(3, -1, false)).toBe(0)
    expect(nextTrapIndex(3, -1, true)).toBe(2)
    expect(nextTrapIndex(0, -1, false)).toBe(-1)
  })
})

function key(target: Element | Window, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(e)
  return e
}

describe('activateFocusTrap (jsdom, real keyboard events)', () => {
  let trigger: HTMLButtonElement
  let box: HTMLDivElement
  let a: HTMLButtonElement
  let b: HTMLButtonElement
  let c: HTMLInputElement
  let off: (() => void) | null = null

  beforeEach(() => {
    document.body.innerHTML = `
      <button id="trigger">open</button>
      <button id="outside">outside</button>
      <div id="box" role="dialog" aria-modal="true" aria-label="dlg">
        <button id="a">A</button>
        <button id="gone" disabled>disabled</button>
        <button id="b">B</button>
        <input id="c" />
      </div>`
    trigger = document.getElementById('trigger') as HTMLButtonElement
    box = document.getElementById('box') as HTMLDivElement
    a = document.getElementById('a') as HTMLButtonElement
    b = document.getElementById('b') as HTMLButtonElement
    c = document.getElementById('c') as HTMLInputElement
    trigger.focus()
  })
  afterEach(() => {
    off?.()
    off = null
    document.body.innerHTML = ''
  })

  test('focusablesIn skips disabled controls', () => {
    expect(focusablesIn(box).map((e) => e.id)).toEqual(['a', 'b', 'c'])
  })

  test('moves focus into the dialog (first control) on activation', () => {
    off = activateFocusTrap(box, {})
    expect(document.activeElement).toBe(a)
  })

  test('initialFocus override and container fallback when nothing is focusable', () => {
    off = activateFocusTrap(box, { initialFocus: b })
    expect(document.activeElement).toBe(b)
    off()
    trigger.focus()
    const empty = document.createElement('div')
    document.body.appendChild(empty)
    off = activateFocusTrap(empty, {})
    expect(document.activeElement).toBe(empty)
    expect(empty.getAttribute('tabindex')).toBe('-1')
  })

  test('Tab cycles A -> B -> C -> A and Shift+Tab goes back (default prevented)', () => {
    off = activateFocusTrap(box, {})
    expect(key(a, 'Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(b)
    key(b, 'Tab')
    expect(document.activeElement).toBe(c)
    key(c, 'Tab')
    expect(document.activeElement).toBe(a)
    key(a, 'Tab', { shiftKey: true })
    expect(document.activeElement).toBe(c)
  })

  test('Tab from an element outside the dialog is pulled back inside', () => {
    off = activateFocusTrap(box, {})
    ;(document.getElementById('outside') as HTMLElement).focus()
    key(document.activeElement as Element, 'Tab')
    expect(box.contains(document.activeElement)).toBe(true)
  })

  test('Esc calls onEscape once and stops it from reaching other (global keymap) listeners', () => {
    const onEscape = vi.fn()
    const global = vi.fn()
    window.addEventListener('keydown', global)
    off = activateFocusTrap(box, { onEscape })
    const e = key(a, 'Escape')
    expect(onEscape).toHaveBeenCalledTimes(1)
    expect(e.defaultPrevented).toBe(true)
    expect(global).not.toHaveBeenCalled()
    window.removeEventListener('keydown', global)
  })

  test('Esc during IME composition is ignored', () => {
    const onEscape = vi.fn()
    off = activateFocusTrap(box, { onEscape })
    key(c, 'Escape', { isComposing: true })
    expect(onEscape).not.toHaveBeenCalled()
  })

  test('deactivation restores focus to the trigger and stops trapping', () => {
    off = activateFocusTrap(box, {})
    expect(document.activeElement).toBe(a)
    off()
    off = null
    expect(document.activeElement).toBe(trigger)
    const e = key(trigger, 'Tab')
    expect(e.defaultPrevented).toBe(false)
  })

  test('radio groups count as one tab stop (the checked radio)', () => {
    box.insertAdjacentHTML(
      'beforeend',
      '<input type="radio" name="g" id="r1"><input type="radio" name="g" id="r2" checked><input type="radio" name="g" id="r3">'
    )
    expect(focusablesIn(box).map((e) => e.id)).toEqual(['a', 'b', 'c', 'r2'])
  })

  test('deactivation does not steal focus when the user already moved it elsewhere', () => {
    off = activateFocusTrap(box, {})
    const outside = document.getElementById('outside') as HTMLElement
    outside.focus()
    off()
    off = null
    expect(document.activeElement).toBe(outside)
  })

  test('deactivation does not steal focus when the trigger was removed', () => {
    off = activateFocusTrap(box, {})
    trigger.remove()
    off()
    off = null
    expect(document.activeElement).not.toBe(trigger)
  })
})
