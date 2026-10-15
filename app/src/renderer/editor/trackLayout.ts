import type { ProjectItem } from './project'

/**
 * 專案軌版面純函式（Task 13）：
 * 卡片寬度（6 px/秒、夾在 92–360）、拖曳插入位置（中點判定）、
 * 把手拖曳換算新起訖（最短 1 秒、不超出影片）。
 */

const PX_PER_SEC = 6
const MIN_W = 92
const MAX_W = 360
/** 拖曳調整把手的最短片段長度（秒）；`trimItem` 自身保留 0.1 s 容差。 */
const MIN_LEN = 1

/** 片段卡寬度：6 px/秒，夾在 [92, 360]。 */
export function itemWidth(durationSec: number): number {
  const raw = Math.max(0, durationSec) * PX_PER_SEC
  return Math.max(MIN_W, Math.min(MAX_W, raw))
}

/**
 * 拖曳插入位置：由左而右找第一張中點在指標右側的卡片 → 插到它前面；
 * 都不到時插到最後（回傳 0..len 的插入索引）。
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
 * 拖曳把手：依位移換算拖曳邊的新時間（秒）。
 * 起點夾在 [0, end - 1]、終點夾在 [start + 1, duration]；另一邊不變。
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
 * 把手拖曳的終點上界：只有「開啟的影片」知道長度；其他來源的長度未知 → Infinity
 * （不得用開啟影片的長度去夾別的來源）。
 */
export function trimUpperBound(itemSource: string, openVideo: string, openDuration: number): number {
  return samePath(itemSource, openVideo) && openDuration > 0 ? openDuration : Infinity
}
