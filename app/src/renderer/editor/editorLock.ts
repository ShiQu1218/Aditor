/**
 * 編輯鎖定（匯出進行中）：資料層旗標（ProjectProvider 的 apply／undo／redo／新專案會檢查）
 * ＋ 介面層 `inert`（專案軌與來源時間軸標 `data-editor-lock`，不可點擊、不可聚焦）。
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
