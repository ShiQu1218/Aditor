/**
 * Keyboard cursor helpers for virtualized event lists (pure functions; the caller handles DOM scrolling and focus).
 */

export interface CursorScrollParams {
  index: number
  rowHeight: number
  scrollTop: number
  viewHeight: number
  count: number
}

export interface RevealParams {
  /** Target rectangle's top and height in content coordinates. */
  top: number
  height: number
  scrollTop: number
  viewHeight: number
  /** Total content height. */
  contentHeight: number
}

/**
 * Return the scrollTop needed to show the entire target rectangle; return null if already fully visible.
 * Above the viewport: align to the top. Below it: align the bottom to the viewport. Clamp to [0, content height - viewport height].
 * Shared by lists (equal-height rows) and grids (variable-height rows with date headers).
 */
export function revealScrollTarget({ top, height, scrollTop, viewHeight, contentHeight }: RevealParams): number | null {
  const max = Math.max(0, contentHeight - viewHeight)
  const bottom = top + height
  let target: number
  if (top < scrollTop) target = top
  else if (bottom > scrollTop + viewHeight) target = bottom - viewHeight
  else return null
  target = Math.min(max, Math.max(0, target))
  return target === scrollTop ? null : target
}

/** ScrollTop needed to show the cursor row in an equal-height list; null if already fully visible. */
export function cursorScrollTarget({ index, rowHeight, scrollTop, viewHeight, count }: CursorScrollParams): number | null {
  if (count <= 0 || index < 0 || index >= count) return null
  return revealScrollTarget({ top: index * rowHeight, height: rowHeight, scrollTop, viewHeight, contentHeight: count * rowHeight })
}

/** Roving tabindex: use the cursor row if rendered, otherwise the first rendered row, so the list is always reachable by Tab. */
export function rovingTarget(cursorId: string | null, renderedIds: string[]): string | null {
  if (cursorId && renderedIds.includes(cursorId)) return cursorId
  return renderedIds[0] ?? null
}

/** Throttle playhead-follow scrolling: allow when never scrolled (last=0) or at least minMs have elapsed. */
export function autoScrollDue(now: number, last: number, minMs: number): boolean {
  return last === 0 || now - last >= minMs
}
