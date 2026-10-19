import type { ProjectItem } from './project'

/**
 * Pure project-track layout functions (Task 13):
 * card width (6 px/second, clamped to 92–360), drag insertion position (based on midpoints),
 * and new clip bounds from handle drags (minimum 1 second, within the video duration).
 */

const PX_PER_SEC = 6
const MIN_W = 92
const MAX_W = 360
/** Minimum clip length in seconds for drag handles; `trimItem` itself keeps a 0.1 s tolerance. */
const MIN_LEN = 1

/** Clip card width: 6 px/second, clamped to [92, 360]. */
export function itemWidth(durationSec: number): number {
  const raw = Math.max(0, durationSec) * PX_PER_SEC
  return Math.max(MIN_W, Math.min(MAX_W, raw))
}

/**
 * Find the first card from left to right whose midpoint is to the right of the pointer, then insert before it.
 * If none match, insert at the end (returns an insertion index from 0 to len).
 */
export function dropIndex(xs: number[], widths: number[], pointerX: number): number {
  for (let i = 0; i < xs.length; i++) {
    if (pointerX < xs[i] + widths[i] / 2) return i
  }
  return xs.length
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}

/**
 * Convert handle drag distance into a new time in seconds for the dragged edge.
 * Clamp the start to [0, end - 1] and the end to [start + 1, duration]; leave the other edge unchanged.
 */
export function trimFromDrag(
  item: Pick<ProjectItem, 'start' | 'end'>,
  edge: 'start' | 'end',
  dx: number,
  pxPerSec: number,
  duration: number
): { start: number; end: number } {
  const pps = pxPerSec > 0 ? pxPerSec : 1
  const delta = dx / pps
  if (edge === 'start') {
    const start = clamp(item.start + delta, 0, Math.min(item.end - MIN_LEN, duration))
    return { start: round3(start), end: item.end }
  }
  const end = clamp(item.end + delta, Math.max(item.start + MIN_LEN, 0), duration)
  return { start: item.start, end: round3(end) }
}

function samePath(a: string, b: string): boolean {
  return a.replace(/[\\]/g, '/').toLowerCase() === b.replace(/[\\]/g, '/').toLowerCase()
}

/**
 * Upper bound for a handle drag: only the currently open video has a known duration; use Infinity for other sources.
 * Do not clamp another source to the duration of the open video.
 */
export function trimUpperBound(itemSource: string, openVideo: string, openDuration: number): number {
  return samePath(itemSource, openVideo) && openDuration > 0 ? openDuration : Infinity
}
