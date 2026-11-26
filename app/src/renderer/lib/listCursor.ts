/**
 * Keyboard cursor helpers for virtualized event lists (pure functions; the caller handles DOM scrolling and focus).
 */

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
