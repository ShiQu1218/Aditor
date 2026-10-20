/**
 * Editing lock during export: a data-layer flag checked by ProjectProvider's apply/undo/redo/new-project operations,
 * plus interface-layer `inert` (the project track and source timeline get `data-editor-lock` and cannot be clicked or focused).
 */
export const LOCK_SELECTOR = '[data-editor-lock]'

let locked = false
const listeners = new Set<() => void>()

export function isEditorLocked(): boolean {
  return locked
}

export function setEditorLocked(v: boolean): void {
  if (locked === v) return
  locked = v
  for (const l of [...listeners]) l()
}

export function subscribeEditorLock(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

interface InertTarget {
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

export function applyInert(root: { querySelectorAll(sel: string): ArrayLike<InertTarget> }, on: boolean): void {
  const els = Array.from(root.querySelectorAll(LOCK_SELECTOR))
  for (const el of els) {
    if (on) {
      el.setAttribute('inert', '')
      el.setAttribute('aria-disabled', 'true')
    } else {
      el.removeAttribute('inert')
      el.removeAttribute('aria-disabled')
    }
  }
}
