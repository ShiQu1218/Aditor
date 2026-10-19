// Focus trap for dialogs and popovers: pure index helpers plus a reusable DOM activator shared by all dialogs.

/** Return the index to focus after Tab or Shift+Tab; return -1 when nothing is focusable. */
export function nextTrapIndex(count: number, current: number, shift: boolean): number {
  if (count <= 0) return -1
  if (current < 0) return shift ? count - 1 : 0
  return shift ? (current - 1 + count) % count : (current + 1) % count
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Return elements currently focusable with Tab in the container (skip disabled, hidden, and inert subtrees; count only the selected radio in a group, matching browser Tab behavior). */
export function focusablesIn(root: HTMLElement): HTMLElement[] {
  const all = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hidden && el.closest('[inert], [hidden]') === null
  )
  const radios = all.filter((el): el is HTMLInputElement => el instanceof HTMLInputElement && el.type === 'radio' && el.name !== '')
  const groupsWithChecked = new Set(radios.filter((r) => r.checked).map((r) => r.name))
  const seenUnchecked = new Set<string>()
  return all.filter((el) => {
    if (!(el instanceof HTMLInputElement) || el.type !== 'radio' || el.name === '') return true
    if (groupsWithChecked.has(el.name)) return el.checked
    if (seenUnchecked.has(el.name)) return false
    seenUnchecked.add(el.name)
    return true
  })
}

export interface FocusTrapOptions {
  /** Esc: stop propagation after calling this so the global keymap does not handle it twice. */
  onEscape?: () => void
  /** Element to focus on open; defaults to the first focusable element, or the container if none exists. */
  initialFocus?: HTMLElement | null
  /** Element to restore focus to on close; defaults to the element focused when opened (the trigger). */
  returnFocusTo?: HTMLElement | null
}

/**
 * Enable the focus trap and return a cleanup function:
 * - Remember the current focus (the trigger) on open and move focus into `box`.
 * - Keep Tab and Shift+Tab inside `box` (pull focus back if it escapes).
 * - Pass Esc to `onEscape` (ignore it during IME composition).
 * - On cleanup, restore focus to the trigger if it remains in the document and the user has not moved focus elsewhere.
 * The listener runs on window during capture, so it also works when focus is outside the box.
 */
export function activateFocusTrap(box: HTMLElement, opts: FocusTrapOptions = {}): () => void {
  const opener = (document.activeElement as HTMLElement | null) ?? null
  if (!box.hasAttribute('tabindex')) box.setAttribute('tabindex', '-1')
  const first = opts.initialFocus ?? focusablesIn(box)[0] ?? box
  first.focus()

  const onKey = (e: KeyboardEvent): void => {
    if (e.isComposing || e.keyCode === 229) return
    if (e.key === 'Escape') {
      if (!opts.onEscape) return
      e.preventDefault()
      e.stopPropagation()
      opts.onEscape()
    } else if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const list = focusablesIn(box)
      e.preventDefault()
      if (list.length === 0) {
        box.focus()
        return
      }
      const i = nextTrapIndex(list.length, list.indexOf(document.activeElement as HTMLElement), e.shiftKey)
      list[i]?.focus()
    }
  }
  window.addEventListener('keydown', onKey, true)

  return () => {
    window.removeEventListener('keydown', onKey, true)
    const back = opts.returnFocusTo === undefined ? opener : opts.returnFocusTo
    // Restore focus only when it is still inside the box or has fallen to body (the box was removed); do not steal focus after the user clicks elsewhere.
    const active = document.activeElement
    const lost = !active || active === document.body || box.contains(active)
    if (lost && back && back.isConnected && typeof back.focus === 'function') back.focus()
  }
}
